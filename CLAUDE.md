# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

KuchiPaku — マイク入力の音量でキャラクター画像を口パクさせる、配信・収録向けのWebアプリ（PWA）。フレームワーク・ビルドツール・テストは一切なし。Vanilla JS のみで、`app.js` に全ロジックが入っている。UI・コード内コメント・コミットメッセージはすべて日本語（コミットは `feat:` / `fix:` / `tune:` / `perf:` プレフィックス）。

## 実行方法

- Web版: `start.bat`（`python -m http.server 8000` を起動してブラウザを開く）。ビルド工程はない。ファイルを編集してリロードするだけ。
- URLパラメータ: `?obs=1` でUI非表示の配信モード（マイク自動開始、OBSブラウザソース用）、`?debug=1` で音量デバッグオーバーレイ表示。
- Android版: `kuchipaku_mobileapp/` で `npm run build:android`（= `cap sync android`）、`npm run open:android`（Android Studioを開く）。Capacitor 8。

## アーキテクチャ

### ファイル構成（ルート = Web/PWA版）

- `app.js` — 全ロジック（設定 `cfg`、音声処理、録画、アニメーション、UI組み立て）
- `index.html` / `style.css` — UI
- `rec-worker.js` — 録画チャンクをOPFSへ逐次書き込むWeb Worker（長時間録画でRAMに溜めないため）
- `service-worker.js` — PWAオフライン対応。静的アセット（character.png等）はキャッシュ優先、アプリコードはネットワーク優先
- `portfolio/` — 本アプリとは無関係の別ページ（`.claude/launch.json` の "portfolio" で起動）

### 重要: Android版 `kuchipaku_mobileapp/www/` はルートのコピーではない

`www/` 内の `app.js` / `index.html` / `style.css` はモバイル向けに**意図的に分岐**している（OBS連携セクションなし、録画保存がネイティブ共有シート経由、`<body>` クラス違いなど）。ルート側を修正したら、モバイルにも該当する変更は `www/` へ手動で移植する必要がある。単純な上書きコピーは分岐した差分を壊すので禁止。移植後は `cap sync android` を実行する。

### 口パクの仕組み

1. スプライトは2×2グリッドの4フレーム: 口あき/口とじ × 目あき/目とじ（`F.TALK` / `F.TALK_BLINK` / `F.IDLE` / `F.IDLE_BLINK`）。クロマキー（`cfg.chromaColor` + 許容値）で背景除去。
2. キャラクター入力は3モード（`charMode`）: `sprite`（2×2一枚絵）、`frames`（4枚個別）、`auto`（1枚から口・目を画像加工で自動生成）。
3. マイク → Web Audio の `AnalyserNode` で音量を取り、`cfg.sensitivity` 閾値で talking 判定 → `requestAnimationFrame` ループでフレームを切り替えて canvas に描画。

### 音声まわり（変更時は特に注意）

- マイク音質は2系統（`cfg.micQuality`）: `'voice'`（配信向け・ブラウザのノイズ抑制/AGCあり）と `'high'`（収録向け・無加工）。
- `'high'` はAGCが効かず入力レベルが端末依存で大きくばらつくため、DynamicsCompressor + メイクアップゲインで判定用と録音用を**別々のゲイン**で底上げしている（`MIC_DETECT_MAKEUP_GAIN` / `MIC_RECORD_MAKEUP_GAIN`）。これらの定数は実機での試行錯誤で調整されてきた値（git履歴参照）なので、根拠なく変えない。

### 録画

- canvas ストリーム + マイク音声を `MediaRecorder` で録画。長時間録画時はチャンクを `rec-worker.js` 経由でOPFSに逐次書き込み（`rec.useOPFS`）。
- デスクトップでは File System Access API で保存先を選択、モバイル系では共有/ダウンロードにフォールバック。

### 永続化

- IndexedDB（DB名 `KuchiPaku`、`kv` ストア）にプリセット・画像・切り抜き設定を保存。プリセットはJSONでエクスポート/インポート可能。
