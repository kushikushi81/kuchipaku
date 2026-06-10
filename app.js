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
  bgImageCrop:      null,    // 背景画像の切り抜き範囲 {sx,sy,sw,sh}（元画像に対する比率）
  charSize:         1080,
  charX:            50,         // キャラクター横位置（canvas幅に対する%）
  charY:            50,         // キャラクター縦位置（canvas高さに対する%）
  charScale:        100,        // キャラクター描画サイズ（canvas短辺に対する%）
  aspectRatio:      '1:1',      // 録画アスペクト比: '1:1' | '9:16' | '16:9'
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
let micDebugMsg = '未開始';
let lastVol = 0;

// ── 録画状態 ──────────────────────────────────────────────────
const rec = {
  mediaRecorder: null,
  chunks:        [],
  active:        false,
  startTime:     0,
  timerInterval: null,
  mimeType:      '',
  // OPFS（長時間録画）関連
  worker:        null,
  useOPFS:       false,
  opfsFileName:  null,
  opfsChain:     null,
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
let cropPreviewFrame = null; // 切り取り位置調整中に固定表示するフレーム番号（nullで通常アニメーション）

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

// ── キャラクターモード ─────────────────────────────────────────
let charMode = 'sprite'; // 'sprite' | 'frames' | 'auto'
const frameImages     = [null, null, null, null]; // クロップ済み（描画用）
const frameImagesOrig = [null, null, null, null]; // 元画像（再クロップ用）
const frameImageCrops = [null, null, null, null]; // クロップ範囲 {sx,sy,sw,sh}
let autoBaseImg     = null; // クロップ済み（描画用）
let autoBaseOrigImg = null; // 元画像（再クロップ用）
let autoBaseImgCrop = null; // クロップ範囲 {sx,sy,sw,sh}
const autoLM = { mouthY: 70, eyeY: 38, mouthSize: 18 };

function loadImageFromFile(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload  = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('画像読み込み失敗')); };
    img.src = url;
  });
}

// ── 画像クロップ ─────────────────────────────────────────────
function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

// 画像から targetRatio (幅/高さ) に最も近い、中央寄せの最大範囲を返す
function defaultCropRect(imgW, imgH, targetRatio) {
  let bw, bh;
  if (imgW / imgH > targetRatio) { bh = imgH; bw = imgH * targetRatio; }
  else { bw = imgW; bh = imgW / targetRatio; }
  return { sx: (imgW - bw) / 2 / imgW, sy: (imgH - bh) / 2 / imgH, sw: bw / imgW, sh: bh / imgH };
}

// クロップ範囲を切り出して新しいcanvasを返す（長辺はmaxSizeにクランプ）
function applyCropToCanvas(img, rect, maxSize = 1600) {
  const sx = rect.sx * img.width,  sy = rect.sy * img.height;
  const sw = rect.sw * img.width,  sh = rect.sh * img.height;
  const scale = Math.min(1, maxSize / Math.max(sw, sh));
  const oc = document.createElement('canvas');
  oc.width  = Math.max(1, Math.round(sw * scale));
  oc.height = Math.max(1, Math.round(sh * scale));
  oc.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, oc.width, oc.height);
  return oc;
}

function canvasToThumbDataURL(canvas, maxSize = 160) {
  const oc = document.createElement('canvas');
  oc.width = maxSize; oc.height = maxSize;
  oc.getContext('2d').drawImage(canvas, 0, 0, maxSize, maxSize);
  return oc.toDataURL();
}

// クロップモーダルの状態
const cropState = {
  img: null, ratio: 1, scale: 1,
  imgW: 0, imgH: 0,
  baseW: 0, baseH: 0,
  boxW: 0, boxH: 0, x: 0, y: 0,
  onConfirm: null,
};

function updateCropBoxEl() {
  const box = document.getElementById('crop-box');
  box.style.width  = Math.round(cropState.boxW * cropState.scale) + 'px';
  box.style.height = Math.round(cropState.boxH * cropState.scale) + 'px';
  box.style.left   = Math.round(cropState.x    * cropState.scale) + 'px';
  box.style.top    = Math.round(cropState.y    * cropState.scale) + 'px';
}

