export const MAX_OUTPUT_WIDTH = 1080;
export const MAX_OUTPUT_HEIGHT = 1920;
export const MAX_OUTPUT_FPS = 30;

const SKETCH_PALETTES = {
  'ink-paper': {
    paper: [244, 239, 228],
    ink: [30, 27, 24],
    strokeCss: '#1e1b18',
    accentCss: '#ff4d1c',
  },
  'chalk-dark': {
    paper: [20, 20, 24],
    ink: [244, 241, 234],
    strokeCss: '#f4f1ea',
    accentCss: '#d4af7a',
  },
  'pencil-warm': {
    paper: [247, 241, 227],
    ink: [74, 59, 44],
    strokeCss: '#4a3b2c',
    accentCss: '#d97706',
  },
};

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

/**
 * キネティック字幕のテキストを空白で分割し、*強調語* を解析する（純粋関数）。
 */
export function parseKineticTokens(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    return [];
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  let hasExplicitEmphasis = false;

  const parsed = parts.map((part) => {
    const match = /^\*(.+)\*$/.exec(part);
    if (match && match[1].trim()) {
      hasExplicitEmphasis = true;
      return { text: match[1].trim(), emphasized: true };
    }
    return { text: part, emphasized: false };
  });

  if (!hasExplicitEmphasis && parsed.length > 0) {
    parsed[parsed.length - 1].emphasized = true;
  }

  return parsed;
}

/**
 * キネティック字幕の各単語が、現在時刻（localSec）でどの出現状態にあるか計算する（純粋関数）。
 */
export function computeKineticTokenState(index, totalTokens, localSec, durationSec) {
  const count = Math.max(1, Number(totalTokens) || 1);
  const duration = Math.max(0.001, Number(durationSec) || 1);
  const t = Math.max(0, Number(localSec) || 0);
  const revealWindow = duration * 0.72;
  const step = revealWindow / count;
  const startAt = index * step;
  const nextStartAt = (index + 1) * step;
  const animDur = Math.min(0.24, Math.max(0.08, step * 0.9));

  if (t < startAt) {
    return {
      visible: false,
      opacity: 0,
      scale: 0.6,
      offsetY: 18,
      isCurrent: false,
    };
  }

  const elapsed = t - startAt;
  if (elapsed < animDur) {
    const p = clamp(elapsed / animDur, 0, 1);
    const scale =
      p < 0.65
        ? 0.6 + (1.14 - 0.6) * (p / 0.65)
        : 1.14 - 0.14 * ((p - 0.65) / 0.35);
    return {
      visible: true,
      opacity: clamp(p * 1.4, 0, 1),
      scale,
      offsetY: 18 * Math.pow(1 - p, 2),
      isCurrent: t < nextStartAt,
    };
  }

  return {
    visible: true,
    opacity: 1,
    scale: 1,
    offsetY: 0,
    isCurrent: t < nextStartAt,
  };
}

