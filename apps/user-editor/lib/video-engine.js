export const MAX_OUTPUT_WIDTH = 1080;
export const MAX_OUTPUT_HEIGHT = 1920;
export const MAX_OUTPUT_FPS = 30;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toEvenPixel(value) {
  // H.264/MP4エンコーダは縦横が偶数ピクセルでないと失敗する場合があるため切り捨てる
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * iOS Safariのメモリ上限対策として、解像度を1080x1920以下・フレームレートを30fps以下に制限する。
 */
export function computeSafeRenderDimensions(outputConfig = {}, scale = 1) {
  const safeScale = clamp(Number(scale) || 1, 0.25, 1);
  const rawWidth = clamp(Number(outputConfig.width) || MAX_OUTPUT_WIDTH, 360, MAX_OUTPUT_WIDTH);
  const rawHeight = clamp(Number(outputConfig.height) || MAX_OUTPUT_HEIGHT, 360, MAX_OUTPUT_HEIGHT);
  const fps = Math.round(clamp(Number(outputConfig.fps) || MAX_OUTPUT_FPS, 24, MAX_OUTPUT_FPS));

  return {
    width: toEvenPixel(rawWidth * safeScale),
    height: toEvenPixel(rawHeight * safeScale),
    fps,
  };
}

/**
 * 横長・縦長どちらの素材でも9:16枠へ中央トリミング（cover）しつつ、動きエフェクト用の切り出し矩形を計算する。
 */
export function computeCoverCropRect(
  sourceWidth,
  sourceHeight,
  targetWidth,
  targetHeight,
  motion = 'none',
  progress = 0
) {
  if (!sourceWidth || !sourceHeight || !targetWidth || !targetHeight) {
    return { sx: 0, sy: 0, sw: sourceWidth || 1, sh: sourceHeight || 1 };
  }

  const p = clamp(progress, 0, 1);
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;

  let baseSw;
  let baseSh;
  if (sourceAspect > targetAspect) {
    // 横長素材：縦いっぱいに合わせて左右をトリミングする
    baseSh = sourceHeight;
    baseSw = sourceHeight * targetAspect;
  } else {
    // 縦長素材：横いっぱいに合わせて上下をトリミングする
    baseSw = sourceWidth;
    baseSh = sourceWidth / targetAspect;
  }

  let zoomFactor = 1;
  let panShiftRatio = 0;

  if (motion === 'zoom-in') {
    zoomFactor = 1 + 0.08 * p;
  } else if (motion === 'zoom-out') {
    zoomFactor = 1.08 - 0.08 * p;
  } else if (motion === 'pan-left') {
    zoomFactor = 1.06;
    panShiftRatio = 0.5 - p;
  } else if (motion === 'pan-right') {
    zoomFactor = 1.06;
    panShiftRatio = -0.5 + p;
  }

  const sw = baseSw / zoomFactor;
  const sh = baseSh / zoomFactor;
  const maxOffsetX = Math.max(0, (sourceWidth - sw) / 2);
  const centerX = (sourceWidth - sw) / 2 + panShiftRatio * Math.min(maxOffsetX, sw * 0.06);
  const sx = clamp(centerX, 0, Math.max(0, sourceWidth - sw));
  const sy = clamp((sourceHeight - sh) / 2, 0, Math.max(0, sourceHeight - sh));

  return { sx, sy, sw, sh };
}

/**
 * テンプレートの色味プリセットをCanvas 2Dコンテキストのfilter文字列へ変換する。
 */
export function getCanvasFilterString(filterName = 'none') {
  switch (filterName) {
    case 'warm':
      return 'sepia(16%) saturate(112%) brightness(102%)';
    case 'cool':
      return 'saturate(96%) contrast(104%) hue-rotate(8deg)';
    case 'vintage':
      return 'sepia(28%) contrast(95%) brightness(98%)';
    case 'vivid':
      return 'saturate(126%) contrast(108%)';
    case 'none':
    default:
      return 'none';
  }
}

/**
 * カット一覧からタイムライン上の開始秒・終了秒配列を組み立てる。
 */
export function buildTimelineSegments(cuts = []) {
  const ordered = [...cuts].sort((a, b) => a.order - b.order);
  const segments = [];
  let cursor = 0;

  for (const cut of ordered) {
    const duration = Number(cut.durationSec) || 0;
    const startSec = cursor;
    const endSec = cursor + duration;
    segments.push({ cut, startSec, endSec });
    cursor = endSec;
  }

  return {
    segments,
    totalDurationSec: Number(cursor.toFixed(3)),
  };
}

/**
 * 指定された再生時刻（秒）に該当するカットセグメントと、カット内経過秒・進捗率(0..1)を返す。
 */
export function resolveCutAtTime(segments, currentSec) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return null;
  }

  const clampedTime = Math.max(0, currentSec);
  for (const segment of segments) {
    if (clampedTime < segment.endSec || segment === segments[segments.length - 1]) {
      const duration = Math.max(0.001, segment.endSec - segment.startSec);
      const localSec = clamp(clampedTime - segment.startSec, 0, duration);
      return {
        segment,
        localSec,
        progress: clamp(localSec / duration, 0, 1),
      };
    }
  }

  return null;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawTextOverlay(ctx, textOverlay, textOverride, width, height) {
  if (!textOverlay) {
    return;
  }
  const text = (textOverride !== undefined ? textOverride : textOverlay.defaultText || '').trim();
  if (!text) {
    return;
  }

  ctx.save();
  const fontSize = Math.round(width * 0.052);
  ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let centerY = height * 0.82;
  if (textOverlay.position === 'top') {
    centerY = height * 0.16;
  } else if (textOverlay.position === 'center') {
    centerY = height * 0.5;
  }

  const metrics = ctx.measureText(text);
  const paddingX = Math.round(fontSize * 0.85);
  const paddingY = Math.round(fontSize * 0.45);
  const boxWidth = Math.min(width * 0.88, metrics.width + paddingX * 2);
  const boxHeight = fontSize + paddingY * 2;

  if (textOverlay.style === 'pill') {
    ctx.fillStyle = 'rgba(17, 24, 39, 0.72)';
    drawRoundedRect(ctx, width / 2 - boxWidth / 2, centerY - boxHeight / 2, boxWidth, boxHeight, boxHeight / 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, width / 2, centerY, width * 0.82);
  } else if (textOverlay.style === 'shadow') {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = Math.round(fontSize * 0.35);
    ctx.shadowOffsetY = Math.round(fontSize * 0.1);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, width / 2, centerY, width * 0.86);
  } else {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
    ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.12));
    ctx.strokeText(text, width / 2, centerY, width * 0.86);
    ctx.fillText(text, width / 2, centerY, width * 0.86);
  }

  ctx.restore();
}

