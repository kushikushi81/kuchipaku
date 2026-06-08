'use strict';

// ── スプライトシート フレーム定義 ─────────────────────────────
// 2×2 グリッド:
//   [0] 左上: 口あき / 目あき  → 話中メイン
//   [1] 右上: 口あき / 目とじ  → 話中まばたき
//   [2] 左下: 口とじ / 目あき  → 無音
//   [3] 右下: 口とじ / 目とじ  → 無音まばたき
const F = { TALK: 0, TALK_BLINK: 1, IDLE: 2, IDLE_BLINK: 3 };

// ── 設定 ──────────────────────────────────────────────────────
const cfg = {
  sensitivity:      0.015,
  holdMs:           150,
  mouthMs:          120,
  bgMode:           'transparent',
  bgColor:          '#222244',
  bgImage:          null,
  charSize:         1080,
  charX:            50,         // キャラクター横位置（canvas幅に対する%）
  charY:            50,         // キャラクター縦位置（canvas高さに対する%）
  charScale:        100,        // キャラクター描画サイズ（canvas幅に対する%）
  aspectRatio:      '1:1',      // 録画アスペクト比: '1:1' | '9:16'
  chromaColor:      '#00ff00',  // 除去するキャラクター背景色
  chromaTolerance:  80,         // 色距離の許容範囲（0–200）
  cropOffsets: [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ],
};

// ── 音声状態 ──────────────────────────────────────────────────
const audio = {
  ctx:      null,
  analyser: null,
  stream:   null,
  active:   false,
};
let audioBuf = null;

// ── 録画状態 ──────────────────────────────────────────────────
const rec = {
  mediaRecorder: null,
  chunks:        [],
  active:        false,
  startTime:     0,
  timerInterval: null,
};

// ── アニメーション状態 ────────────────────────────────────────
const anim = {
  talking:    false,
  holdTimer:  0,
  mouthOpen:  false,
  mouthTimer: 0,
  blinking:   false,
  blinkTimer: 0,
  blinkNext:  randBlink(),
};

function randBlink() { return 3000 + Math.random() * 4000; }

let refreshCropUI = () => {};
let vfillEl = null;

// ── スプライト ────────────────────────────────────────────────
const SPRITE_INSET = 3;  // 各フレーム四辺から除外するピクセル数（境界線除去）

let spriteImg = null;   // オリジナル画像（設定変更時の再処理用）
let frames    = [];
let frameW    = 0, frameH = 0;

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

async function loadSpriteFromUrl(url) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload  = () => res(i);
    i.onerror = () => rej(new Error('画像の読み込みに失敗しました'));
    i.src = url;
  });
  spriteImg = img;
  buildFrames();
}

// クロマキー設定が変わったときに呼び直す（spriteImg は再利用）
function buildFrames() {
  if (!spriteImg) return;
  frameW = (spriteImg.width  / 2) | 0;
  frameH = (spriteImg.height / 2) | 0;
  const [tr, tg, tb] = hexToRgb(cfg.chromaColor);
  frames = [
    [0,      0     ],
    [frameW, 0     ],
    [0,      frameH],
    [frameW, frameH],
  ].map(([sx, sy], i) => {
    const { x: dx, y: dy } = cfg.cropOffsets[i];
    return extractFrame(sx, sy, tr, tg, tb, dx, dy);
  });
}

function extractFrame(sx, sy, tr, tg, tb, dx = 0, dy = 0) {
  const inset = SPRITE_INSET;
  const srcW  = frameW - 2 * inset;
  const srcH  = frameH - 2 * inset;
  const oc = document.createElement('canvas');
  oc.width  = srcW;
  oc.height = srcH;
  const c = oc.getContext('2d');
  c.drawImage(spriteImg, sx + inset + dx, sy + inset + dy, srcW, srcH, 0, 0, srcW, srcH);
  const id = c.getImageData(0, 0, srcW, srcH);
  removeChromaKey(id.data, tr, tg, tb);
  c.putImageData(id, 0, 0);
  return oc;
}