function drawKineticTextOverlay(ctx, textOverlay, textOverride, width, height, localSec, durationSec) {
  const rawText = (textOverride !== undefined ? textOverride : textOverlay.defaultText || '').trim();
  const tokens = parseKineticTokens(rawText);
  if (tokens.length === 0) {
    return;
  }

  const animation = textOverlay.animation || 'word-pop';
  const accentColor = textOverlay.accentColor || '#ff4d1c';
  const baseFontSize = Math.round(width * 0.056);
  const emphFontSize = Math.round(baseFontSize * 1.22);
  const spaceGap = Math.round(baseFontSize * 0.34);
  const maxLineWidth = width * 0.86;
  const fontFamily = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif';

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const measured = tokens.map((token, index) => {
    const fontSize = token.emphasized ? emphFontSize : baseFontSize;
    const weight = token.emphasized ? 900 : 700;
    const font = `${weight} ${fontSize}px ${fontFamily}`;
    ctx.font = font;
    const textWidth = ctx.measureText(token.text).width;
    const padX = token.emphasized && animation === 'word-pop' ? Math.round(fontSize * 0.42) : 0;
    const padY = token.emphasized && animation === 'word-pop' ? Math.round(fontSize * 0.22) : 0;
    return {
      ...token,
      index,
      fontSize,
      font,
      textWidth,
      padX,
      padY,
      boxWidth: textWidth + padX * 2,
      boxHeight: fontSize + padY * 2,
    };
  });

  const lines = [];
  let currentLine = { items: [], width: 0 };

  for (const item of measured) {
    const nextWidth =
      currentLine.items.length === 0 ? item.boxWidth : currentLine.width + spaceGap + item.boxWidth;
    if (currentLine.items.length > 0 && nextWidth > maxLineWidth) {
      lines.push(currentLine);
      currentLine = { items: [item], width: item.boxWidth };
    } else {
      currentLine.items.push(item);
      currentLine.width = nextWidth;
    }
  }
  if (currentLine.items.length > 0) {
    lines.push(currentLine);
  }

  let anchorY = height * 0.8;
  if (textOverlay.position === 'top') {
    anchorY = height * 0.18;
  } else if (textOverlay.position === 'center') {
    anchorY = height * 0.5;
  }

  const lineHeight = Math.round(emphFontSize * 1.42);
  const startY = anchorY - ((lines.length - 1) * lineHeight) / 2;

  lines.forEach((line, lineIdx) => {
    const lineY = startY + lineIdx * lineHeight;
    let cursorX = width / 2 - line.width / 2;

    line.items.forEach((item) => {
      const centerX = cursorX + item.boxWidth / 2;
      cursorX += item.boxWidth + spaceGap;

      const state =
        animation === 'none'
          ? { visible: true, opacity: 1, scale: 1, offsetY: 0, isCurrent: false }
          : computeKineticTokenState(item.index, tokens.length, localSec, durationSec);

      if (!state.visible) {
        return;
      }

      const slideOffsetX = animation === 'slide-beat' ? -state.offsetY * 0.9 : 0;
      const waveOffsetY =
        animation === 'emphasis-wave' && item.emphasized
          ? Math.sin((localSec * 6 + item.index) * 1.4) * Math.round(baseFontSize * 0.12)
          : 0;

      ctx.save();
      ctx.translate(centerX + slideOffsetX, lineY + state.offsetY + waveOffsetY);
      ctx.scale(state.scale, state.scale);
      ctx.globalAlpha = state.opacity;
      ctx.font = item.font;

      if (item.emphasized && animation === 'word-pop') {
        ctx.fillStyle = accentColor;
        drawRoundedRect(
          ctx,
          -item.boxWidth / 2,
          -item.boxHeight / 2,
          item.boxWidth,
          item.boxHeight,
          Math.round(item.boxHeight * 0.28)
        );
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(item.text, 0, 0);
      } else if (item.emphasized) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.72)';
        ctx.shadowBlur = Math.round(item.fontSize * 0.32);
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.75)';
        ctx.lineWidth = Math.max(3, Math.round(item.fontSize * 0.14));
        ctx.strokeText(item.text, 0, 0);
        ctx.fillStyle = accentColor;
        ctx.fillText(item.text, 0, 0);
      } else {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
        ctx.shadowBlur = Math.round(item.fontSize * 0.28);
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.65)';
        ctx.lineWidth = Math.max(2, Math.round(item.fontSize * 0.12));
        ctx.strokeText(item.text, 0, 0);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(item.text, 0, 0);
      }

      ctx.restore();
    });
  });

  ctx.restore();
}

