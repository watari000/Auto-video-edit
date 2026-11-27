/**
 * 背景・風景を残したまま人物および対応動物（犬・猫・鳥・馬・牛・羊）だけを切り抜き、
 * 2秒後の一瞬グリッチ（「ザザッ」）の直後に異色アニメカラーへ変化させる純粋ロジックと描画エンジン。
 */

// PASCAL VOC 2012 (MediaPipe DeepLab-v3) のクラスID:
// 3: bird, 8: cat, 10: cow, 12: dog, 13: horse, 15: person, 17: sheep
export const BIZARRE_SUBJECT_CLASSES = new Set([3, 8, 10, 12, 13, 15, 17]);

export const BIZARRE_PALETTES = {
  'purple-lime': {
    label: 'パープル × ライム（異色アニメ定番）',
    shadow: [38, 14, 78],
    mid: [148, 52, 232],
    highlight: [215, 255, 62],
    ink: [18, 8, 36],
  },
  'magenta-cyan': {
    label: 'マゼンタ × シアン（ビビッド衝撃）',
    shadow: [26, 22, 86],
    mid: [236, 42, 148],
    highlight: [72, 245, 255],
    ink: [24, 6, 36],
  },
  'gold-violet': {
    label: 'ゴールド × バイオレット（重厚コントラスト）',
    shadow: [42, 16, 68],
    mid: [182, 92, 46],
    highlight: [255, 224, 82],
    ink: [20, 10, 28],
  },
  'crimson-teal': {
    label: 'クリムゾン × ティール（ダーク緊迫）',
    shadow: [12, 54, 66],
    mid: [210, 38, 72],
    highlight: [255, 198, 134],
    ink: [16, 12, 24],
  },
};

export const BIZARRE_TOUCH_STYLES = ['color-only', 'anime-ink'];

const MEDIAPIPE_BUNDLE_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs';
const MEDIAPIPE_WASM_ROOT =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm';
const DEEPLAB_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite';

const lutCache = new Map();
let segmenterPromise = null;
let cachedSegmenter = null;
let reusableWorkCanvas = null;
let reusableMaskCanvas = null;
let reusableMaskAlphaCanvas = null;
let reusableSubjectCanvas = null;
let reusableGlitchCanvas = null;
let reusableSegInputCanvas = null;

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

/**
 * 経過秒数から「通常 → 一瞬のザザッ（グリッチ） → 異色カラー固定」の状態を返す純粋関数。
 */
export function computeBizarreShiftState(
  localSec,
  triggerSec = 2.0,
  glitchDurationSec = 0.18
) {
  const safeLocal = Math.max(0, Number(localSec) || 0);
  const safeTrigger = Math.max(0.1, Number(triggerSec) || 2.0);
  const safeGlitchDur = Math.max(0.05, Number(glitchDurationSec) || 0.18);

  if (safeLocal < safeTrigger) {
    return {
      phase: 'normal',
      glitchProgress: 0,
      glitchIntensity: 0,
      shiftBlend: 0,
    };
  }

  if (safeLocal < safeTrigger + safeGlitchDur) {
    const glitchProgress = (safeLocal - safeTrigger) / safeGlitchDur;
    return {
      phase: 'glitch',
      glitchProgress,
      glitchIntensity: Math.sin(glitchProgress * Math.PI),
      shiftBlend: glitchProgress >= 0.55 ? 1 : 0,
    };
  }

  return {
    phase: 'shifted',
    glitchProgress: 1,
    glitchIntensity: 0,
    shiftBlend: 1,
  };
}

/**
 * セグメンテーション結果（クラスID配列）から人物・対応動物だけを 255、背景を 0 としたマスクを抽出し、
 * 小孔を消して境界を馴染ませる 3x3 スムージングをかける。
 */
