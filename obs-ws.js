'use strict';

// ── obs-websocket v5 最小クライアント ─────────────────────────
// OBSのミキサーに入っている各音声ソースの音量レベルを InputVolumeMeters
// イベント（約50ms間隔の高頻度イベント）でリアルタイム取得し、
// KuchiPaku側の口パク判定へ渡すための最小クライアント。
//
// 認証はobs-websocket v5のSHA-256チャレンジ方式。crypto.subtle を使うため
// secure context（http://localhost / http://127.0.0.1 / https）で開く必要がある。
// （LANのIP直打ちで開くとパスワード認証が使えないので、その旨をUIに表示する）
//
// パスワードを含む接続設定は同期サーバー(server.py)には一切送らず、
// アプリ本体(app.js)側でこの端末のlocalStorageにのみ保存する。

const OBSWS = (() => {
  // eventSubscriptions のビットフラグ。InputVolumeMeters は高頻度イベントのため
  // 既定の「All」には含まれず、明示的に購読する必要がある（1 << 16）
  const EVENTSUB_INPUT_VOLUME_METERS = 1 << 16;

  let ws          = null;
  let state       = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'error'
  let statusMsg   = '';
  let url         = '';
  let password    = '';
  let levels      = new Map();       // inputName -> magnitude(0..1)
  let inputs      = [];              // [{ inputName }]  （音声ソースのみ）
  let inputsSig   = '';              // 音声ソース一覧の変化検知用シグネチャ
  let handlers    = { onState() {}, onInputs() {} };
  let manualClose = false;
  let reconnectTimer = null;

  function setState(s, msg) {
    state = s;
    statusMsg = msg || '';
    handlers.onState(state, statusMsg);
  }

  // 文字列をSHA-256でハッシュしBase64化する（obs-websocket認証用）
  async function sha256b64(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }

  async function buildAuth(salt, challenge) {
    const secret = await sha256b64(password + salt);
    return await sha256b64(secret + challenge);
  }

  function send(obj) { ws.send(JSON.stringify(obj)); }

  // InputVolumeMeters の inputLevelsMul からマグニチュード（RMS相当, 0..1）を取り出す。
  // 構造: チャンネルごとに [magnitude, peak, inputPeak]（いずれも0..1の乗数）。
  // 全チャンネルのマグニチュードの最大値を返す（無音・ミュート時は0）。
  function magOf(levelsMul) {
    if (!Array.isArray(levelsMul) || !levelsMul.length) return 0;
    let m = 0;
    for (const ch of levelsMul) {
      if (Array.isArray(ch) && ch.length) m = Math.max(m, ch[0]);
    }
    return m;
  }

  async function onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const { op, d } = msg;

    if (op === 0) {
      // Hello: 必要なら認証文字列を作ってIdentifyを返す
      const identify = { rpcVersion: 1, eventSubscriptions: EVENTSUB_INPUT_VOLUME_METERS };
      if (d && d.authentication) {
        if (!window.crypto || !crypto.subtle) {
          setState('error', 'このURLではパスワード認証が使えません（http://localhost で開いてください）');
          try { ws.close(); } catch {}
          return;
        }
        try {
          identify.authentication = await buildAuth(d.authentication.salt, d.authentication.challenge);
        } catch {
          setState('error', '認証情報の生成に失敗しました');
          try { ws.close(); } catch {}
          return;
        }
      }
      send({ op: 1, d: identify });
    } else if (op === 2) {
      // Identified: 接続成立
      setState('connected', '');
    } else if (op === 5) {
      // Event
      handleEvent(d);
    }
    // op === 3(Reidentify) / 7(RequestResponse) は本クライアントでは使用しない
  }

  function handleEvent(d) {
    if (!d || d.eventType !== 'InputVolumeMeters') return;
    const arr = (d.eventData && d.eventData.inputs) || [];
    // OBSは音声を持つ全入力を毎ティック送ってくる（無音でもlevel 0で含まれる）ため、
    // 毎回levelsを作り直せば削除された音声ソースも自然に消える
    const next  = new Map();
    const names = [];
    for (const inp of arr) {
      next.set(inp.inputName, magOf(inp.inputLevelsMul));
      names.push(inp.inputName);
    }
    levels = next;
    const sig = names.join('');
    if (sig !== inputsSig) {
      inputsSig = sig;
      inputs = names.map(n => ({ inputName: n }));
      handlers.onInputs(inputs);
    }
  }

  function connect(connUrl, pw, cbs) {
    disconnect();               // 既存接続を確実に閉じる
    manualClose = false;
    url = connUrl;
    password = pw || '';
    handlers = Object.assign({ onState() {}, onInputs() {} }, cbs || {});
    try {
      setState('connecting', '');
      ws = new WebSocket(url);
    } catch (e) {
      setState('error', 'URLが不正です: ' + e.message);
      return;
    }
    ws.onmessage = onMessage;
    ws.onerror   = () => {
      // onerrorの直後にoncloseが続くので、ここでは状態のみerrorにしておく
      if (state !== 'connected') {
        setState('error', '接続に失敗しました（OBSのWebSocketサーバー有効化とURL/ポートを確認）');
      }
    };
    ws.onclose = () => {
      levels = new Map();
      inputsSig = '';
      ws = null;
      if (manualClose)      { setState('disconnected', ''); return; }
      if (state === 'error') return;   // 認証失敗・接続失敗時は自動再接続しない
      setState('disconnected', '再接続中…');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => { if (!manualClose) connect(url, password, handlers); }, 3000);
    };
  }

  function disconnect() {
    manualClose = true;
    clearTimeout(reconnectTimer);
    if (ws) {
      ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch {}
      ws = null;
    }
    levels = new Map();
    inputsSig = '';
    setState('disconnected', '');
  }

  // 指定した音声ソースの最新マグニチュードを返す。inputName未指定なら全ソースの最大値。
  function getLevel(inputName) {
    if (inputName) return levels.get(inputName) || 0;
    let m = 0;
    for (const v of levels.values()) m = Math.max(m, v);
    return m;
  }

  return {
    connect,
    disconnect,
    getLevel,
    isConnected: () => state === 'connected',
    getState:    () => state,
    getStatusMsg: () => statusMsg,
    getInputs:   () => inputs,
  };
})();

window.OBSWS = OBSWS;