function removeChromaKey(data, tr, tg, tb) {
  const tol  = cfg.chromaTolerance;
  const soft = tol * 1.4;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - tr, dg = data[i+1] - tg, db = data[i+2] - tb;
    const dist = Math.sqrt(dr*dr + dg*dg + db*db);
    if (dist < tol) {
      data[i + 3] = 0;
    } else if (dist < soft) {
      data[i + 3] = Math.round(data[i+3] * (dist - tol) / (soft - tol));
    }
  }
}

function rebuildFrame(i) {
  if (!spriteImg || !frames.length) return;
  const [tr, tg, tb] = hexToRgb(cfg.chromaColor);
  const origins = [[0, 0], [frameW, 0], [0, frameH], [frameW, frameH]];
  const [sx, sy] = origins[i];
  const { x: dx, y: dy } = cfg.cropOffsets[i];
  frames[i] = extractFrame(sx, sy, tr, tg, tb, dx, dy);
}

// 許容範囲スライダー操作中の連続再処理を抑制
let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(buildFrames, 250);
}

let saveCropTimer = null;
function scheduleSaveCropOffsets() {
  clearTimeout(saveCropTimer);
  saveCropTimer = setTimeout(() => dbSet('cropOffsets', cfg.cropOffsets), 500);
}

// ── IndexedDB（画像の永続化） ─────────────────────────────────
let _db = null;