export function extractSubjectMask(categoryData, maskWidth, maskHeight) {
  const width = Math.max(1, Math.round(maskWidth));
  const height = Math.max(1, Math.round(maskHeight));
  const total = width * height;
  const raw = new Uint8Array(total);

  for (let i = 0; i < total; i++) {
    raw[i] = BIZARRE_SUBJECT_CLASSES.has(categoryData[i]) ? 255 : 0;
  }

  const smoothed = new Uint8Array(total);
  let subjectPixelCount = 0;

  for (let y = 0; y < height; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y2 = y + 1 < height ? y + 1 : height - 1;
    for (let x = 0; x < width; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x2 = x + 1 < width ? x + 1 : width - 1;

      const sum =
        raw[y0 * width + x0] +
        raw[y0 * width + x] +
        raw[y0 * width + x2] +
        raw[y * width + x0] +
        raw[y * width + x] +
        raw[y * width + x2] +
        raw[y2 * width + x0] +
        raw[y2 * width + x] +
        raw[y2 * width + x2];

      const avg = Math.round(sum / 9);
      const val = avg < 32 ? 0 : avg > 224 ? 255 : avg;
      smoothed[y * width + x] = val;
      if (val >= 96) {
        subjectPixelCount += 1;
      }
    }
  }

  return {
    mask: smoothed,
    width,
    height,
    subjectPixelCount,
    coverageRatio: total > 0 ? subjectPixelCount / total : 0,
  };
}

/**
 * 輝度 0..255 を選択パレットの 3トーン（シャドウ→中間→ハイライト）へ写像する LUT を生成する。
 */
export function buildBizarreColorLut(paletteKey = 'purple-lime', touchStyle = 'color-only') {
  const safePaletteKey = BIZARRE_PALETTES[paletteKey] ? paletteKey : 'purple-lime';
  const safeTouch = BIZARRE_TOUCH_STYLES.includes(touchStyle) ? touchStyle : 'color-only';
  const cacheKey = `${safePaletteKey}:${safeTouch}`;
  if (lutCache.has(cacheKey)) {
    return lutCache.get(cacheKey);
  }

  const palette = BIZARRE_PALETTES[safePaletteKey];
  const lut = new Uint8Array(256 * 3);

  for (let luma = 0; luma < 256; luma++) {
    let t = luma / 255;
    if (safeTouch === 'anime-ink') {
      // アニメ調では5段階に量子化し、パキッとしたセル画の陰影にする
      t = Math.min(1, Math.floor(t * 5) / 4);
    } else {
      // カラーのみモードはS字カーブでメリハリを強調する
      t = t * t * (3 - 2 * t);
    }

    let r;
    let g;
    let b;
    if (t < 0.5) {
      const k = t * 2;
      r = palette.shadow[0] + (palette.mid[0] - palette.shadow[0]) * k;
      g = palette.shadow[1] + (palette.mid[1] - palette.shadow[1]) * k;
      b = palette.shadow[2] + (palette.mid[2] - palette.shadow[2]) * k;
    } else {
      const k = (t - 0.5) * 2;
      r = palette.mid[0] + (palette.highlight[0] - palette.mid[0]) * k;
      g = palette.mid[1] + (palette.highlight[1] - palette.mid[1]) * k;
      b = palette.mid[2] + (palette.highlight[2] - palette.mid[2]) * k;
    }

    const offset = luma * 3;
    lut[offset] = clampByte(r);
    lut[offset + 1] = clampByte(g);
    lut[offset + 2] = clampByte(b);
  }

  lutCache.set(cacheKey, lut);
  return lut;
}

/**
 * 被写体マスク領域のみを異色アニメカラー＋（任意で）アニメ輪郭線に変換した RGBA 配列を生成する。
 * 背景（maskAlpha < 24）は完全透明（alpha = 0）にして元映像をそのまま残す。
 */