// img: クロップ対象画像（HTMLImageElement / canvas）
// ratio: 切り抜き枠の縦横比（幅/高さ）
// savedRect: 既存のクロップ範囲（再編集時）。なければ中央最大範囲
// onConfirm: rect {sx,sy,sw,sh} を受け取るコールバック
function openCropModal(img, ratio, savedRect, onConfirm) {
  const displayMax = Math.min(320, window.innerWidth - 64, window.innerHeight - 220);

  cropState.img    = img;
  cropState.ratio  = ratio;
  cropState.imgW   = img.width;
  cropState.imgH   = img.height;
  cropState.scale  = displayMax / Math.max(img.width, img.height);
  cropState.onConfirm = onConfirm;

  const base = defaultCropRect(img.width, img.height, ratio);
  cropState.baseW = base.sw * img.width;
  cropState.baseH = base.sh * img.height;

  const rect = savedRect || base;
  cropState.boxW = rect.sw * img.width;
  cropState.boxH = rect.sh * img.height;
  cropState.x    = rect.sx * img.width;
  cropState.y    = rect.sy * img.height;

  const dispW = Math.round(img.width  * cropState.scale);
  const dispH = Math.round(img.height * cropState.scale);

  const stage = document.getElementById('crop-stage');
  stage.style.width  = dispW + 'px';
  stage.style.height = dispH + 'px';

  const canvas = document.getElementById('crop-canvas');
  canvas.width  = dispW;
  canvas.height = dispH;
  canvas.getContext('2d').drawImage(img, 0, 0, dispW, dispH);

  const zoom = clamp(Math.round(cropState.baseW / cropState.boxW * 100), 100, 400);
  const slZoom = document.getElementById('sl-crop-zoom');
  slZoom.value = zoom;
  document.getElementById('crop-zoom-val').textContent = zoom;

  updateCropBoxEl();
  document.getElementById('crop-modal').style.display = 'flex';
}

function closeCropModal() {
  document.getElementById('crop-modal').style.display = 'none';
  cropState.img = null;
  cropState.onConfirm = null;
}

function setupCropModalUI() {
  const modal  = document.getElementById('crop-modal');
  const box    = document.getElementById('crop-box');
  const slZoom = document.getElementById('sl-crop-zoom');

  slZoom.addEventListener('input', () => {
    const zoom = +slZoom.value;
    document.getElementById('crop-zoom-val').textContent = zoom;
    const cx = cropState.x + cropState.boxW / 2;
    const cy = cropState.y + cropState.boxH / 2;
    cropState.boxW = cropState.baseW * 100 / zoom;
    cropState.boxH = cropState.baseH * 100 / zoom;
    cropState.x = clamp(cx - cropState.boxW / 2, 0, cropState.imgW - cropState.boxW);
    cropState.y = clamp(cy - cropState.boxH / 2, 0, cropState.imgH - cropState.boxH);
    updateCropBoxEl();
  });

  let drag = null;
  box.addEventListener('pointerdown', e => {
    e.preventDefault();
    drag = { startX: e.clientX, startY: e.clientY, origX: cropState.x, origY: cropState.y };
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / cropState.scale;
    const dy = (e.clientY - drag.startY) / cropState.scale;
    cropState.x = clamp(drag.origX + dx, 0, cropState.imgW - cropState.boxW);
    cropState.y = clamp(drag.origY + dy, 0, cropState.imgH - cropState.boxH);
    updateCropBoxEl();
  });
  ['pointerup', 'pointercancel'].forEach(ev => box.addEventListener(ev, () => { drag = null; }));

  document.getElementById('btn-crop-cancel').addEventListener('click', closeCropModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeCropModal(); });

  document.getElementById('btn-crop-confirm').addEventListener('click', () => {
    const rect = {
      sx: cropState.x    / cropState.imgW,
      sy: cropState.y    / cropState.imgH,
      sw: cropState.boxW / cropState.imgW,
      sh: cropState.boxH / cropState.imgH,
    };
    const cb = cropState.onConfirm;
    closeCropModal();
    cb(rect);
  });
}

function buildFramesFromImages(imgs) {
  const maxW = Math.max(...imgs.map(i => i.width));
  const maxH = Math.max(...imgs.map(i => i.height));
  const [tr, tg, tb] = hexToRgb(cfg.chromaColor);
  frames = imgs.map(img => {
    const oc = document.createElement('canvas');
    oc.width  = maxW; oc.height = maxH;
    const c   = oc.getContext('2d');
    c.drawImage(img, 0, 0, maxW, maxH);
    const id  = c.getImageData(0, 0, maxW, maxH);
    removeChromaKey(id.data, tr, tg, tb);
    c.putImageData(id, 0, 0);
    return oc;
  });
  frameW = maxW; frameH = maxH;
}

