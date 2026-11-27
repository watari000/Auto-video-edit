/**
 * 2秒後の一瞬グリッチ（「ザザッ」）の直後、黒と緑のデジタルコードだけが滝のように流れる世界へ切り替え、
 * 元映像の明暗を緑コードの濃淡として浮かび上がらせる純粋関数＆Canvas描画エンジン。
 */

const MATRIX_GLYPHS =
  'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$+-*/=%"#&_';

const DENSITY_CONFIG = {
  fine: { cols: 48, fontRatio: 1.05 },
  standard: { cols: 34, fontRatio: 1.08 },
  bold: { cols: 24, fontRatio: 1.12 },
};

const VISIBILITY_CONFIG = {
  silhouette: { rainWeight: 0.34, lumaWeight: 0.78, contrastGamma: 0.85 },
  balanced: { rainWeight: 0.5, lumaWeight: 0.62, contrastGamma: 0.95 },
  rain: { rainWeight: 0.72, lumaWeight: 0.4, contrastGamma: 1.05 },
};

let reusableLumaCanvas = null;
let reusableGlitchCanvas = null;

function fract(x) {
  return x - Math.floor(x);
}

function hash2d(a, b) {
  return fract(Math.sin(a * 127.1 + b * 311.7) * 43758.5453123);
}

/**
 * 経過秒数から「通常 → 一瞬のザザッ（グリッチ） → マトリックスコード世界」の状態を返す純粋関数。
 */
export function computeMatrixWorldState(
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
      matrixBlend: 0,
    };
  }

  if (safeLocal < safeTrigger + safeGlitchDur) {
    const glitchProgress = (safeLocal - safeTrigger) / safeGlitchDur;
    return {
      phase: 'glitch',
      glitchProgress,
      glitchIntensity: Math.sin(glitchProgress * Math.PI),
      matrixBlend: glitchProgress >= 0.5 ? 1 : 0,
    };
  }

  return {
    phase: 'matrix',
    glitchProgress: 1,
    glitchIntensity: 0,
    matrixBlend: 1,
  };
}

/**
 * 指定の列・行・時刻に対して決定論的にコード文字とデジタルレイン強度(0..1)を返す純粋関数。
 * プレビューとオフライン30fps書き出しで完全に一致したコードの雨を生成できる。
 */
export function sampleMatrixCell(col, row, totalRows, elapsedMatrixSec) {
  const speedRowsPerSec = 10 + hash2d(col, 13.7) * 14;
  const trailLen = 8 + Math.floor(hash2d(col, 29.3) * 12);
  const phaseOffset = hash2d(col, 51.9) * (totalRows + trailLen);
  const cycleLen = totalRows + trailLen + 6;
  const headRow = (phaseOffset + elapsedMatrixSec * speedRowsPerSec) % cycleLen;

  let distFromHead = headRow - row;
  if (distFromHead < 0) {
    distFromHead += cycleLen;
  }

  let rainIntensity = 0;
  let isHead = false;
  if (distFromHead >= 0 && distFromHead < 1.15) {
    rainIntensity = 1.0;
    isHead = true;
  } else if (distFromHead > 0 && distFromHead <= trailLen) {
    rainIntensity = Math.pow(1 - distFromHead / trailLen, 1.45);
  }

  const glyphTick = Math.floor(elapsedMatrixSec * (7 + hash2d(col, row) * 6));
  const glyphIdx = Math.floor(hash2d(col * 31 + row, glyphTick) * MATRIX_GLYPHS.length);
  const glyph = MATRIX_GLYPHS[glyphIdx] || '0';

  return { glyph, rainIntensity, isHead };
}

function getReusableCanvas(existing, width, height) {
  const canvas = existing || document.createElement('canvas');
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas;
}

