/**
 * 背景・風景を一切変えず、人物の「髪・肌・唇・目・服」および「動物」をパーツ別に切り抜き、
 * 2秒後の一瞬グリッチ（「ザザッ」）の直後にアニメのシーン特色（カット特色）カラーへ変化させるエンジン。
 */

// PASCAL VOC 2012 (DeepLab-v3) の動物クラスID: 3:bird, 8:cat, 10:cow, 12:dog, 13:horse, 17:sheep
export const BIZARRE_ANIMAL_CLASSES = new Set([3, 8, 10, 12, 13, 17]);
// 互換エクスポート（人物15も含む全対象クラス）
export const BIZARRE_SUBJECT_CLASSES = new Set([3, 8, 10, 12, 13, 15, 17]);

// パーツID定義
export const PART_BG = 0;
export const PART_HAIR = 1;
export const PART_SKIN = 2;
export const PART_CLOTHES = 3;
export const PART_LIPS = 4;
export const PART_EYES = 5;
export const PART_ANIMAL = 6;

// パーツごとの3トーン（shadow, base, highlight）を持つアニメ特色パレット
export const BIZARRE_PALETTES = {
  'golden-bizarre': {
    label: '黄金×紫×ミント（王道シーン特色）',
    ink: [18, 8, 34],
    parts: {
      [PART_SKIN]: { shadow: [86, 54, 138], base: [198, 238, 118], highlight: [244, 255, 194] },
      [PART_HAIR]: { shadow: [42, 14, 84], base: [148, 52, 224], highlight: [232, 132, 255] },
      [PART_CLOTHES]: { shadow: [14, 52, 108], base: [42, 152, 224], highlight: [142, 240, 255] },
      [PART_LIPS]: { shadow: [12, 86, 68], base: [34, 212, 148], highlight: [164, 255, 220] },
      [PART_EYES]: { shadow: [28, 16, 46], base: [248, 208, 48], highlight: [255, 255, 245] },
      [PART_ANIMAL]: { shadow: [48, 16, 92], base: [162, 62, 232], highlight: [218, 255, 68] },
    },
  },
  'morioh-pop': {
    label: 'ピンク×シアン×イエロー（ポップ特色）',
    ink: [26, 10, 42],
    parts: {
      [PART_SKIN]: { shadow: [122, 46, 112], base: [255, 164, 206], highlight: [255, 228, 240] },
      [PART_HAIR]: { shadow: [14, 72, 104], base: [38, 214, 236], highlight: [178, 252, 255] },
      [PART_CLOTHES]: { shadow: [66, 98, 16], base: [178, 238, 48], highlight: [236, 255, 158] },
      [PART_LIPS]: { shadow: [164, 92, 12], base: [255, 214, 38], highlight: [255, 248, 168] },
      [PART_EYES]: { shadow: [34, 12, 58], base: [246, 48, 158], highlight: [255, 252, 255] },
      [PART_ANIMAL]: { shadow: [36, 20, 94], base: [236, 46, 156], highlight: [86, 246, 255] },
    },
  },
  'crimson-requiem': {
    label: '紅×アイスブルー×金（緊迫バトル特色）',
    ink: [16, 12, 32],
    parts: {
      [PART_SKIN]: { shadow: [36, 52, 118], base: [144, 198, 255], highlight: [224, 244, 255] },
      [PART_HAIR]: { shadow: [96, 12, 28], base: [222, 38, 68], highlight: [255, 126, 112] },
      [PART_CLOTHES]: { shadow: [44, 16, 82], base: [138, 52, 196], highlight: [236, 154, 255] },
      [PART_LIPS]: { shadow: [112, 68, 12], base: [246, 192, 52], highlight: [255, 244, 168] },
      [PART_EYES]: { shadow: [20, 26, 24], base: [148, 255, 62], highlight: [255, 255, 248] },
      [PART_ANIMAL]: { shadow: [16, 58, 72], base: [216, 42, 76], highlight: [255, 204, 138] },
    },
  },
  'emerald-stand': {
    label: 'エメラルド×オレンジ×紫（異空間特色）',
    ink: [18, 22, 28],
    parts: {
      [PART_SKIN]: { shadow: [118, 44, 62], base: [255, 158, 102], highlight: [255, 222, 178] },
      [PART_HAIR]: { shadow: [10, 68, 54], base: [28, 208, 152], highlight: [148, 255, 214] },
      [PART_CLOTHES]: { shadow: [52, 18, 92], base: [188, 56, 214], highlight: [248, 158, 255] },
      [PART_LIPS]: { shadow: [58, 12, 92], base: [152, 42, 232], highlight: [228, 152, 255] },
      [PART_EYES]: { shadow: [14, 34, 72], base: [56, 212, 255], highlight: [255, 255, 250] },
      [PART_ANIMAL]: { shadow: [42, 16, 72], base: [188, 96, 48], highlight: [255, 226, 86] },
    },
  },
};