export function stylizeSubjectPixels(
  srcRgba,
  maskAlpha,
  width,
  height,
  paletteKey = 'purple-lime',
  touchStyle = 'color-only'
) {
  const safePaletteKey = BIZARRE_PALETTES[paletteKey] ? paletteKey : 'purple-lime';
  const safeTouch = BIZARRE_TOUCH_STYLES.includes(touchStyle) ? touchStyle : 'color-only';
  const palette = BIZARRE_PALETTES[safePaletteKey];
  const lut = buildBizarreColorLut(safePaletteKey, safeTouch);

  const total = width * height;
  const out = new Uint8ClampedArray(total * 4);
  const useInk = safeTouch === 'anime-ink';
  const originalMix = useInk ? 0.06 : 0.14;
  const paletteMix = 1 - originalMix;

  let lumaMap = null;
  if (useInk) {
    lumaMap = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      const p = i * 4;
      lumaMap[i] = clampByte(0.299 * srcRgba[p] + 0.587 * srcRgba[p + 1] + 0.114 * srcRgba[p + 2]);
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const alpha = maskAlpha[idx];
      const p = idx * 4;

      if (alpha < 24) {
        out[p + 3] = 0;
        continue;
      }

      const sr = srcRgba[p];
      const sg = srcRgba[p + 1];
      const sb = srcRgba[p + 2];
      const luma = lumaMap
        ? lumaMap[idx]
        : clampByte(0.299 * sr + 0.587 * sg + 0.114 * sb);

      const lutOffset = luma * 3;
      let r = lut[lutOffset] * paletteMix + sr * originalMix;
      let g = lut[lutOffset + 1] * paletteMix + sg * originalMix;
      let b = lut[lutOffset + 2] * paletteMix + sb * originalMix;

      if (useInk && x > 0 && x + 1 < width && y > 0 && y + 1 < height) {
        const lumaGrad =
          Math.abs(lumaMap[idx + 1] - lumaMap[idx - 1]) +
          Math.abs(lumaMap[idx + width] - lumaMap[idx - width]);
        const maskGrad =
          Math.abs(maskAlpha[idx + 1] - maskAlpha[idx - 1]) +
          Math.abs(maskAlpha[idx + width] - maskAlpha[idx - width]);

        // 濃い影のディテール線（luma勾配）と被写体外周のアニメ輪郭線（mask勾配）を描画する
        if (maskGrad > 110 || lumaGrad > 64) {
          const inkStrength = maskGrad > 110 ? 0.92 : Math.min(0.85, (lumaGrad - 50) / 85);
          r = r * (1 - inkStrength) + palette.ink[0] * inkStrength;
          g = g * (1 - inkStrength) + palette.ink[1] * inkStrength;
          b = b * (1 - inkStrength) + palette.ink[2] * inkStrength;
        }
      }

      out[p] = clampByte(r);
      out[p + 1] = clampByte(g);
      out[p + 2] = clampByte(b);
      out[p + 3] = alpha;
    }
  }

  return out;
}

/**
 * ギャラリーカード用に「動物・人物風のシルエット」領域だけを切り抜きマスクとして生成する。
 */
export function createSyntheticSubjectMask(width, height) {
  const total = width * height;
  const mask = new Uint8Array(total);
  const cx = width * 0.5;
  const headY = height * 0.37;
  const headR = width * 0.16;
  const bodyTop = height * 0.48;
  const bodyBottom = height * 0.86;
  const bodyHalfW = width * 0.25;
  let subjectPixelCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - headY;
      const inHead = dx * dx + dy * dy <= headR * headR;
      const inLeftEar = Math.hypot(x - (cx - headR * 0.65), y - (headY - headR * 0.85)) <= headR * 0.34;
      const inRightEar = Math.hypot(x - (cx + headR * 0.65), y - (headY - headR * 0.85)) <= headR * 0.34;

      let inBody = false;
      if (y >= bodyTop && y <= bodyBottom) {
        const ny = (y - bodyTop) / (bodyBottom - bodyTop);
        const halfW = bodyHalfW * (0.55 + 0.45 * Math.sin(ny * Math.PI * 0.65));
        inBody = Math.abs(dx) <= halfW;
      }

      if (inHead || inLeftEar || inRightEar || inBody) {
        mask[y * width + x] = 255;
        subjectPixelCount += 1;
      }
    }
  }

  return {
    mask,
    width,
    height,
    subjectPixelCount,
    coverageRatio: total > 0 ? subjectPixelCount / total : 0,
  };
}

/**
 * ブラウザ内 AI（MediaPipe ImageSegmenter / DeepLab-v3）を遅延初期化する。
 * iOS Safari でのマルチクラス順序バグを防ぐため明示的に CPU (WASM SIMD) を指定する。
 */