function drawMatrixGlitchBurst(ctx, width, height, progress, intensity) {
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
  const sliceCount = 12;
  for (let i = 0; i < sliceCount; i++) {
    const seed = Math.sin((i + 1) * 79.3 + progress * 41.7);
    if (Math.abs(seed) < 0.2) continue;
    const sy = Math.floor((i / sliceCount) * height);
    const sh = Math.max(4, Math.floor((height / sliceCount) * (0.45 + 0.55 * Math.abs(seed))));
    const offsetX = Math.round(seed * width * 0.09 * intensity);
    ctx.drawImage(reusableGlitchCanvas, 0, sy, width, sh, offsetX, sy, width, sh);
  }

  // 緑・シアンのデジタル走査ノイズ
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = `rgba(34, 255, 102, ${(0.36 * intensity).toFixed(3)})`;
  for (let s = 0; s < 14; s++) {
    const lineSeed = Math.abs(Math.sin((s + 1) * 47.9 + progress * 61.3));
    const ly = Math.floor(lineSeed * height);
    const lw = Math.floor(width * (0.3 + 0.65 * Math.abs(Math.cos(s * 19.1 + progress * 27))));
    const lx = Math.floor((width - lw) * Math.abs(Math.sin(s * 13.7 + progress * 23)));
    ctx.fillRect(lx, ly, lw, Math.max(2, Math.round(height * 0.005)));
  }
  ctx.restore();
}

/**
 * 1フレーム分の通常映像→一瞬グリッチ→黒×緑デジタルコード世界の描画を実行する。
 */
export function drawMatrixCodeComposite(
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
    density = 'standard',
    visibility = 'balanced',
  } = options;

  const worldState = computeMatrixWorldState(localSec, triggerSec);

  if (worldState.matrixBlend <= 0) {
    ctx.drawImage(sourceElement, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
    if (worldState.phase === 'glitch') {
      drawMatrixGlitchBurst(ctx, width, height, worldState.glitchProgress, worldState.glitchIntensity);
    }
    return;
  }

  const dCfg = DENSITY_CONFIG[density] || DENSITY_CONFIG.standard;
  const vCfg = VISIBILITY_CONFIG[visibility] || VISIBILITY_CONFIG.balanced;
  const cols = dCfg.cols;
  const cellW = width / cols;
  const cellH = cellW * 1.18;
  const rows = Math.ceil(height / cellH);

  // 元映像を cols x rows の極小グリッドへ縮小し、各セルの明るさ（輝度）を取得する
  reusableLumaCanvas = getReusableCanvas(reusableLumaCanvas, cols, rows);
  const lumaCtx = reusableLumaCanvas.getContext('2d', { willReadFrequently: true });
  let rgba = null;
  if (lumaCtx) {
    lumaCtx.drawImage(sourceElement, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, cols, rows);
    rgba = lumaCtx.getImageData(0, 0, cols, rows).data;
  }

  ctx.save();
  // 背景は完全な漆黒
  ctx.fillStyle = '#020603';
  ctx.fillRect(0, 0, width, height);

  const fontSize = Math.max(7, Math.round(cellW * dCfg.fontRatio));
  ctx.font = `700 ${fontSize}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const elapsedMatrixSec = Math.max(0, localSec - triggerSec);

  for (let row = 0; row < rows; row++) {
    const cy = (row + 0.5) * cellH;
    for (let col = 0; col < cols; col++) {
      const { glyph, rainIntensity, isHead } = sampleMatrixCell(
        col,
        row,
        rows,
        elapsedMatrixSec
      );

      let lumaNorm = 0.25;
      if (rgba) {
        const p = (row * cols + col) * 4;
        const luma = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255;
        lumaNorm = Math.pow(luma, vCfg.contrastGamma);
      }

      const energy = Math.min(
        1,
        rainIntensity * vCfg.rainWeight + lumaNorm * vCfg.lumaWeight
      );

      if (energy < 0.08) {
        continue;
      }

      if (isHead && energy > 0.55) {
        ctx.fillStyle = `rgba(210, 255, 224, ${Math.min(1, energy + 0.15).toFixed(2)})`;
      } else {
        const g = Math.round(70 + energy * 185);
        const r = Math.round(energy > 0.72 ? (energy - 0.72) * 210 : 4);
        const b = Math.round(14 + energy * 76);
        const alpha = Math.min(1, 0.22 + energy * 0.78).toFixed(2);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }

      ctx.fillText(glyph, (col + 0.5) * cellW, cy);
    }
  }

  ctx.restore();

  if (worldState.phase === 'glitch') {
    drawMatrixGlitchBurst(ctx, width, height, worldState.glitchProgress, worldState.glitchIntensity);
  }
}