export const BIZARRE_TOUCH_STYLES = ['color-only', 'anime-ink'];

const MEDIAPIPE_BUNDLE_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs';
const MEDIAPIPE_WASM_ROOT =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm';
const SELFIE_MULTICLASS_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
const DEEPLAB_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite';
const FACE_LANDMARKER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// MediaPipe 478点 FaceMesh の外唇・左右目ポリゴンインデックス
const OUTER_LIPS_INDICES = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
];
const LEFT_EYE_INDICES = [
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
];
const RIGHT_EYE_INDICES = [
  362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398,
];

const lutCache = new Map();
let aiEnginesPromise = null;
let cachedAiEngines = null;
let reusableWorkCanvas = null;
let reusablePartCanvas = null;
let reusablePartScaledCanvas = null;
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

function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function paintNormalizedPolygon(partMap, width, height, landmarks, indices, partId) {
  if (!Array.isArray(landmarks) || landmarks.length < 400) {
    return;
  }
  const poly = [];
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  for (const idx of indices) {
    const pt = landmarks[idx];
    if (!pt) {
      continue;
    }
    const x = pt.x * width;
    const y = pt.y * height;
    poly.push({ x, y });
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  if (poly.length < 3) {
    return;
  }

  const x0 = Math.max(0, Math.floor(minX) - 1);
  const y0 = Math.max(0, Math.floor(minY) - 1);
  const x1 = Math.min(width - 1, Math.ceil(maxX) + 1);
  const y1 = Math.min(height - 1, Math.ceil(maxY) + 1);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, poly)) {
        partMap[y * width + x] = partId;
      }
    }
  }
}

/**
 * 人物パーツ（selfie_multiclass）・顔パーツ（唇/目）・動物（deeplab_v3）を統合し、
 * ピクセル単位のパーツIDマップ（0=背景, 1=髪, 2=肌, 3=服, 4=唇, 5=目, 6=動物）を生成する。
 */