export async function ensureBizarreSegmenterReady() {
  if (cachedSegmenter) {
    return cachedSegmenter;
  }
  if (segmenterPromise) {
    return segmenterPromise;
  }

  segmenterPromise = (async () => {
    const visionModule = await import(MEDIAPIPE_BUNDLE_URL);
    const { FilesetResolver, ImageSegmenter } = visionModule;
    const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);
    const segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: DEEPLAB_MODEL_URL,
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
    cachedSegmenter = segmenter;
    return segmenter;
  })();

  try {
    return await segmenterPromise;
  } catch (error) {
    segmenterPromise = null;
    throw error;
  }
}

function getReusableCanvas(existing, width, height) {
  const canvas = existing || document.createElement('canvas');
  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }
  return canvas;
}

/**
 * 切り抜き後のフレームを 256px 以下の軽量Canvasに描いて AI セグメンテーションを実行し、被写体マスクを返す。
 */
export async function segmentFrameToSubjectMask(sourceElement, crop, targetWidth, targetHeight) {
  if (!sourceElement || !crop || !targetWidth || !targetHeight) {
    return null;
  }

  const segmenter = await ensureBizarreSegmenterReady();
  const maxEdge = 256;
  const aspect = targetWidth / targetHeight;
  const segW = aspect >= 1 ? maxEdge : Math.max(64, Math.round(maxEdge * aspect));
  const segH = aspect >= 1 ? Math.max(64, Math.round(maxEdge / aspect)) : maxEdge;

  reusableSegInputCanvas = getReusableCanvas(reusableSegInputCanvas, segW, segH);
  const segCtx = reusableSegInputCanvas.getContext('2d', { willReadFrequently: true });
  if (!segCtx) {
    return null;
  }

  segCtx.drawImage(sourceElement, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, segW, segH);
  const result = segmenter.segment(reusableSegInputCanvas);

  try {
    const categoryMask = result?.categoryMask;
    if (!categoryMask) {
      return null;
    }
    const rawClasses = categoryMask.getAsUint8Array();
    return extractSubjectMask(rawClasses, categoryMask.width, categoryMask.height);
  } finally {
    result?.close?.();
  }
}

function drawGlitchBurstOverlay(ctx, width, height, progress, intensity) {
  if (intensity <= 0.02) {
    return;
  }

  reusableGlitchCanvas = getReusableCanvas(reusableGlitchCanvas, width, height);
  const gCtx = reusableGlitchCanvas.getContext('2d');
  if (!gCtx) {
    return;
  }

  gCtx.clearRect(0, 0, width, height);
  gCtx.drawImage(ctx.canvas, 0, 0, width, height);

  ctx.save();
  // 1) 一瞬だけ横スライスに分割して大きく左右へ飛ばす（「ザザッ！」感）
  const sliceCount = 10;
  for (let i = 0; i < sliceCount; i++) {
    const seed = Math.sin((i + 1) * 91.7 + progress * 37.3);
    if (Math.abs(seed) < 0.22) {
      continue;
    }
    const sy = Math.floor((i / sliceCount) * height);
    const sh = Math.max(4, Math.floor((height / sliceCount) * (0.45 + 0.55 * Math.abs(seed))));
    const offsetX = Math.round(seed * width * 0.08 * intensity);
    ctx.drawImage(reusableGlitchCanvas, 0, sy, width, sh, offsetX, sy, width, sh);
  }

  // 2) 色収差（マゼンタ＆シアンの一瞬ズレ）
  const rgbShift = Math.max(3, Math.round(width * 0.016 * intensity));
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.24 * intensity;
  ctx.fillStyle = '#ff2a85';
  ctx.fillRect(0, Math.round(height * (0.18 + progress * 0.4)), width - rgbShift, Math.round(height * 0.04));
  ctx.fillStyle = '#22d3ee';
  ctx.fillRect(rgbShift, Math.round(height * (0.62 - progress * 0.3)), width - rgbShift, Math.round(height * 0.035));

  // 3) 横スキャンノイズ線
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = `rgba(255, 255, 255, ${(0.38 * intensity).toFixed(3)})`;
  for (let s = 0; s < 14; s++) {
    const lineSeed = Math.abs(Math.sin((s + 1) * 43.1 + progress * 53.9));
    const ly = Math.floor(lineSeed * height);
    const lw = Math.floor(width * (0.28 + 0.65 * Math.abs(Math.cos(s * 17.3 + progress * 29))));
    const lx = Math.floor((width - lw) * Math.abs(Math.sin(s * 11.7 + progress * 19)));
    ctx.fillRect(lx, ly, lw, Math.max(2, Math.round(height * 0.004)));
  }

  ctx.restore();
}