async function openDB() {
  if (_db) return _db;
  return new Promise((res, rej) => {
    const req = indexedDB.open('KuchiPaku', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    req.onsuccess = e => { _db = e.target.result; res(_db); };
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbSet(key, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction('kv', 'readwrite').objectStore('kv').put(value, key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

// ── Canvas ────────────────────────────────────────────────────
let cv, cx;

function initCanvas() {
  cv = document.getElementById('cv');
  cx = cv.getContext('2d');
  resizeCanvas(cfg.charSize);
}

function calcCanvasSize(base) {
  return cfg.aspectRatio === '9:16'
    ? [base, Math.round(base * 16 / 9)]
    : [base, base];
}

function resizeCanvas(base) {
  const [w, h] = calcCanvasSize(base);
  cv.width  = w;
  cv.height = h;
  if (isBroadcast) {
    cv.style.width  = w + 'px';
    cv.style.height = h + 'px';
  } else {
    updateCanvasDisplay();
  }
}

function updateCanvasDisplay() {
  const area   = document.getElementById('canvas-area');
  const vmeter = document.getElementById('vmeter');
  const pad    = window.innerWidth <= 580 ? 32 : 40;
  const vgap   = vmeter ? vmeter.offsetHeight + 12 : 0;
  const maxW   = area.clientWidth  - pad;
  const maxH   = area.clientHeight > 0 ? area.clientHeight - pad - vgap : Infinity;
  if (maxW <= 0) return;
  const scale  = Math.min(1, maxW / cv.width, maxH / cv.height);
  cv.style.width  = Math.round(cv.width  * scale) + 'px';
  cv.style.height = Math.round(cv.height * scale) + 'px';
}

// ── マイク ────────────────────────────────────────────────────
let micReconnectTimer = null;

async function startMic() {
  if (audio.active) return;
  clearTimeout(micReconnectTimer);
  try {
    if (!audio.ctx) {
      audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // iOS が画面収録開始などで AudioSession を割り込むと suspended になる
      audio.ctx.onstatechange = () => {
        if (audio.ctx.state === 'suspended' && audio.active) {
          updateMicBtn('warning');
          audio.ctx.resume().catch(() => {});
        } else if (audio.ctx.state === 'running' && audio.active) {
          updateMicBtn(true);
        }
      };
    }
    if (audio.ctx.state === 'suspended') await audio.ctx.resume();
    audio.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    // iOS 画面収録などでトラックが切断されたときの復旧
    audio.stream.getAudioTracks().forEach(track => {
      track.onended = () => {
        if (!audio.active) return;
        audio.stream = audio.analyser = null;
        audio.active = false;
        updateMicBtn('warning');
        micReconnectTimer = setTimeout(() => startMic(), 1500);
      };
    });

    audio.analyser = audio.ctx.createAnalyser();
    audio.analyser.fftSize = 256;
    audioBuf = new Uint8Array(audio.analyser.fftSize);
    audio.ctx.createMediaStreamSource(audio.stream).connect(audio.analyser);
    audio.active = true;
    updateMicBtn(true);
  } catch (err) {
    alert('マイクへのアクセスが許可されませんでした。\nブラウザのマイク権限設定を確認してください。');
    console.error(err);
  }
}

function stopMic() {
  if (!audio.active) return;
  clearTimeout(micReconnectTimer);
  audio.stream?.getTracks().forEach(t => t.stop());
  audio.stream = audio.analyser = null;
  audioBuf = null;
  audio.active = false;
  updateMicBtn(false);
}

// iOS は AudioContext 再開にユーザー操作（タップ）が必要なため
// 画面収録開始後の割り込みから復帰できるようにタップで再開を試みる
function setupResumeOnInteraction() {
  const tryResume = () => {
    if (audio.ctx && audio.ctx.state === 'suspended') {
      audio.ctx.resume().catch(() => {});
    }
  };
  document.addEventListener('touchend', tryResume, { passive: true });
  document.addEventListener('click',    tryResume);
}

// ── アプリ内録画（canvas.captureStream + getUserMedia → MP4） ──────
function getSupportedMimeType() {
  return ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  if (rec.active) return;

  if (typeof MediaRecorder === 'undefined') {
    alert('お使いのブラウザは録画に対応していません。\niOS 14.3以降のSafariをお使いください。');
    return;
  }

  // マイクが未起動なら自動起動
  if (!audio.active) {
    await startMic();
    if (!audio.active) {
      alert('録画にはマイクが必要です。\nマイクを許可してから再度お試しください。');
      return;
    }
  }

  try {
    const canvasStream    = cv.captureStream(30);
    const combinedStream  = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audio.stream.getAudioTracks(),
    ]);
    const mimeType = getSupportedMimeType();
    rec.mediaRecorder = new MediaRecorder(
      combinedStream,
      mimeType ? { mimeType } : {}
    );
    rec.chunks = [];
    rec.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) rec.chunks.push(e.data); };
    rec.mediaRecorder.onstop = saveRecording;
    rec.mediaRecorder.start(100);
    rec.active    = true;
    rec.startTime = Date.now();
    updateRecordBtn(true);
    startRecordTimer();
  } catch (err) {
    alert('録画を開始できませんでした。\n' + err.message);
    console.error(err);
  }
}

function stopRecording() {
  if (!rec.active || !rec.mediaRecorder) return;
  rec.mediaRecorder.stop();
  rec.active = false;
  stopRecordTimer();
  updateRecordBtn(false);
}

async function saveRecording() {
  const mimeType = rec.mediaRecorder.mimeType || 'video/mp4';
  const ext      = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  const blob     = new Blob(rec.chunks, { type: mimeType });
  const fileName = `kuchipaku-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${ext}`;

  // iOS では Web Share API でネイティブ共有シートを開く（カメラロール保存可）
  if (navigator.canShare) {
    const file = new File([blob], fileName, { type: mimeType });
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'KuchiPaku 録画' });
        return;
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('Share API failed:', e);
    }
  }

  // フォールバック：通常ダウンロード
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function updateRecordBtn(on) {
  const b   = document.getElementById('btn-record');
  const bo  = document.getElementById('btn-record-overlay');
  const ind = document.getElementById('rec-indicator');
  if (b) {
    b.textContent = on ? '■ 録画停止' : '● 録画開始';
    b.className   = 'btn w100 ' + (on ? 'btn-rec-stop' : 'btn-rec-start');
  }
  if (bo) {
    bo.textContent = on ? '■' : '●';
    bo.classList.toggle('active', on);
  }
  if (ind) ind.style.display = on ? 'flex' : 'none';
}