export function buildSubjectPartMask({
  width,
  height,
  selfieClasses = null,
  selfieWidth = width,
  selfieHeight = height,
  deeplabClasses = null,
  deeplabWidth = width,
  deeplabHeight = height,
  faceLandmarksList = null,
}) {
  const safeW = Math.max(1, Math.round(width));
  const safeH = Math.max(1, Math.round(height));
  const total = safeW * safeH;
  const partMap = new Uint8Array(total);
  let subjectPixelCount = 0;

  // 1) selfie_multiclass: 1=hair, 2=body-skin, 3=face-skin, 4=clothes, 5=others
  if (selfieClasses && selfieClasses.length > 0) {
    for (let y = 0; y < safeH; y++) {
      const sy = Math.min(selfieHeight - 1, Math.floor((y * selfieHeight) / safeH));
      for (let x = 0; x < safeW; x++) {
        const sx = Math.min(selfieWidth - 1, Math.floor((x * selfieWidth) / safeW));
        const cls = selfieClasses[sy * selfieWidth + sx];
        let part = PART_BG;
        if (cls === 1) part = PART_HAIR;
        else if (cls === 2 || cls === 3) part = PART_SKIN;
        else if (cls === 4 || cls === 5) part = PART_CLOTHES;
        partMap[y * safeW + x] = part;
      }
    }
  }

  // 2) deeplab_v3: 背景箇所に動物クラス（犬/猫/鳥/馬/牛/羊）を重ねる。人物未検出時は person(15) も補完
  if (deeplabClasses && deeplabClasses.length > 0) {
    const hasSelfiePerson = partMap.some((p) => p !== PART_BG);
    for (let y = 0; y < safeH; y++) {
      const dy = Math.min(deeplabHeight - 1, Math.floor((y * deeplabHeight) / safeH));
      for (let x = 0; x < safeW; x++) {
        const idx = y * safeW + x;
        if (partMap[idx] !== PART_BG) {
          continue;
        }
        const dx = Math.min(deeplabWidth - 1, Math.floor((x * deeplabWidth) / safeW));
        const cls = deeplabClasses[dy * deeplabWidth + dx];
        if (BIZARRE_ANIMAL_CLASSES.has(cls)) {
          partMap[idx] = PART_ANIMAL;
        } else if (!hasSelfiePerson && cls === 15) {
          partMap[idx] = PART_SKIN;
        }
      }
    }
  }

  // 3) FaceLandmarker: 唇（PART_LIPS）と目（PART_EYES）をピンポイントで割り当て
  if (Array.isArray(faceLandmarksList)) {
    for (const landmarks of faceLandmarksList) {
      paintNormalizedPolygon(partMap, safeW, safeH, landmarks, OUTER_LIPS_INDICES, PART_LIPS);
      paintNormalizedPolygon(partMap, safeW, safeH, landmarks, LEFT_EYE_INDICES, PART_EYES);
      paintNormalizedPolygon(partMap, safeW, safeH, landmarks, RIGHT_EYE_INDICES, PART_EYES);
    }
  }

  for (let i = 0; i < total; i++) {
    if (partMap[i] !== PART_BG) {
      subjectPixelCount += 1;
    }
  }

  return {
    partMap,
    width: safeW,
    height: safeH,
    subjectPixelCount,
    coverageRatio: total > 0 ? subjectPixelCount / total : 0,
  };
}

/**
 * 単一クラス配列（DeepLab等）から動物/人物マスクを抽出する互換ヘルパー（既存テスト・フォールバック用）。
 */
export function extractSubjectMask(categoryData, maskWidth, maskHeight) {
  const width = Math.max(1, Math.round(maskWidth));
  const height = Math.max(1, Math.round(maskHeight));
  const total = width * height;
  const partMap = new Uint8Array(total);
  let subjectPixelCount = 0;

  for (let i = 0; i < total; i++) {
    const cls = categoryData[i];
    if (BIZARRE_ANIMAL_CLASSES.has(cls)) {
      partMap[i] = PART_ANIMAL;
      subjectPixelCount += 1;
    } else if (cls === 15) {
      partMap[i] = PART_SKIN;
      subjectPixelCount += 1;
    }
  }

  return {
    mask: partMap,
    partMap,
    width,
    height,
    subjectPixelCount,
    coverageRatio: total > 0 ? subjectPixelCount / total : 0,
  };
}

/**
 * パレット・パーツ・タッチごとの輝度→RGBルックアップテーブル（256x3）を生成する。
 */