/**
 * 1フレーム分の背景維持＋一瞬グリッチ＋被写体のみ異色アニメカラー合成を Canvas へ描画する。
 */
export function drawBizarreShiftComposite(
  ctx,
  sourceElement,
  crop,
  width,
  height,
  localSec,
  options = {}
) {
  const {
    triggerSec = 2.0,
    palette = 'purple-lime',
    touchStyle = 'color-only',
    subjectMask = null,
  } = options;

  // 背景（風景）は一切変更せず元解像度のまま描画する
  ctx.drawImage(sourceElement, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);

  const shiftState = computeBizarreShiftState(localSec, triggerSec);

  if (shiftState.shiftBlend > 0 && subjectMask && subjectMask.coverageRatio > 0.002) {
    const workW = Math.min(width, 360);
    const workH = Math.max(2, Math.round((workW * height) / width));

    reusableWorkCanvas = getReusableCanvas(reusableWorkCanvas, workW, workH);
    const workCtx = reusableWorkCanvas.getContext('2d', { willReadFrequently: true });

    reusableMaskCanvas = getReusableCanvas(
      reusableMaskCanvas,
      subjectMask.width,
      subjectMask.height
    );
    const maskSrcCtx = reusableMaskCanvas.getContext('2d');

    reusableMaskAlphaCanvas = getReusableCanvas(reusableMaskAlphaCanvas, workW, workH);
    const maskScaledCtx = reusableMaskAlphaCanvas.getContext('2d', { willReadFrequently: true });

    reusableSubjectCanvas = getReusableCanvas(reusableSubjectCanvas, workW, workH);
    const subCtx = reusableSubjectCanvas.getContext('2d');

    if (workCtx && maskSrcCtx && maskScaledCtx && subCtx) {
      workCtx.drawImage(sourceElement, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, workW, workH);
      const srcImageData = workCtx.getImageData(0, 0, workW, workH);

      const maskImg = maskSrcCtx.createImageData(subjectMask.width, subjectMask.height);
      const mData = maskImg.data;
      const mArr = subjectMask.mask;
      for (let i = 0; i < mArr.length; i++) {
        const p = i * 4;
        mData[p + 3] = mArr[i];
      }
      maskSrcCtx.putImageData(maskImg, 0, 0);

      maskScaledCtx.clearRect(0, 0, workW, workH);
      maskScaledCtx.imageSmoothingEnabled = true;
      maskScaledCtx.drawImage(reusableMaskCanvas, 0, 0, workW, workH);
      const scaledMaskRgba = maskScaledCtx.getImageData(0, 0, workW, workH).data;
      const maskAlpha = new Uint8Array(workW * workH);
      for (let i = 0; i < maskAlpha.length; i++) {
        maskAlpha[i] = scaledMaskRgba[i * 4 + 3];
      }

      const stylizedRgba = stylizeSubjectPixels(
        srcImageData.data,
        maskAlpha,
        workW,
        workH,
        palette,
        touchStyle
      );
      const outImg = new ImageData(stylizedRgba, workW, workH);
      subCtx.putImageData(outImg, 0, 0);

      ctx.save();
      ctx.globalAlpha = shiftState.shiftBlend;
      ctx.drawImage(reusableSubjectCanvas, 0, 0, width, height);
      ctx.restore();
    }
  }

  if (shiftState.phase === 'glitch') {
    drawGlitchBurstOverlay(ctx, width, height, shiftState.glitchProgress, shiftState.glitchIntensity);
  }
}