function startRecordTimer() {
  const el = document.getElementById('rec-time');
  rec.timerInterval = setInterval(() => {
    if (!el) return;
    const s = Math.floor((Date.now() - rec.startTime) / 1000);
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

function stopRecordTimer() {
  clearInterval(rec.timerInterval);
  rec.timerInterval = null;
}

function getVolume() {
  if (!audio.analyser || !audioBuf) return 0;
  audio.analyser.getByteTimeDomainData(audioBuf);
  let sum = 0;
  for (const v of audioBuf) { const n = v / 128 - 1; sum += n * n; }
  return Math.sqrt(sum / audioBuf.length);
}

// ── アニメーション更新 ────────────────────────────────────────
function updateAnim(dt) {
  const vol = getVolume();

  if (vol > cfg.sensitivity) {
    anim.talking   = true;
    anim.holdTimer = cfg.holdMs;
  } else {
    anim.holdTimer -= dt;
    if (anim.holdTimer <= 0) anim.talking = false;
  }

  if (anim.talking) {
    anim.mouthTimer += dt;
    if (anim.mouthTimer >= cfg.mouthMs) {
      anim.mouthTimer = 0;
      anim.mouthOpen  = !anim.mouthOpen;
    }
  } else {
    anim.mouthOpen  = false;
    anim.mouthTimer = 0;
  }

  anim.blinkTimer += dt;
  if (!anim.blinking && anim.blinkTimer >= anim.blinkNext) {
    anim.blinking   = true;
    anim.blinkTimer = 0;
  }
  if (anim.blinking && anim.blinkTimer >= 140) {
    anim.blinking   = false;
    anim.blinkTimer = 0;
    anim.blinkNext  = randBlink();
  }

  if (vfillEl) {
    vfillEl.style.width = Math.min(vol / 0.1 * 100, 100) + '%';
    vfillEl.classList.toggle('talking', anim.talking);
  }
}

function pickFrame() {
  if (anim.talking) {
    return anim.mouthOpen
      ? (anim.blinking ? F.TALK_BLINK : F.TALK)
      : (anim.blinking ? F.IDLE_BLINK : F.IDLE);
  }
  return anim.blinking ? F.IDLE_BLINK : F.IDLE;
}

// ── 描画 ──────────────────────────────────────────────────────
function render() {
  cx.clearRect(0, 0, cv.width, cv.height);
  switch (cfg.bgMode) {
    case 'chroma': cx.fillStyle = '#00FF00'; cx.fillRect(0, 0, cv.width, cv.height); break;
    case 'color':  cx.fillStyle = cfg.bgColor; cx.fillRect(0, 0, cv.width, cv.height); break;
    case 'image':  if (cfg.bgImage) cx.drawImage(cfg.bgImage, 0, 0, cv.width, cv.height); break;
  }
  if (frames.length) {
    const drawW = Math.round(cv.width * cfg.charScale / 100);
    const drawH = drawW;
    const drawX = Math.round(cv.width  * cfg.charX / 100 - drawW / 2);
    const drawY = Math.round(cv.height * cfg.charY / 100 - drawH / 2);
    cx.drawImage(frames[pickFrame()], drawX, drawY, drawW, drawH);
  }
}

// ── メインループ ──────────────────────────────────────────────
let lastTs = null;

function loop(ts) {
  const dt = lastTs !== null ? Math.min(ts - lastTs, 100) : 16;
  lastTs = ts;
  updateAnim(dt);
  render();
  requestAnimationFrame(loop);
}

// ── 配信モード ────────────────────────────────────────────────
let isBroadcast = false;

function broadcastBase() {
  if (cfg.aspectRatio === '9:16') {
    return Math.min(window.innerWidth, Math.floor(window.innerHeight * 9 / 16));
  }
  return Math.min(window.innerWidth, window.innerHeight);
}

function setBroadcast(on) {
  isBroadcast = on;
  document.body.classList.toggle('with-ui', !on);
  ['hd', 'panel', 'vmeter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? 'none' : '';
  });
  document.getElementById('btn-exit').style.display = on ? '' : 'none';
  document.getElementById('rec-overlay').style.display = on ? 'flex' : 'none';
  resizeCanvas(on ? broadcastBase() : cfg.charSize);
}

// ── UI ヘルパー ───────────────────────────────────────────────
function updateMicBtn(state) {
  const b = document.getElementById('btn-mic');
  if (!b) return;
  if (state === 'warning') {
    b.textContent = 'マイク再接続中… タップで再開';
    b.className   = 'btn w100 warning';
  } else if (state) {
    b.textContent = 'マイク停止';
    b.className   = 'btn w100 danger';
  } else {
    b.textContent = 'マイク開始';
    b.className   = 'btn w100 secondary';
  }
}

function linkSlider(slId, numId, applyFn) {
  const sl   = document.getElementById(slId);
  const ni   = document.getElementById(numId);
  const step = +sl.step || 1;

  const fromSlider = () => { ni.value = sl.value; applyFn(+sl.value); };
  const fromNum    = () => {
    let v = parseFloat(ni.value);
    if (isNaN(v)) v = +sl.min;
    v = Math.max(+sl.min, Math.min(+sl.max, v));
    v = Math.round(v / step) * step;
    sl.value = ni.value = v;
    applyFn(v);
  };

  sl.addEventListener('input', fromSlider);
  ni.addEventListener('change', fromNum);
  ni.addEventListener('keydown', e => { if (e.key === 'Enter') fromNum(); });
  fromSlider();
}

function setSliderNum(slId, numId, val) {
  document.getElementById(slId).value = val;
  document.getElementById(numId).value = val;
}

// ── プリセット ────────────────────────────────────────────────
function savePreset(slot) {
  localStorage.setItem(`kp-preset-${slot}`, JSON.stringify({
    sensRaw:         Math.round(cfg.sensitivity * 1000),
    holdMs:          cfg.holdMs,
    mouthMs:         cfg.mouthMs,
    charSize:        cfg.charSize,
    charX:           cfg.charX,
    charY:           cfg.charY,
    charScale:       cfg.charScale,
    aspectRatio:     cfg.aspectRatio,
    bgMode:          cfg.bgMode,
    bgColor:         cfg.bgColor,
    chromaColor:     cfg.chromaColor,
    chromaTolerance: cfg.chromaTolerance,
    cropOffsets:     cfg.cropOffsets.map(o => ({ ...o })),
  }));
  updatePresetBadge(slot);
}

function loadPreset(slot) {
  const raw = localStorage.getItem(`kp-preset-${slot}`);
  if (!raw) { alert(`スロット${slot}にはまだプリセットが保存されていません。`); return; }
  const p = JSON.parse(raw);

  setSliderNum('sl-sens',   'n-sens',   p.sensRaw);            cfg.sensitivity     = p.sensRaw / 1000;
  setSliderNum('sl-hold',   'n-hold',   p.holdMs);             cfg.holdMs          = p.holdMs;
  setSliderNum('sl-speed',  'n-speed',  p.mouthMs);            cfg.mouthMs         = p.mouthMs;
  cfg.charSize = [720, 1080].includes(p.charSize) ? p.charSize : 1080;
  const resRadio = document.querySelector(`input[name=resolution][value="${cfg.charSize}"]`);
  if (resRadio) resRadio.checked = true;
  setSliderNum('sl-chroma', 'n-chroma', p.chromaTolerance ?? 80); cfg.chromaTolerance = p.chromaTolerance ?? 80;

  if (p.aspectRatio) {
    cfg.aspectRatio = p.aspectRatio;
    const ar = document.querySelector(`input[name=rec-aspect][value="${p.aspectRatio}"]`);
    if (ar) ar.checked = true;
  }
  if (!isBroadcast) resizeCanvas(cfg.charSize);

  setSliderNum('sl-char-x',     'n-char-x',     p.charX     ?? 50);  cfg.charX     = p.charX     ?? 50;
  setSliderNum('sl-char-y',     'n-char-y',     p.charY     ?? 50);  cfg.charY     = p.charY     ?? 50;
  setSliderNum('sl-char-scale', 'n-char-scale', p.charScale ?? 100); cfg.charScale = p.charScale ?? 100;

  cfg.bgMode  = p.bgMode;
  cfg.bgColor = p.bgColor;
  const r = document.querySelector(`input[name=bg][value="${p.bgMode}"]`);
  if (r) r.checked = true;
  document.getElementById('row-color').classList.toggle('hidden', p.bgMode !== 'color');
  document.getElementById('row-image').classList.toggle('hidden', p.bgMode !== 'image');
  document.getElementById('bg-color').value = p.bgColor;

  if (p.chromaColor) {
    cfg.chromaColor = p.chromaColor;
    document.getElementById('chroma-color').value = p.chromaColor;
  }

  if (p.cropOffsets) {
    cfg.cropOffsets = p.cropOffsets.map(o => ({ ...o }));
    refreshCropUI();
  }

  buildFrames();
}

function updatePresetBadge(slot) {
  const badge = document.getElementById(`preset-badge-${slot}`);
  if (!badge) return;
  const has = !!localStorage.getItem(`kp-preset-${slot}`);
  badge.textContent = has ? '保存済' : '未保存';
  badge.classList.toggle('saved', has);
}

function exportPresets() {
  const data = {
    slot1: localStorage.getItem('kp-preset-1'),
    slot2: localStorage.getItem('kp-preset-2'),
  };
  if (!data.slot1 && !data.slot2) { alert('保存済みのプリセットがありません。'); return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'kuchipaku-presets.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function importPresets(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      let count = 0;
      if (data.slot1) { localStorage.setItem('kp-preset-1', data.slot1); count++; }
      if (data.slot2) { localStorage.setItem('kp-preset-2', data.slot2); count++; }
      [1, 2].forEach(updatePresetBadge);
      count ? alert(`${count}件のプリセットを読み込みました。`) : alert('プリセットデータが見つかりませんでした。');
    } catch {
      alert('ファイルの読み込みに失敗しました。\n正しいプリセットファイルを選択してください。');
    }
  };
  reader.readAsText(file);
}

// ── 切り取り位置調整 UI ────────────────────────────────────────
function setupCropUI() {
  let activeFr = 0;
  const sel = document.getElementById('crop-frame-sel');
  const slX = document.getElementById('sl-crop-x');
  const nX  = document.getElementById('n-crop-x');
  const slY = document.getElementById('sl-crop-y');
  const nY  = document.getElementById('n-crop-y');

  function syncUI() {
    const o = cfg.cropOffsets[activeFr];
    slX.value = nX.value = o.x;
    slY.value = nY.value = o.y;
  }

  function applyX(v) {
    v = Math.max(-200, Math.min(200, Math.round(v)));
    cfg.cropOffsets[activeFr].x = v;
    slX.value = nX.value = v;
    rebuildFrame(activeFr);
    scheduleSaveCropOffsets();
  }

  function applyY(v) {
    v = Math.max(-200, Math.min(200, Math.round(v)));
    cfg.cropOffsets[activeFr].y = v;
    slY.value = nY.value = v;
    rebuildFrame(activeFr);
    scheduleSaveCropOffsets();
  }

  sel.addEventListener('change', () => { activeFr = +sel.value; syncUI(); });

  slX.addEventListener('input',  () => applyX(+slX.value));
  nX.addEventListener('change',  () => applyX(+nX.value));
  nX.addEventListener('keydown', e => { if (e.key === 'Enter') applyX(+nX.value); });

  slY.addEventListener('input',  () => applyY(+slY.value));
  nY.addEventListener('change',  () => applyY(+nY.value));
  nY.addEventListener('keydown', e => { if (e.key === 'Enter') applyY(+nY.value); });

  document.getElementById('crop-x-mm').addEventListener('click', () => applyX(cfg.cropOffsets[activeFr].x - 10));
  document.getElementById('crop-x-m' ).addEventListener('click', () => applyX(cfg.cropOffsets[activeFr].x -  1));
  document.getElementById('crop-x-p' ).addEventListener('click', () => applyX(cfg.cropOffsets[activeFr].x +  1));
  document.getElementById('crop-x-pp').addEventListener('click', () => applyX(cfg.cropOffsets[activeFr].x + 10));
  document.getElementById('crop-y-mm').addEventListener('click', () => applyY(cfg.cropOffsets[activeFr].y - 10));
  document.getElementById('crop-y-m' ).addEventListener('click', () => applyY(cfg.cropOffsets[activeFr].y -  1));
  document.getElementById('crop-y-p' ).addEventListener('click', () => applyY(cfg.cropOffsets[activeFr].y +  1));
  document.getElementById('crop-y-pp').addEventListener('click', () => applyY(cfg.cropOffsets[activeFr].y + 10));

  document.getElementById('btn-crop-reset').addEventListener('click', () => { applyX(0); applyY(0); });

  refreshCropUI = () => { activeFr = 0; sel.value = '0'; syncUI(); };
}

// ── UI 配線 ────────────────────────────────────────────────────
function setupUI() {
  // セクション折りたたみトグル
  document.querySelectorAll('#panel .sec-label').forEach(label => {
    label.addEventListener('click', () => {
      label.closest('.sec').classList.toggle('collapsed');
    });
  });

  setupCropUI();

  // マイク
  document.getElementById('btn-mic').addEventListener('click', () => {
    audio.active ? stopMic() : startMic();
  });

  // スライダー系
  linkSlider('sl-sens',   'n-sens',   v => { cfg.sensitivity = v / 1000; });
  linkSlider('sl-hold',   'n-hold',   v => { cfg.holdMs      = v; });
  linkSlider('sl-speed',  'n-speed',  v => { cfg.mouthMs     = v; });
  document.querySelectorAll('input[name=resolution]').forEach(radio => {
    radio.addEventListener('change', () => {
      cfg.charSize = +radio.value;
      if (!isBroadcast) resizeCanvas(cfg.charSize);
    });
  });

  // アスペクト比
  document.querySelectorAll('input[name=rec-aspect]').forEach(radio => {
    radio.addEventListener('change', () => {
      cfg.aspectRatio = radio.value;
      resizeCanvas(isBroadcast ? broadcastBase() : cfg.charSize);
    });
  });

  // キャラクター配置
  linkSlider('sl-char-x',     'n-char-x',     v => { cfg.charX     = v; });
  linkSlider('sl-char-y',     'n-char-y',     v => { cfg.charY     = v; });
  linkSlider('sl-char-scale', 'n-char-scale', v => { cfg.charScale = v; });
  document.getElementById('btn-char-pos-reset')?.addEventListener('click', () => {
    cfg.charX = 50; cfg.charY = 50; cfg.charScale = 100;
    setSliderNum('sl-char-x',     'n-char-x',     50);
    setSliderNum('sl-char-y',     'n-char-y',     50);
    setSliderNum('sl-char-scale', 'n-char-scale', 100);
  });

  // 背景モード
  document.querySelectorAll('input[name=bg]').forEach(radio => {
    radio.addEventListener('change', () => {
      cfg.bgMode = radio.value;
      document.getElementById('row-color').classList.toggle('hidden', radio.value !== 'color');
      document.getElementById('row-image').classList.toggle('hidden', radio.value !== 'image');
    });
  });
  document.getElementById('bg-color').addEventListener('input', e => { cfg.bgColor = e.target.value; });

  // 背景画像
  document.getElementById('btn-img').addEventListener('click', () => document.getElementById('file-img').click());
  document.getElementById('file-img').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    const bgUrl = URL.createObjectURL(file);
    img.onload = () => { cfg.bgImage = img; URL.revokeObjectURL(bgUrl); };
    img.src = bgUrl;
    document.getElementById('img-name').textContent = file.name;
  });

  // ── キャラクター画像変更 ──────────────────────────────────
  document.getElementById('btn-char-img').addEventListener('click', () => {
    document.getElementById('file-char').click();
  });

  document.getElementById('file-char').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const btn = document.getElementById('btn-char-img');
    btn.textContent = '読み込み中…';
    btn.disabled = true;
    try {
      const charUrl = URL.createObjectURL(file);
      await loadSpriteFromUrl(charUrl);
      URL.revokeObjectURL(charUrl);
      document.getElementById('char-img-name').textContent = file.name;
      await dbSet('charImage', file);
      await dbSet('charImageName', file.name);
    } catch {
      alert('画像の読み込みに失敗しました。\n2×2スプライトシート形式の画像を選択してください。');
    } finally {
      btn.textContent = '画像を変更';
      btn.disabled = false;
    }
  });

  // ── クロマキー色・許容範囲 ───────────────────────────────
  document.getElementById('chroma-color').addEventListener('change', e => {
    cfg.chromaColor = e.target.value;
    buildFrames();
  });

  linkSlider('sl-chroma', 'n-chroma', v => {
    cfg.chromaTolerance = v;
    scheduleRebuild();
  });

  // プリセット
  [1, 2].forEach(slot => {
    document.getElementById(`btn-save-${slot}`).addEventListener('click', () => savePreset(slot));
    document.getElementById(`btn-load-${slot}`).addEventListener('click', () => loadPreset(slot));
    updatePresetBadge(slot);
  });
  document.getElementById('btn-preset-export')?.addEventListener('click', exportPresets);
  document.getElementById('btn-preset-import')?.addEventListener('click', () => {
    document.getElementById('file-preset')?.click();
  });
  document.getElementById('file-preset')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) importPresets(file);
    e.target.value = '';
  });

  // 録画
  document.getElementById('btn-record')?.addEventListener('click', () => {
    rec.active ? stopRecording() : startRecording();
  });
  document.getElementById('btn-record-overlay')?.addEventListener('click', () => {
    rec.active ? stopRecording() : startRecording();
  });

  // 配信モード
  document.getElementById('btn-live').addEventListener('click', () => setBroadcast(true));
  document.getElementById('btn-exit').addEventListener('click', () => setBroadcast(false));

  window.addEventListener('resize', () => {
    if (isBroadcast) resizeCanvas(broadcastBase());
    else updateCanvasDisplay();
  });

  // OBS URLパラメータ
  const params = new URLSearchParams(location.search);
  if (params.get('obs') === '1') {
    const bg = params.get('bg') || 'transparent';
    cfg.bgMode = bg;
    const r = document.querySelector(`input[name=bg][value="${bg}"]`);
    if (r) r.checked = true;
    document.getElementById('row-color').classList.toggle('hidden', bg !== 'color');
    document.getElementById('row-image').classList.toggle('hidden', bg !== 'image');
    setTimeout(() => setBroadcast(true), 0);
  }
}

// ── PWA ──────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').catch(() => {});
}

// ── 起動 ──────────────────────────────────────────────────────
async function boot() {
  initCanvas();
  setupUI();
  vfillEl = document.getElementById('vfill');
  setupResumeOnInteraction();

  const savedCropOffsets = await dbGet('cropOffsets');
  if (savedCropOffsets) {
    cfg.cropOffsets = savedCropOffsets;
    refreshCropUI();
  }

  try {
    // IndexedDB に保存済みの画像があれば復元
    const savedFile = await dbGet('charImage');
    if (savedFile) {
      const savedUrl = URL.createObjectURL(savedFile);
      await loadSpriteFromUrl(savedUrl);
      URL.revokeObjectURL(savedUrl);
      const name = await dbGet('charImageName');
      if (name) document.getElementById('char-img-name').textContent = name;
    } else {
      await loadSpriteFromUrl('character.png');
    }
  } catch {
    // フォールバック: デフォルト画像
    try {
      await loadSpriteFromUrl('character.png');
    } catch {
      alert('character.png の読み込みに失敗しました。\nindex.html と同じフォルダにあるか確認してください。');
      return;
    }
  }

  requestAnimationFrame(loop);
}

document.addEventListener('DOMContentLoaded', boot);