export function buildBizarrePartLut(
  paletteKey = 'golden-bizarre',
  partId = PART_SKIN,
  touchStyle = 'color-only'
) {
  const safePaletteKey = BIZARRE_PALETTES[paletteKey] ? paletteKey : 'golden-bizarre';
  const safeTouch = BIZARRE_TOUCH_STYLES.includes(touchStyle) ? touchStyle : 'color-only';
  const cacheKey = `${safePaletteKey}:${partId}:${safeTouch}`;
  if (lutCache.has(cacheKey)) {
    return lutCache.get(cacheKey);
  }

  const palette = BIZARRE_PALETTES[safePaletteKey];
  const stops = palette.parts[partId] || palette.parts[PART_ANIMAL];
  const lut = new Uint8Array(256 * 3);

  for (let luma = 0; luma < 256; luma++) {
    let t = luma / 255;
    if (safeTouch === 'anime-ink') {
      // セルアニメ調の3〜4段階ステップ（影・中間・ハイライトがパキッと分かれる）
      t = t < 0.28 ? 0.08 : t < 0.68 ? 0.52 : 0.94;
    } else {
      t = t * t * (3 - 2 * t);
    }

    let r;
    let g;
    let b;
    if (t < 0.5) {
      const k = t * 2;
      r = stops.shadow[0] + (stops.base[0] - stops.shadow[0]) * k;
      g = stops.shadow[1] + (stops.base[1] - stops.shadow[1]) * k;
      b = stops.shadow[2] + (stops.base[2] - stops.shadow[2]) * k;
    } else {
      const k = (t - 0.5) * 2;
      r = stops.base[0] + (stops.highlight[0] - stops.base[0]) * k;
      g = stops.base[1] + (stops.highlight[1] - stops.base[1]) * k;
      b = stops.base[2] + (stops.highlight[2] - stops.base[2]) * k;
    }

    const offset = luma * 3;
    lut[offset] = clampByte(r);
    lut[offset + 1] = clampByte(g);
    lut[offset + 2] = clampByte(b);
  }

  lutCache.set(cacheKey, lut);
  return lut;
}

export function buildBizarreColorLut(paletteKey = 'golden-bizarre', touchStyle = 'color-only') {
  return buildBizarrePartLut(paletteKey, PART_ANIMAL, touchStyle);
}

/**
 * パーツIDマップに基づき、被写体の各パーツ（髪・肌・服・唇・目・動物）を別々の異色カラーで着色する。
 * 背景（partId === 0）は alpha = 0 のまま元映像を残す。
 */
