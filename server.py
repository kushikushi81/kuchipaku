#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""KuchiPaku 同期サーバー

静的ファイル配信（従来の python -m http.server 相当）に加えて、
コントロールページ（通常UI）とOBSブラウザソース（?obs=1&sync=1）の間で
設定・画像・口パク状態を中継する /sync API を提供する。

  POST /sync/config   設定JSON（変更時にデバウンス送信される）
  POST /sync/images   キャラ・背景画像のdataURL群（画像変更時のみ）
  POST /sync/talking  口パク状態 { "talking": bool }（遷移時のみ）
  GET  /sync/state    現在の状態スナップショット（フィーチャーディテクト用）
  GET  /sync/events   SSE。接続直後に現状態を送出し、以後の変更をプッシュ

config / images は sync-state.json に永続化され、サーバー再起動後も
OBS側が最後の状態を表示できる。talking は起動時に常に False。

使い方: python server.py [ポート番号]   （既定 8000）
"""
import contextlib
import json
import os
import queue
import socket
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE_FILE = ROOT / "sync-state.json"
MAX_BODY = 64 * 1024 * 1024  # 画像dataURL込みPOSTの上限（64MB）
SAVE_DEBOUNCE_SEC = 2.0

# 同期状態（メモリ）。talking はサーバー起動時は常に False
STATE = {"config": None, "images": None, "talking": False}
STATE_LOCK = threading.Lock()

# SSE購読者（接続ごとの Queue）
SUBSCRIBERS = []
SUBS_LOCK = threading.Lock()

_save_timer = None
_save_timer_lock = threading.Lock()


def load_state():
    """起動時に sync-state.json から config / images を復元する。"""
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        with STATE_LOCK:
            STATE["config"] = data.get("config")
            STATE["images"] = data.get("images")
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"sync-state.json の読み込みに失敗しました（無視して続行）: {e}")


def save_state():
    """config / images をatomic writeで永続化する（talkingは対象外）。"""
    try:
        with STATE_LOCK:
            data = json.dumps(
                {"config": STATE["config"], "images": STATE["images"]},
                ensure_ascii=False,
            )
        tmp = STATE_FILE.with_name(STATE_FILE.name + ".tmp")
        tmp.write_text(data, encoding="utf-8")
        os.replace(tmp, STATE_FILE)
    except Exception as e:
        print(f"sync-state.json の保存に失敗しました: {e}")


def schedule_save():
    """デバウンス付き保存。連続更新中はタイマーを張り直す。"""
    global _save_timer
    with _save_timer_lock:
        if _save_timer is not None:
            _save_timer.cancel()
        _save_timer = threading.Timer(SAVE_DEBOUNCE_SEC, save_state)
        _save_timer.daemon = True
        _save_timer.start()


def broadcast(name, data):
    """全SSE購読者へイベントを配る。data は改行を含まないJSON文字列。"""
    with SUBS_LOCK:
        subs = list(SUBSCRIBERS)
    for q in subs:
        q.put((name, data))


class SyncHandler(SimpleHTTPRequestHandler):
    # keep-alive前提。SSE以外の自前レスポンスには必ず Content-Length を付けること
    protocol_version = "HTTP/1.1"

    # ── GET ──────────────────────────────────────────────
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/sync/state":
            self._send_state()
        elif path == "/sync/events":
            self._serve_events()
        else:
            super().do_GET()

    def _send_state(self):
        with STATE_LOCK:
            body = json.dumps(STATE, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        q = queue.Queue()
        try:
            self.wfile.write(b"retry: 2000\n\n")
            # スナップショットより先に購読登録し、送出中の更新を取りこぼさない
            # （queue経由で同じ値が二重に届き得るが、適用は冪等なので問題ない）
            with SUBS_LOCK:
                SUBSCRIBERS.append(q)
            with STATE_LOCK:
                snapshot = [
                    ("config", json.dumps(STATE["config"], separators=(",", ":"))),
                    ("images", json.dumps(STATE["images"], separators=(",", ":"))),
                    ("talking", json.dumps({"talking": STATE["talking"]})),
                ]
            for name, data in snapshot:
                self._sse_write(name, data)
            while True:
                try:
                    name, data = q.get(timeout=15)
                    self._sse_write(name, data)
                except queue.Empty:
                    # 死活検知を兼ねたコメント行（切断していればここで例外になる）
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            pass
        finally:
            with SUBS_LOCK:
                if q in SUBSCRIBERS:
                    SUBSCRIBERS.remove(q)

    def _sse_write(self, name, data):
        self.wfile.write(f"event: {name}\ndata: {data}\n\n".encode("utf-8"))
        self.wfile.flush()

    # ── POST ─────────────────────────────────────────────
    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path not in ("/sync/config", "/sync/images", "/sync/talking"):
            self._respond_text(404, "not found")
            return
        length = self.headers.get("Content-Length")
        if length is None:
            self._respond_text(400, "Content-Length required")
            return
        length = int(length)
        if length > MAX_BODY:
            self._respond_text(413, "payload too large")
            return
        try:
            data = json.loads(self.rfile.read(length))
        except Exception:
            self._respond_text(400, "invalid JSON")
            return

        key = path.rsplit("/", 1)[1]
        with STATE_LOCK:
            if key == "talking":
                STATE["talking"] = bool(data.get("talking"))
                payload = json.dumps({"talking": STATE["talking"]})
            else:
                STATE[key] = data
                payload = json.dumps(data, separators=(",", ":"))
        broadcast(key, payload)
        if key != "talking":
            schedule_save()

        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _respond_text(self, status, text):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── ログ ─────────────────────────────────────────────
    def log_message(self, fmt, *args):
        # 口パク状態のPOSTは高頻度なのでログに流さない
        if "/sync/talking" in (self.path or ""):
            return
        super().log_message(fmt, *args)


class DualStackServer(ThreadingHTTPServer):
    """python -m http.server と同じく IPv4/IPv6 の両方で待ち受ける。
    localhost が ::1 に解決される環境（Windows既定）でも繋がるようにするため。"""
    address_family = socket.AF_INET6
    daemon_threads = True  # SSEで塞がったスレッドが終了を妨げないように

    def server_bind(self):
        with contextlib.suppress(Exception):
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        return super().server_bind()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    load_state()
    handler = partial(SyncHandler, directory=str(ROOT))
    # 従来の python -m http.server と同じく全インターフェースで待ち受ける
    # （iPhoneなどLAN内の端末からのアクセスを維持するため）
    server = DualStackServer(("", port), handler)
    print(f"KuchiPaku サーバー起動: http://localhost:{port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