function sampleColor(img, xRatio, yRatio) {
  const oc = document.createElement('canvas');
  oc.width = 1; oc.height = 1;
  const ctx = oc.getContext('2d');
  ctx.drawImage(img,
    Math.round(img.width * xRatio), Math.round(img.height * yRatio), 1, 1,
    0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${d[0]},${d[1]},${d[2]},${(d[3] / 255).toFixed(2)})`;
}

function generateFrame(baseImg, mouthOpen, eyesClosed) {
  const w = baseImg.width, h = baseImg.height;
  const oc = document.createElement('canvas');
  oc.width = w; oc.height = h;
  const ctx = oc.getContext('2d');
  ctx.drawImage(baseImg, 0, 0);

  const mCY  = h * autoLM.mouthY   / 100;
  const mRx  = w * autoLM.mouthSize / 100;
  const mRy  = mRx * 0.55;
  const eCY  = h * autoLM.eyeY / 100;
  const eSpan = w * 0.17;
  const eLX  = w * 0.34, eRX = w * 0.66;
  const eRy  = h * 0.045;

  if (mouthOpen) {
    ctx.fillStyle = '#1a0800';
    ctx.beginPath();
    ctx.ellipse(w * 0.5, mCY, mRx, mRy, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f5eedf';
    ctx.beginPath();
    ctx.ellipse(w * 0.5, mCY - mRy * 0.15, mRx * 0.72, mRy * 0.5, 0, Math.PI, Math.PI * 2);
    ctx.fill();
  }

  if (eyesClosed) {
    const skin = sampleColor(baseImg, 0.5, 0.18);
    [eLX, eRX].forEach(cx => {
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.ellipse(cx, eCY, eSpan * 0.62, eRy * 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.strokeStyle = '#333';
    ctx.lineWidth   = Math.max(1.5, h * 0.011);
    ctx.lineCap     = 'round';
    [eLX, eRX].forEach(cx => {
      ctx.beginPath();
      ctx.moveTo(cx - eSpan * 0.58, eCY);
      ctx.quadraticCurveTo(cx, eCY + eRy * 2.4, cx + eSpan * 0.58, eCY);
      ctx.stroke();
    });
  }
  return oc;
}

function generateAutoFrames() {
  if (!autoBaseImg) return null;
  return [
    generateFrame(autoBaseImg, true,  false),
    generateFrame(autoBaseImg, true,  true),
    generateFrame(autoBaseImg, false, false),
    generateFrame(autoBaseImg, false, true),
  ];
}

function applyGeneratedFrames(canvases) {
  const [tr, tg, tb] = hexToRgb(cfg.chromaColor);
  frames = canvases.map(src => {
    const oc = document.createElement('canvas');
    oc.width = src.width; oc.height = src.height;
    const c  = oc.getContext('2d');
    c.drawImage(src, 0, 0);
    const id = c.getImageData(0, 0, oc.width, oc.height);
    removeChromaKey(id.data, tr, tg, tb);
    c.putImageData(id, 0, 0);
    return oc;
  });
  frameW = frames[0].width;
  frameH = frames[0].height;
}

function rebuildCurrentMode() {
  if (charMode === 'sprite') {
    buildFrames();
  } else if (charMode === 'frames' && frameImages.every(f => f !== null)) {
    buildFramesFromImages(frameImages);
  } else if (charMode === 'auto' && autoBaseImg) {
    applyGeneratedFrames(generateAutoFrames());
  }
}

function scheduleRebuildCurrent() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuildCurrentMode, 250);
}

function updateAutoPreview() {
  const gen  = generateAutoFrames();
  if (!gen) return;
  const grid = document.getElementById('auto-preview-grid');
  grid.innerHTML = '';
  ['口あき/目あき', '口あき/目とじ', '口とじ/目あき', '口とじ/目とじ'].forEach((lbl, i) => {
    const cell  = document.createElement('div');
    cell.className = 'auto-preview-cell';
    const scaled = document.createElement('canvas');
    scaled.width  = gen[i].width;
    scaled.height = gen[i].height;
    scaled.getContext('2d').drawImage(gen[i], 0, 0);
    cell.appendChild(scaled);
    const label = document.createElement('div');
    label.className   = 'auto-preview-label';
    label.textContent = lbl;
    cell.appendChild(label);
    grid.appendChild(cell);
  });
}

function updateFrameThumb(slot) {
  const thumb = document.getElementById(`frame-thumb-${slot}`);
  thumb.innerHTML = '';
  const imgEl = document.createElement('img');
  imgEl.src = canvasToThumbDataURL(frameImages[slot]);
  thumb.appendChild(imgEl);
  thumb.classList.add('has-img');
  document.querySelector(`.frame-slot-edit-btn[data-frame="${slot}"]`).style.display = '';
}

function switchCharTab(mode) {
  document.querySelectorAll('.char-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === mode);
  });
  document.getElementById('char-tab-sprite').style.display = mode === 'sprite' ? '' : 'none';
  document.getElementById('char-tab-frames').style.display = mode === 'frames' ? '' : 'none';
  document.getElementById('char-tab-auto').style.display   = mode === 'auto'   ? '' : 'none';
  charMode = mode;
}

function setupCharModeUI() {
  let pendingSlot = 0;

  document.querySelectorAll('.char-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchCharTab(tab.dataset.tab);
      localStorage.setItem('kp-charMode', tab.dataset.tab);
    });
  });

  // 4枚バラ
  const fileFrame = document.getElementById('file-frame');
  document.querySelectorAll('.frame-slot-thumb').forEach(thumb => {
    thumb.addEventListener('click', () => {
      pendingSlot = +thumb.dataset.frame;
      fileFrame.click();
    });
  });

  fileFrame.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const img = await loadImageFromFile(file);
      const slot = pendingSlot;
      openCropModal(img, 1, null, async rect => {
        frameImagesOrig[slot] = img;
        frameImageCrops[slot] = rect;
        frameImages[slot]     = applyCropToCanvas(img, rect);
        updateFrameThumb(slot);
        await dbSet(`frameImage${slot}`, file);
        await dbSet(`frameImageCrop${slot}`, rect);
        await dbSet('charMode', 'frames');
        document.getElementById('btn-frames-apply').disabled = !frameImages.every(f => f !== null);
      });
    } catch { alert('画像の読み込みに失敗しました。'); }
    e.target.value = '';
  });

  document.querySelectorAll('.frame-slot-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const slot = +btn.dataset.frame;
      if (!frameImagesOrig[slot]) return;
      openCropModal(frameImagesOrig[slot], 1, frameImageCrops[slot], async rect => {
        frameImageCrops[slot] = rect;
        frameImages[slot]     = applyCropToCanvas(frameImagesOrig[slot], rect);
        updateFrameThumb(slot);
        await dbSet(`frameImageCrop${slot}`, rect);
        if (charMode === 'frames' && frameImages.every(f => f !== null)) {
          buildFramesFromImages(frameImages);
        }
      });
    });
  });

  document.getElementById('btn-frames-apply').addEventListener('click', () => {
    if (!frameImages.every(f => f !== null)) return;
    buildFramesFromImages(frameImages);
  });

  // 1枚から作る
  const fileAuto = document.getElementById('file-auto');
  document.getElementById('btn-auto-img').addEventListener('click', () => fileAuto.click());

  fileAuto.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const img = await loadImageFromFile(file);
      openCropModal(img, 1, null, async rect => {
        autoBaseOrigImg = img;
        autoBaseImgCrop = rect;
        autoBaseImg     = applyCropToCanvas(img, rect);
        document.getElementById('auto-img-name').textContent       = file.name;
        document.getElementById('btn-auto-generate').disabled      = false;
        document.getElementById('auto-landmark-area').style.display = '';
        document.getElementById('auto-preview-grid').style.display  = 'none';
        document.getElementById('btn-auto-apply').style.display     = 'none';
        document.getElementById('btn-auto-crop-edit').style.display = '';
        await dbSet('autoBaseImage', file);
        await dbSet('autoBaseImageCrop', rect);
        await dbSet('charMode', 'auto');
      });
    } catch { alert('画像の読み込みに失敗しました。'); }
    e.target.value = '';
  });

  document.getElementById('btn-auto-crop-edit').addEventListener('click', () => {
    if (!autoBaseOrigImg) return;
    openCropModal(autoBaseOrigImg, 1, autoBaseImgCrop, async rect => {
      autoBaseImgCrop = rect;
      autoBaseImg     = applyCropToCanvas(autoBaseOrigImg, rect);
      await dbSet('autoBaseImageCrop', rect);
      if (document.getElementById('auto-preview-grid').style.display !== 'none') {
        updateAutoPreview();
      } else if (charMode === 'auto') {
        applyGeneratedFrames(generateAutoFrames());
      }
    });
  });

  [
    ['sl-mouth-y',    'n-mouth-y',    'mouthY'],
    ['sl-eye-y',      'n-eye-y',      'eyeY'],
    ['sl-mouth-size', 'n-mouth-size', 'mouthSize'],
  ].forEach(([slId, nId, key]) => {
    const sl = document.getElementById(slId);
    const ni = document.getElementById(nId);
    const apply = v => {
      autoLM[key] = v; sl.value = ni.value = v;
      if (document.getElementById('auto-preview-grid').style.display !== 'none') {
        updateAutoPreview();
      }
    };
    sl.addEventListener('input',  () => apply(+sl.value));
    ni.addEventListener('change', () => apply(+ni.value));
  });

  document.getElementById('btn-auto-generate').addEventListener('click', () => {
    if (!autoBaseImg) return;
    updateAutoPreview();
    document.getElementById('auto-preview-grid').style.display = '';
    document.getElementById('btn-auto-apply').style.display    = '';
  });

  document.getElementById('btn-auto-apply').addEventListener('click', () => {
    const gen = generateAutoFrames();
    if (!gen) return;
    applyGeneratedFrames(gen);
  });
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
  if (cfg.aspectRatio === '9:16') return [base, Math.round(base * 16 / 9)];
  if (cfg.aspectRatio === '16:9') return [Math.round(base * 16 / 9), base];
  return [base, base];
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
  const resEl = document.getElementById('res-current');
  if (resEl) resEl.textContent = `${cv.width} × ${cv.height} px`;
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
  micDebugMsg = '開始中…';
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
    micDebugMsg = `OK (ctx:${audio.ctx.state})`;
  } catch (err) {
    micDebugMsg = `エラー: ${err.name}: ${err.message}`;
    // OBSブラウザソース内ではalert()がフリーズの原因になるため表示しない
    if (!isObsMode) {
      alert('マイクへのアクセスが許可されませんでした。\nブラウザのマイク権限設定を確認してください。');
    }
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

// OPFS（Origin Private File System）+ Web Worker による長時間録画に対応しているか
function opfsAvailable() {
  return typeof Worker !== 'undefined' &&
         typeof navigator.storage?.getDirectory === 'function';
}

// 録画用Workerを起動し、OPFS上に出力ファイルを準備する。失敗時はnull（RAM方式へフォールバック）
function initOPFSWorker(fileName) {
  return new Promise(resolve => {
    let worker;
    try {
      worker = new Worker('rec-worker.js');
    } catch {
      resolve(null);
      return;
    }
    const timeout = setTimeout(() => { worker.terminate(); resolve(null); }, 5000);
    worker.onmessage = e => {
      clearTimeout(timeout);
      worker.onmessage = null;
      if (e.data.type === 'ready') {
        resolve(worker);
      } else {
        worker.terminate();
        resolve(null);
      }
    };
    worker.onerror = () => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(null);
    };
    worker.postMessage({ type: 'init', fileName });
  });
}

// 前回のクラッシュ等で残ったOPFS上の一時録画ファイルを削除する
async function cleanupOPFSTempFiles() {
  if (typeof navigator.storage?.getDirectory !== 'function') return;
  try {
    const dir = await navigator.storage.getDirectory();
    for await (const name of dir.keys()) {
      if (/^kuchipaku-rec-.*\.tmp$/.test(name)) {
        await dir.removeEntry(name).catch(() => {});
      }
    }
  } catch {}
}

async function removeOPFSFile(fileName) {
  if (!fileName) return;
  try {
    const dir = await navigator.storage.getDirectory();
    await dir.removeEntry(fileName);
  } catch {}
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

    rec.chunks       = [];
    rec.worker       = null;
    rec.useOPFS      = false;
    rec.opfsFileName = null;
    rec.opfsChain    = null;

    if (opfsAvailable()) {
      rec.opfsFileName = `kuchipaku-rec-${Date.now()}.tmp`;
      rec.worker  = await initOPFSWorker(rec.opfsFileName);
      rec.useOPFS = !!rec.worker;
    }

    rec.mediaRecorder = new MediaRecorder(
      combinedStream,
      mimeType ? { mimeType } : {}
    );
    rec.mimeType = rec.mediaRecorder.mimeType || mimeType || 'video/mp4';

    rec.mediaRecorder.ondataavailable = e => {
      if (e.data.size === 0) return;
      if (rec.useOPFS) {
        // チャンクの到着順を保ったままOPFSへ書き込む（順序が崩れると動画が壊れる）
        const blob = e.data;
        rec.opfsChain = (rec.opfsChain || Promise.resolve())
          .then(() => blob.arrayBuffer())
          .then(buf => { rec.worker?.postMessage({ type: 'chunk', buffer: buf }, [buf]); });
      } else {
        rec.chunks.push(e.data);
      }
    };
    rec.mediaRecorder.onstop = saveRecording;
    // OPFS方式は1秒ごとにまとめて書き込み、メッセージ送信回数を抑える
    rec.mediaRecorder.start(rec.useOPFS ? 1000 : 100);
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

// OPFSへの書き込みを終了し、完成した録画ファイルをBlobとして取得する
async function finalizeOPFSRecording(mimeType) {
  const worker = rec.worker;
  await (rec.opfsChain || Promise.resolve());

  await new Promise(resolve => {
    worker.addEventListener('message', function handle(e) {
      worker.removeEventListener('message', handle);
      resolve(e.data);
    });
    worker.postMessage({ type: 'finish' });
  });
  worker.terminate();

  try {
    const dir = await navigator.storage.getDirectory();
    const fileHandle = await dir.getFileHandle(rec.opfsFileName);
    const file = await fileHandle.getFile();
    return new Blob([file], { type: mimeType });
  } catch (err) {
    console.error('OPFSファイルの読み込みに失敗:', err);
    return null;
  }
}

async function saveRecording() {
  const mimeType = rec.mimeType || rec.mediaRecorder.mimeType || 'video/mp4';
  const ext      = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  const fileName = `kuchipaku-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${ext}`;

  const opfsFileName = rec.opfsFileName;
  let blob;
  if (rec.useOPFS && rec.worker) {
    blob = await finalizeOPFSRecording(mimeType);
  } else {
    blob = new Blob(rec.chunks, { type: mimeType });
  }
  rec.chunks       = [];
  rec.worker       = null;
  rec.useOPFS      = false;
  rec.opfsFileName = null;
  rec.opfsChain    = null;

  if (!blob) {
    alert('録画データの保存に失敗しました。');
    await removeOPFSFile(opfsFileName);
    return;
  }

  reportRecordedResolution(blob);

  // iOS では Web Share API でネイティブ共有シートを開く（カメラロール保存可）
  if (navigator.canShare) {
    const file = new File([blob], fileName, { type: mimeType });
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'KuchiPaku 録画' });
        await removeOPFSFile(opfsFileName);
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
  await removeOPFSFile(opfsFileName);
}

// 録画ファイルの実際の解像度を確認用に表示する
function reportRecordedResolution(blob) {
  const elPanel = document.getElementById('res-last-rec');
  if (!elPanel) return;
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.onloadedmetadata = () => {
    elPanel.textContent = `前回の録画: ${v.videoWidth} × ${v.videoHeight} px`;
    URL.revokeObjectURL(url);
  };
  v.onerror = () => URL.revokeObjectURL(url);
  v.src = url;
}

function updateRecordBtn(on) {
  const b      = document.getElementById('btn-record');
  const indPnl = document.getElementById('rec-indicator-panel');
  if (b) {
    b.textContent = on ? '■ 録画停止' : '● 録画開始';
    b.className   = 'btn w100 ' + (on ? 'btn-rec-stop' : 'btn-rec-start');
  }
  if (indPnl) indPnl.style.display = on ? 'flex' : 'none';
  if (!on) {
    const elPanel = document.getElementById('rec-time-panel');
    if (elPanel) elPanel.textContent = '00:00';
  }
}

function startRecordTimer() {
  const elPanel = document.getElementById('rec-time-panel');
  rec.timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - rec.startTime) / 1000);
    const t = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    if (elPanel) elPanel.textContent = t;
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
  lastVol = vol;

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
    case 'image':
      if (cfg.bgImage) {
        const r = cfg.bgImageCrop || defaultCropRect(cfg.bgImage.width, cfg.bgImage.height, cv.width / cv.height);
        cx.drawImage(cfg.bgImage,
          r.sx * cfg.bgImage.width, r.sy * cfg.bgImage.height,
          r.sw * cfg.bgImage.width, r.sh * cfg.bgImage.height,
          0, 0, cv.width, cv.height);
      }
      break;
  }
  if (frames.length) {
    // アスペクト比を切り替えても見た目のサイズが変わらないよう、canvasの短辺を基準にする
    const refSize = Math.min(cv.width, cv.height);
    const drawW = Math.round(refSize * cfg.charScale / 100);
    const drawH = drawW;
    const drawX = Math.round(cv.width  * cfg.charX / 100 - drawW / 2);
    const drawY = Math.round(cv.height * cfg.charY / 100 - drawH / 2);
    if (cropPreviewFrame !== null) {
      // 切り取り位置調整中：選択フレームを固定表示し、基準フレームを薄く重ねてガイド表示
      if (cropPreviewFrame !== F.IDLE) {
        cx.globalAlpha = 0.35;
        cx.drawImage(frames[F.IDLE], drawX, drawY, drawW, drawH);
        cx.globalAlpha = 1;
      }
      cx.drawImage(frames[cropPreviewFrame], drawX, drawY, drawW, drawH);
    } else {
      cx.drawImage(frames[pickFrame()], drawX, drawY, drawW, drawH);
    }
  }
  if (isDebugMode) drawDebugOverlay();
}

// OBS等のdevtoolsが使えない環境でマイク状態を直接確認するためのデバッグ表示
function drawDebugOverlay() {
  const lines = [
    `mic.active: ${audio.active}`,
    `ctx.state: ${audio.ctx ? audio.ctx.state : 'null'}`,
    `vol: ${lastVol.toFixed(3)} (sensitivity: ${cfg.sensitivity})`,
    `status: ${micDebugMsg}`,
  ];
  cx.font = '14px monospace';
  const lineH = 18;
  const w = 360;
  cx.fillStyle = 'rgba(0,0,0,0.65)';
  cx.fillRect(4, 4, w, lines.length * lineH + 8);
  cx.fillStyle = '#0f0';
  lines.forEach((line, i) => cx.fillText(line, 10, 4 + lineH * (i + 1)));
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
const isObsMode   = new URLSearchParams(location.search).get('obs')   === '1';
const isDebugMode = new URLSearchParams(location.search).get('debug') === '1';

function broadcastBase() {
  if (cfg.aspectRatio === '9:16') {
    return Math.min(window.innerWidth, Math.floor(window.innerHeight * 9 / 16));
  }
  if (cfg.aspectRatio === '16:9') {
    return Math.min(window.innerHeight, Math.floor(window.innerWidth * 9 / 16));
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

// ── キャラクター位置のマウス操作（ドラッグ移動・ホイール拡縮） ───
function setupCanvasMouse() {
  let dragging = false;
  let lastX = 0, lastY = 0;

  cv.addEventListener('mousedown', e => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = cv.getBoundingClientRect();
    const dx = (e.clientX - lastX) / rect.width  * 100;
    const dy = (e.clientY - lastY) / rect.height * 100;
    cfg.charX = Math.min(100, Math.max(0, cfg.charX + dx));
    cfg.charY = Math.min(100, Math.max(0, cfg.charY + dy));
    lastX = e.clientX;
    lastY = e.clientY;
    setSliderNum('sl-char-x', 'n-char-x', Math.round(cfg.charX));
    setSliderNum('sl-char-y', 'n-char-y', Math.round(cfg.charY));
  });

  window.addEventListener('mouseup', () => { dragging = false; });

  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const scale = Math.min(200, Math.max(10, cfg.charScale - Math.sign(e.deltaY) * 5));
    cfg.charScale = scale;
    setSliderNum('sl-char-scale', 'n-char-scale', scale);
  }, { passive: false });
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
  const sel     = document.getElementById('crop-frame-sel');
  const slX     = document.getElementById('sl-crop-x');
  const nX      = document.getElementById('n-crop-x');
  const slY     = document.getElementById('sl-crop-y');
  const nY      = document.getElementById('n-crop-y');
  const section = sel.closest('.sec');

  function syncUI() {
    const o = cfg.cropOffsets[activeFr];
    slX.value = nX.value = o.x;
    slY.value = nY.value = o.y;
    if (cropPreviewFrame !== null) cropPreviewFrame = activeFr;
  }

  // セクション開閉に合わせて、選択フレームの固定プレビュー表示を切り替える
  section.querySelector('.sec-label').addEventListener('click', () => {
    cropPreviewFrame = section.classList.contains('collapsed') ? null : activeFr;
  });

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
  setupCropModalUI();

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
      // 画面比率が変わると背景画像のクロップ範囲が合わなくなるため、新しい比率に合わせて再設定
      if (cfg.bgImage) {
        cfg.bgImageCrop = defaultCropRect(cfg.bgImage.width, cfg.bgImage.height, cv.width / cv.height);
      }
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
  setupCanvasMouse();

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
    img.onload = () => {
      URL.revokeObjectURL(bgUrl);
      const ratio = cv.width / cv.height;
      openCropModal(img, ratio, null, rect => {
        cfg.bgImage     = img;
        cfg.bgImageCrop = rect;
        document.getElementById('img-name').textContent = file.name;
        document.getElementById('btn-bg-crop-edit').style.display = '';
      });
    };
    img.src = bgUrl;
  });

  document.getElementById('btn-bg-crop-edit').addEventListener('click', () => {
    if (!cfg.bgImage) return;
    const ratio = cv.width / cv.height;
    openCropModal(cfg.bgImage, ratio, cfg.bgImageCrop, rect => {
      cfg.bgImageCrop = rect;
    });
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
    rebuildCurrentMode();
  });

  linkSlider('sl-chroma', 'n-chroma', v => {
    cfg.chromaTolerance = v;
    scheduleRebuildCurrent();
  });

  setupCharModeUI();

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
    // OBSブラウザソースには#btn-micが表示されないため自動でマイクを開始する
    startMic();
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
  cleanupOPFSTempFiles();

  const savedCropOffsets = await dbGet('cropOffsets');
  if (savedCropOffsets) {
    cfg.cropOffsets = savedCropOffsets;
    refreshCropUI();
  }

  const savedMode = await dbGet('charMode') || localStorage.getItem('kp-charMode') || 'sprite';

  if (savedMode === 'frames') {
    try {
      const files = await Promise.all([0, 1, 2, 3].map(i => dbGet(`frameImage${i}`)));
      if (files.every(f => f !== null)) {
        const imgs  = await Promise.all(files.map(f => loadImageFromFile(f)));
        const crops = await Promise.all([0, 1, 2, 3].map(i => dbGet(`frameImageCrop${i}`)));
        imgs.forEach((img, i) => {
          frameImagesOrig[i] = img;
          const rect = crops[i] || defaultCropRect(img.width, img.height, 1);
          frameImageCrops[i] = rect;
          frameImages[i]     = applyCropToCanvas(img, rect);
          updateFrameThumb(i);
        });
        document.getElementById('btn-frames-apply').disabled = false;
        buildFramesFromImages(frameImages);
        switchCharTab('frames');
        requestAnimationFrame(loop);
        return;
      }
    } catch { /* fallthrough to default */ }
  }

  if (savedMode === 'auto') {
    try {
      const file = await dbGet('autoBaseImage');
      if (file) {
        const img  = await loadImageFromFile(file);
        const rect = await dbGet('autoBaseImageCrop') || defaultCropRect(img.width, img.height, 1);
        autoBaseOrigImg = img;
        autoBaseImgCrop = rect;
        autoBaseImg     = applyCropToCanvas(img, rect);
        document.getElementById('auto-img-name').textContent       = file.name;
        document.getElementById('btn-auto-generate').disabled      = false;
        document.getElementById('auto-landmark-area').style.display = '';
        document.getElementById('btn-auto-crop-edit').style.display = '';
        applyGeneratedFrames(generateAutoFrames());
        switchCharTab('auto');
        requestAnimationFrame(loop);
        return;
      }
    } catch { /* fallthrough to default */ }
  }

  // デフォルト: スプライトシートモード
  try {
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