export function stylizeSubjectPartPixels(
  srcRgba,
  partMap,
  width,
  height,
  paletteKey = 'golden-bizarre',
  touchStyle = 'color-only'
) {
  const safePaletteKey = BIZARRE_PALETTES[paletteKey] ? paletteKey : 'golden-bizarre';
  const safeTouch = BIZARRE_TOUCH_STYLES.includes(touchStyle) ? touchStyle : 'color-only';
  const palette = BIZARRE_PALETTES[safePaletteKey];
  const useInk = safeTouch === 'anime-ink';

  const luts = {
    [PART_HAIR]: buildBizarrePartLut(safePaletteKey, PART_HAIR, safeTouch),
    [PART_SKIN]: buildBizarrePartLut(safePaletteKey, PART_SKIN, safeTouch),
    [PART_CLOTHES]: buildBizarrePartLut(safePaletteKey, PART_CLOTHES, safeTouch),
    [PART_LIPS]: buildBizarrePartLut(safePaletteKey, PART_LIPS, safeTouch),
    [PART_EYES]: buildBizarrePartLut(safePaletteKey, PART_EYES, safeTouch),
    [PART_ANIMAL]: buildBizarrePartLut(safePaletteKey, PART_ANIMAL, safeTouch),
  };

  const total = width * height;
  const out = new Uint8ClampedArray(total * 4);
  const originalMix = useInk ? 0.04 : 0.1;
  const paletteMix = 1 - originalMix;

  const lumaMap = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const p = i * 4;
    lumaMap[i] = clampByte(0.299 * srcRgba[p] + 0.587 * srcRgba[p + 1] + 0.114 * srcRgba[p + 2]);
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const part = partMap[idx];
      const p = idx * 4;

      if (!part) {
        out[p + 3] = 0;
        continue;
      }

      const luma = lumaMap[idx];
      const lut = luts[part] || luts[PART_ANIMAL];
      const lutOffset = luma * 3;
      let r = lut[lutOffset] * paletteMix + srcRgba[p] * originalMix;
      let g = lut[lutOffset + 1] * paletteMix + srcRgba[p + 1] * originalMix;
      let b = lut[lutOffset + 2] * paletteMix + srcRgba[p + 2] * originalMix;

      if (useInk && x > 0 && x + 1 < width && y > 0 && y + 1 < height) {
        // パーツ境界（髪と肌の境目・唇・目の輪郭・外周）と濃い影のエッジにアニメ輪郭線を入れる
        const isPartBoundary =
          partMap[idx - 1] !== part ||
          partMap[idx + 1] !== part ||
          partMap[idx - width] !== part ||
          partMap[idx + width] !== part;

        const lumaGrad =
          Math.abs(lumaMap[idx + 1] - lumaMap[idx - 1]) +
          Math.abs(lumaMap[idx + width] - lumaMap[idx - width]);

        if (isPartBoundary || lumaGrad > 60) {
          const inkStrength = isPartBoundary ? 0.88 : Math.min(0.84, (lumaGrad - 48) / 80);
          r = r * (1 - inkStrength) + palette.ink[0] * inkStrength;
          g = g * (1 - inkStrength) + palette.ink[1] * inkStrength;
          b = b * (1 - inkStrength) + palette.ink[2] * inkStrength;
        }
      }

      out[p] = clampByte(r);
      out[p + 1] = clampByte(g);
      out[p + 2] = clampByte(b);
      out[p + 3] = 255;
    }
  }

  return out;
}

export function stylizeSubjectPixels(
  srcRgba,
  maskOrPartMap,
  width,
  height,
  paletteKey = 'golden-bizarre',
  touchStyle = 'color-only'
) {
  return stylizeSubjectPartPixels(srcRgba, maskOrPartMap, width, height, paletteKey, touchStyle);
}

/**
 * ギャラリーカード用に「髪・肌・目・唇・服」が別パーツに分かれたサンプルシルエットを生成する。
 */
export function createSyntheticSubjectMask(width, height) {
  const total = width * height;
  const partMap = new Uint8Array(total);
  const cx = width * 0.5;
  const headY = height * 0.36;
  const headR = width * 0.16;
  const bodyTop = height * 0.5;
  const bodyBottom = height * 0.88;
  const bodyHalfW = width * 0.25;
  let subjectPixelCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - headY;
      const dist = Math.hypot(dx, dy);
      let part = PART_BG;

      // 髪（上半分・サイドのシルエット）
      if (dist <= headR * 1.16 && dy < headR * 0.12) {
        part = PART_HAIR;
      }
      // 顔の肌
      if (dist <= headR * 0.94 && dy > -headR * 0.35) {
        part = PART_SKIN;
      }
      // 左右の目
      const eyeY = headY - headR * 0.08;
      const eyeOffsetX = headR * 0.36;
      if (
        Math.hypot((x - (cx - eyeOffsetX)) / (headR * 0.18), (y - eyeY) / (headR * 0.1)) <= 1 ||
        Math.hypot((x - (cx + eyeOffsetX)) / (headR * 0.18), (y - eyeY) / (headR * 0.1)) <= 1
      ) {
        part = PART_EYES;
      }
      // 唇
      const lipY = headY + headR * 0.45;
      if (Math.hypot((x - cx) / (headR * 0.24), (y - lipY) / (headR * 0.1)) <= 1) {
        part = PART_LIPS;
      }
      // 首と服
      if (y >= bodyTop && y <= bodyBottom) {
        const ny = (y - bodyTop) / (bodyBottom - bodyTop);
        const halfW = bodyHalfW * (0.55 + 0.45 * Math.sin(ny * Math.PI * 0.65));
        if (Math.abs(dx) <= halfW) {
          part = y < bodyTop + height * 0.05 && Math.abs(dx) < headR * 0.45 ? PART_SKIN : PART_CLOTHES;
        }
      }

      if (part !== PART_BG) {
        partMap[y * width + x] = part;
        subjectPixelCount += 1;
      }
    }
  }

  return {
    partMap,
    mask: partMap,
    width,
    height,
    subjectPixelCount,
    coverageRatio: total > 0 ? subjectPixelCount / total : 0,
  };
}