function drawTextOverlay(ctx, textOverlay, textOverride, width, height, localSec = 0, durationSec = 1) {
  if (!textOverlay) {
    return;
  }
  if (textOverlay.style === 'kinetic') {
    drawKineticTextOverlay(ctx, textOverlay, textOverride, width, height, localSec, durationSec);
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
 * Sketch to Reality 演出の現在フェーズと進行率（0..1）を計算する。
 */
export function computeSketchRevealState(localSec, durationSec) {
  const duration = Math.max(0.001, Number(durationSec) || 1);
  const t = clamp(Number(localSec) || 0, 0, duration);
  const holdEnd = Math.min(0.65, duration * 0.28);
  const revealEnd = Math.min(duration * 0.68, holdEnd + 0.85);

  if (t < holdEnd) {
    return {
      phase: 'sketch-hold',
      revealRatio: 0,
      frameDrawProgress: clamp(t / Math.max(0.001, holdEnd), 0, 1),
      overlayOpacity: 1,
    };
  }

  if (t < revealEnd) {
    const linear = clamp((t - holdEnd) / Math.max(0.001, revealEnd - holdEnd), 0, 1);
    const eased = 1 - Math.pow(1 - linear, 3);
    return {
      phase: 'revealing',
      revealRatio: eased,
      frameDrawProgress: 1,
      overlayOpacity: 1 - eased * 0.65,
    };
  }

  const tailRatio = clamp((t - revealEnd) / Math.max(0.001, duration - revealEnd), 0, 1);
  return {
    phase: 'reality',
    revealRatio: 1,
    frameDrawProgress: 1,
    overlayOpacity: 0.35 * (1 - tailRatio),
  };
}

/**
 * RGBAピクセル配列からSobelエッジ検出を行い、紙とペン風の線画RGBA配列を生成する（純粋関数）。
 */
export function generateSketchImageData(rgbaData, width, height, sketchStyle = 'ink-paper') {
  const palette = SKETCH_PALETTES[sketchStyle] || SKETCH_PALETTES['ink-paper'];
  const pixelCount = width * height;
  const output = new Uint8ClampedArray(pixelCount * 4);
  const gray = new Float32Array(pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    gray[i] = 0.299 * rgbaData[idx] + 0.587 * rgbaData[idx + 1] + 0.114 * rgbaData[idx + 2];
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let edgeStrength = 0;

      if (x > 0 && y > 0 && x < width - 1 && y < height - 1) {
        const tl = gray[(y - 1) * width + (x - 1)];
        const tm = gray[(y - 1) * width + x];
        const tr = gray[(y - 1) * width + (x + 1)];
        const ml = gray[y * width + (x - 1)];
        const mr = gray[y * width + (x + 1)];
        const bl = gray[(y + 1) * width + (x - 1)];
        const bm = gray[(y + 1) * width + x];
        const br = gray[(y + 1) * width + (x + 1)];

        const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
        const gy = -tl - 2 * tm - tr + bl + 2 * bm + br;
        const mag = Math.sqrt(gx * gx + gy * gy);
        edgeStrength = clamp((mag - 36) / 140, 0, 1);
      }

      const outIdx = i * 4;
      output[outIdx] = Math.round(palette.paper[0] + (palette.ink[0] - palette.paper[0]) * edgeStrength);
      output[outIdx + 1] = Math.round(palette.paper[1] + (palette.ink[1] - palette.paper[1]) * edgeStrength);
      output[outIdx + 2] = Math.round(palette.paper[2] + (palette.ink[2] - palette.paper[2]) * edgeStrength);
      output[outIdx + 3] = 255;
    }
  }

  return output;
}

function getOrCreateSketchCanvas(mediaEntry, targetWidth, targetHeight, sketchStyle) {
  if (!mediaEntry._sketchCache) {
    mediaEntry._sketchCache = {};
  }
  const cacheKey = `${sketchStyle}`;
  if (mediaEntry._sketchCache[cacheKey]) {
    return mediaEntry._sketchCache[cacheKey];
  }

  // iOS Safariでも30fpsを保てるよう、線画生成は270x480の軽量サイズで初回のみキャッシュする
  const sketchW = 270;
  const sketchH = Math.max(2, Math.round((sketchW * targetHeight) / Math.max(1, targetWidth)));
  const canvas = document.createElement('canvas');
  canvas.width = sketchW;
  canvas.height = sketchH;
  const sCtx = canvas.getContext('2d', { willReadFrequently: true });

  if (sCtx) {
    const crop = computeCoverCropRect(
      mediaEntry.width,
      mediaEntry.height,
      sketchW,
      sketchH,
      'none',
      0
    );
    sCtx.drawImage(mediaEntry.element, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, sketchW, sketchH);
    try {
      const imgData = sCtx.getImageData(0, 0, sketchW, sketchH);
      const sketched = generateSketchImageData(imgData.data, sketchW, sketchH, sketchStyle);
      imgData.data.set(sketched);
      sCtx.putImageData(imgData, 0, 0);
    } catch {
      // ピクセル読み取りが制限された場合は単色背景にフォールバック
    }
  }

  mediaEntry._sketchCache[cacheKey] = canvas;
  return canvas;
}

function drawHandDrawnOverlay(ctx, width, height, sketchStyle, frameDrawProgress, overlayOpacity, revealRatio) {
  if (overlayOpacity <= 0.01) {
    return;
  }

  const palette = SKETCH_PALETTES[sketchStyle] || SKETCH_PALETTES['ink-paper'];
  const pad = Math.round(width * 0.045);
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const perimeter = (innerW + innerH) * 2;

  ctx.save();
  ctx.globalAlpha = clamp(overlayOpacity, 0, 1);
  ctx.strokeStyle = palette.strokeCss;
  ctx.lineWidth = Math.max(2, Math.round(width * 0.0055));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 手書き風の外枠を進行率に合わせて描き進める
  ctx.setLineDash([perimeter * clamp(frameDrawProgress, 0.05, 1), perimeter]);
  ctx.beginPath();
  ctx.moveTo(pad, pad + 4);
  ctx.quadraticCurveTo(width * 0.5, pad - 3, width - pad, pad + 2);
  ctx.quadraticCurveTo(width - pad + 4, height * 0.5, width - pad - 2, height - pad);
  ctx.quadraticCurveTo(width * 0.5, height - pad + 3, pad + 2, height - pad - 2);
  ctx.quadraticCurveTo(pad - 3, height * 0.5, pad, pad + 4);
  ctx.stroke();

  // 内側の細線（スケッチの二重線ニュアンス）
  ctx.setLineDash([perimeter * clamp(frameDrawProgress * 0.9, 0.05, 1), perimeter]);
  ctx.lineWidth = Math.max(1, Math.round(width * 0.0028));
  ctx.globalAlpha = clamp(overlayOpacity * 0.55, 0, 1);
  const pad2 = pad + Math.round(width * 0.016);
  ctx.strokeRect(pad2, pad2, width - pad2 * 2, height - pad2 * 2);

  // 四隅のハンドドローンのキラリ・アクセント線
  ctx.setLineDash([]);
  ctx.globalAlpha = clamp(overlayOpacity * 0.9, 0, 1);
  ctx.strokeStyle = palette.accentCss;
  ctx.lineWidth = Math.max(2, Math.round(width * 0.005));
  const tickLen = Math.round(width * 0.032);
  ctx.beginPath();
  ctx.moveTo(pad - 6, pad + tickLen);
  ctx.lineTo(pad + tickLen, pad - 6);
  ctx.moveTo(width - pad - tickLen, height - pad + 6);
  ctx.lineTo(width - pad + 6, height - pad - tickLen);
  ctx.stroke();

  // スケッチから実写へ切り替わる斜め境界ライン
  if (revealRatio > 0.01 && revealRatio < 0.99) {
    const limit = revealRatio * (width + height);
    ctx.strokeStyle = palette.accentCss;
    ctx.lineWidth = Math.max(2.5, Math.round(width * 0.007));
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(limit, 0);
    ctx.lineTo(0, limit);
    ctx.stroke();
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
  const element = mediaEntry?.element;
  const sourceWidth = mediaEntry?.width || 0;
  const sourceHeight = mediaEntry?.height || 0;

  if (cut.effect?.transitionIn === 'sketch-to-reality') {
    const sketchStyle = cut.effect?.sketchStyle || 'ink-paper';
    const sketchState = computeSketchRevealState(localSec, duration);
    const palette = SKETCH_PALETTES[sketchStyle] || SKETCH_PALETTES['ink-paper'];

    if (element && sourceWidth > 0 && sourceHeight > 0) {
      const sketchCanvas = getOrCreateSketchCanvas(mediaEntry, width, height, sketchStyle);
      ctx.drawImage(sketchCanvas, 0, 0, width, height);

      if (sketchState.revealRatio > 0) {
        ctx.save();
        const limit = sketchState.revealRatio * (width + height);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(limit, 0);
        ctx.lineTo(0, limit);
        ctx.closePath();
        ctx.clip();

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
        ctx.restore();
      }
    } else {
      ctx.fillStyle = palette.strokeCss === '#f4f1ea' ? '#141418' : '#f4efe4';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = palette.strokeCss;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const fontSize = Math.round(width * 0.045);
      ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif`;
      ctx.fillText(cut.label || 'Sketch Preview', width / 2, height * 0.46, width * 0.82);
      ctx.font = `400 ${Math.round(fontSize * 0.76)}px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif`;
      ctx.fillText('写真・動画を選ぶと自動で線画から変化します', width / 2, height * 0.53, width * 0.84);
    }

    drawHandDrawnOverlay(
      ctx,
      width,
      height,
      sketchStyle,
      sketchState.frameDrawProgress,
      sketchState.overlayOpacity,
      sketchState.revealRatio
    );

    ctx.restore();
    drawTextOverlay(ctx, cut.textOverlay, textOverride, width, height, localSec, duration);
    return;
  }

  if (cut.effect?.transitionIn === 'fade') {
    const fadeSec = Math.min(0.28, duration * 0.3);
    ctx.globalAlpha = clamp(localSec / fadeSec, 0.15, 1);
  }

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
  drawTextOverlay(ctx, cut.textOverlay, textOverride, width, height, localSec, duration);
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