/**
 * 1フレーム分の映像（素材・エフェクト・フェード・テロップ）をCanvasへ描画する。
 */
export function drawCutFrame(ctx, cut, mediaEntry, localSec, width, height, textOverride) {
  ctx.save();
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, width, height);

  const duration = Math.max(0.001, Number(cut.durationSec) || 1);
  const progress = clamp(localSec / duration, 0, 1);

  if (cut.effect?.transitionIn === 'fade') {
    const fadeSec = Math.min(0.28, duration * 0.3);
    ctx.globalAlpha = clamp(localSec / fadeSec, 0.15, 1);
  }

  const element = mediaEntry?.element;
  const sourceWidth = mediaEntry?.width || 0;
  const sourceHeight = mediaEntry?.height || 0;

  if (element && sourceWidth > 0 && sourceHeight > 0) {
    const crop = computeCoverCropRect(
      sourceWidth,
      sourceHeight,
      width,
      height,
      cut.effect?.motion || 'none',
      progress
    );

    if ('filter' in ctx) {
      ctx.filter = getCanvasFilterString(cut.effect?.filter);
    }
    ctx.drawImage(element, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
    if ('filter' in ctx) {
      ctx.filter = 'none';
    }
  } else {
    // 素材未選択時でもタイムライン確認ができるようプレースホルダーを描画する
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#334155');
    gradient.addColorStop(1, '#1e293b');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#cbd5e1';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fontSize = Math.round(width * 0.045);
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif`;
    ctx.fillText(cut.label || '素材未選択', width / 2, height * 0.46, width * 0.82);

    ctx.font = `400 ${Math.round(fontSize * 0.78)}px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif`;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('STEP 2で写真または動画を選択してください', width / 2, height * 0.53, width * 0.84);
  }

  ctx.restore();
  drawTextOverlay(ctx, cut.textOverlay, textOverride, width, height);
}

/**
 * 実行ブラウザがサポートしているMediaRecorderのMIMEタイプをMP4優先で選択する。
 */
export function selectSupportedRecorderMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }

  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];

  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return '';
}

/**
 * ObjectURLの生成と解放を一元管理し、iOS Safariでの連続操作によるメモリリークを防ぐ。
 */
export function createMediaResourcePool() {
  const activeUrls = new Set();

  return {
    registerUrl(url) {
      if (url) {
        activeUrls.add(url);
      }
      return url;
    },
    revokeUrl(url) {
      if (url && activeUrls.has(url)) {
        URL.revokeObjectURL(url);
        activeUrls.delete(url);
      }
    },
    disposeAll() {
      for (const url of activeUrls) {
        URL.revokeObjectURL(url);
      }
      activeUrls.clear();
    },
    get size() {
      return activeUrls.size;
    },
  };
}