/**
 * ブラウザ内 AI 3種（人物パーツ分割 / 顔パーツ唇・目 / 動物切り抜き）を遅延初期化する。
 * iOS Safari でのマルチクラス順序バグを防ぐため明示的に CPU (WASM SIMD) を指定する。
 */
export async function ensureBizarreSegmenterReady() {
  if (cachedAiEngines) {
    return cachedAiEngines;
  }
  if (aiEnginesPromise) {
    return aiEnginesPromise;
  }

  aiEnginesPromise = (async () => {
    const visionModule = await import(MEDIAPIPE_BUNDLE_URL);
    const { FilesetResolver, ImageSegmenter, FaceLandmarker } = visionModule;
    const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);

    const [selfieRes, faceRes, deeplabRes] = await Promise.allSettled([
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: SELFIE_MULTICLASS_MODEL_URL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      }),
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_LANDMARKER_MODEL_URL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 3,
      }),
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: DEEPLAB_MODEL_URL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      }),
    ]);

    const engines = {
      selfieSegmenter: selfieRes.status === 'fulfilled' ? selfieRes.value : null,
      faceLandmarker: faceRes.status === 'fulfilled' ? faceRes.value : null,
      deeplabSegmenter: deeplabRes.status === 'fulfilled' ? deeplabRes.value : null,
    };

    if (!engines.selfieSegmenter && !engines.deeplabSegmenter) {
      throw new Error('AI切り抜きモデルの読み込みに失敗しました。通信状況を確認してください。');
    }

    cachedAiEngines = engines;
    return engines;
  })();

  try {
    return await aiEnginesPromise;
  } catch (error) {
    aiEnginesPromise = null;
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
 * フレームを軽量Canvasへ描画し、髪・肌・服・唇・目・動物のパーツ別マスクを生成する。
 */
export async function segmentFrameToSubjectMask(sourceElement, crop, targetWidth, targetHeight) {
  if (!sourceElement || !crop || !targetWidth || !targetHeight) {
    return null;
  }

  const { selfieSegmenter, faceLandmarker, deeplabSegmenter } =
    await ensureBizarreSegmenterReady();

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

  let selfieClasses = null;
  let selfieWidth = segW;
  let selfieHeight = segH;
  let selfieResult = null;

  let deeplabClasses = null;
  let deeplabWidth = segW;
  let deeplabHeight = segH;
  let deeplabResult = null;

  let faceLandmarksList = null;

  try {
    if (selfieSegmenter) {
      selfieResult = selfieSegmenter.segment(reusableSegInputCanvas);
      if (selfieResult?.categoryMask) {
        selfieWidth = selfieResult.categoryMask.width;
        selfieHeight = selfieResult.categoryMask.height;
        selfieClasses = new Uint8Array(selfieResult.categoryMask.getAsUint8Array());
      }
    }

    if (faceLandmarker) {
      const faceOut = faceLandmarker.detect(reusableSegInputCanvas);
      faceLandmarksList = faceOut?.faceLandmarks || null;
    }

    // 人物パーツが十分にある場合でも動物が一緒に映っている可能性があるため補助で判定
    if (deeplabSegmenter) {
      deeplabResult = deeplabSegmenter.segment(reusableSegInputCanvas);
      if (deeplabResult?.categoryMask) {
        deeplabWidth = deeplabResult.categoryMask.width;
        deeplabHeight = deeplabResult.categoryMask.height;
        deeplabClasses = new Uint8Array(deeplabResult.categoryMask.getAsUint8Array());
      }
    }

    return buildSubjectPartMask({
      width: segW,
      height: segH,
      selfieClasses,
      selfieWidth,
      selfieHeight,
      deeplabClasses,
      deeplabWidth,
      deeplabHeight,
      faceLandmarksList,
    });
  } finally {
    selfieResult?.close?.();
    deeplabResult?.close?.();
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

  const rgbShift = Math.max(3, Math.round(width * 0.016 * intensity));
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.24 * intensity;
  ctx.fillStyle = '#ff2a85';
  ctx.fillRect(0, Math.round(height * (0.18 + progress * 0.4)), width - rgbShift, Math.round(height * 0.04));
  ctx.fillStyle = '#22d3ee';
  ctx.fillRect(rgbShift, Math.round(height * (0.62 - progress * 0.3)), width - rgbShift, Math.round(height * 0.035));

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
 * 1フレーム分の背景維持＋一瞬グリッチ＋パーツ別異色アニメカラー合成を Canvas へ描画する。
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
    palette = 'golden-bizarre',
    touchStyle = 'color-only',
    subjectMask = null,
  } = options;

  // 背景（風景）は一切変更せず元解像度のまま描画する
  ctx.drawImage(sourceElement, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);

  const shiftState = computeBizarreShiftState(localSec, triggerSec);
  const partMapSrc = subjectMask?.partMap || subjectMask?.mask;

  if (shiftState.shiftBlend > 0 && partMapSrc && subjectMask.coverageRatio > 0.002) {
    const workW = Math.min(width, 360);
    const workH = Math.max(2, Math.round((workW * height) / width));

    reusableWorkCanvas = getReusableCanvas(reusableWorkCanvas, workW, workH);
    const workCtx = reusableWorkCanvas.getContext('2d', { willReadFrequently: true });

    reusablePartCanvas = getReusableCanvas(
      reusablePartCanvas,
      subjectMask.width,
      subjectMask.height
    );
    const partSrcCtx = reusablePartCanvas.getContext('2d');

    reusablePartScaledCanvas = getReusableCanvas(reusablePartScaledCanvas, workW, workH);
    const partScaledCtx = reusablePartScaledCanvas.getContext('2d', { willReadFrequently: true });

    reusableSubjectCanvas = getReusableCanvas(reusableSubjectCanvas, workW, workH);
    const subCtx = reusableSubjectCanvas.getContext('2d');

    if (workCtx && partSrcCtx && partScaledCtx && subCtx) {
      workCtx.drawImage(sourceElement, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, workW, workH);
      const srcImageData = workCtx.getImageData(0, 0, workW, workH);

      // パーツIDをRチャネルへ格納し、最近傍補間（imageSmoothingEnabled=false）で拡大してパーツ番号を厳密保持する
      const partImg = partSrcCtx.createImageData(subjectMask.width, subjectMask.height);
      const pData = partImg.data;
      for (let i = 0; i < partMapSrc.length; i++) {
        const p = i * 4;
        pData[p] = partMapSrc[i];
        pData[p + 3] = 255;
      }
      partSrcCtx.putImageData(partImg, 0, 0);

      partScaledCtx.clearRect(0, 0, workW, workH);
      partScaledCtx.imageSmoothingEnabled = false;
      partScaledCtx.drawImage(reusablePartCanvas, 0, 0, workW, workH);
      const scaledData = partScaledCtx.getImageData(0, 0, workW, workH).data;
      const scaledParts = new Uint8Array(workW * workH);
      for (let i = 0; i < scaledParts.length; i++) {
        scaledParts[i] = scaledData[i * 4];
      }

      const stylizedRgba = stylizeSubjectPartPixels(
        srcImageData.data,
        scaledParts,
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
