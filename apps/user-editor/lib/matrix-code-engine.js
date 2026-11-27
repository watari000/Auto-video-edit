/**
 * 2秒後の一瞬グリッチ（「ザザッ」）の直後、黒と緑のデジタルコードだけで
 * 写真や動画の元の姿・輪郭がはっきり判別できるように描くエンジン。
 */

const MATRIX_GLYPHS =
  '01ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const DENSITY_CONFIG = {
  fine: { cols: 108, fontRatio: 1.08 },
  standard: { cols: 80, fontRatio: 1.1 },
  bold: { cols: 52, fontRatio: 1.14 },
};

const VISIBILITY_CONFIG = {
  silhouette: { gamma: 1.45, edgeBoost: 0.45, floorCutoff: 0.1, streamMix: 0.14 },
  balanced: { gamma: 1.25, edgeBoost: 0.35, floorCutoff: 0.06, streamMix: 0.22 },
  rain: { gamma: 1.1, edgeBoost: 0.25, floorCutoff: 0.03, streamMix: 0.34 },
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
 * 経過秒数から「通常 → 一瞬のザザッ（グリッチ） → コード輪郭世界」の状態を返す純粋関数。
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
 * 指定のセル(col, row)におけるコード文字と微細なデータ流れ強度(0..1)を返す純粋関数。
 */
export function sampleMatrixCell(col, row, totalRows, elapsedMatrixSec) {
  const streamWave =
    0.5 + 0.5 * Math.sin(col * 0.28 + row * 0.18 - elapsedMatrixSec * 6.0);
  const changeRate = 7 + hash2d(col, row) * 7;
  const glyphTick = Math.floor(elapsedMatrixSec * changeRate + hash2d(row, col) * 19);
  const glyphIdx = Math.floor(hash2d(col * 37 + row * 13, glyphTick) * MATRIX_GLYPHS.length);
  const glyph = MATRIX_GLYPHS[glyphIdx] || '0';

  return {
    glyph,
    rainIntensity: streamWave,
    isHead: streamWave > 0.9,
  };
}

/**
 * 輝度配列(cols*rows)から各セルの輪郭強度（エッジ 0..1）を計算する純粋関数。
 */
export function computeGridEdgeMap(lumaGrid, cols, rows) {
  const edges = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y + 1 < rows ? y + 1 : rows - 1;
    for (let x = 0; x < cols; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x + 1 < cols ? x + 1 : cols - 1;
      const gx = Math.abs(lumaGrid[y * cols + x1] - lumaGrid[y * cols + x0]);
      const gy = Math.abs(lumaGrid[y1 * cols + x] - lumaGrid[y0 * cols + x]);
      edges[y * cols + x] = Math.min(1, (gx + gy) * 1.5);
    }
  }
  return edges;
}

/**
 * 1フレーム分の輝度配列を 5%〜95% の実効レンジへ自動ストレッチし、
 * 暗い映像や低コントラスト映像でも黒と緑の階調がくっきり出るようにする。
 */
export function normalizeLumaContrast(lumaGrid) {
  const n = lumaGrid.length;
  const out = new Float32Array(n);
  if (n === 0) {
    return out;
  }

  let minVal = 1;
  let maxVal = 0;
  for (let i = 0; i < n; i++) {
    const v = lumaGrid[i];
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }

  const span = maxVal - minVal;
  if (span < 0.08) {
    out.set(lumaGrid);
    return out;
  }

  for (let i = 0; i < n; i++) {
    out[i] = Math.min(1, Math.max(0, (lumaGrid[i] - minVal) / span));
  }
  return out;
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
 * 1フレーム分の通常映像→一瞬グリッチ→高精細な黒×緑デジタルコード映像を描画する。
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
    visibility = 'silhouette',
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
  const vCfg = VISIBILITY_CONFIG[visibility] || VISIBILITY_CONFIG.silhouette;
  const cols = dCfg.cols;
  const cellW = width / cols;
  const cellH = cellW * 1.08;
  const rows = Math.ceil(height / cellH);

  reusableLumaCanvas = getReusableCanvas(reusableLumaCanvas, cols, rows);
  const lumaCtx = reusableLumaCanvas.getContext('2d', { willReadFrequently: true });
  const rawLumaGrid = new Float32Array(cols * rows);

  if (lumaCtx) {
    lumaCtx.drawImage(sourceElement, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, cols, rows);
    const rgba = lumaCtx.getImageData(0, 0, cols, rows).data;
    for (let i = 0; i < rawLumaGrid.length; i++) {
      const p = i * 4;
      rawLumaGrid[i] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255;
    }
  }

  const lumaGrid = normalizeLumaContrast(rawLumaGrid);
  const edgeGrid = computeGridEdgeMap(lumaGrid, cols, rows);

  ctx.save();
  ctx.fillStyle = '#010402';
  ctx.fillRect(0, 0, width, height);

  const fontSize = Math.max(5, Math.round(cellW * dCfg.fontRatio));
  ctx.font = `700 ${fontSize}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const elapsedMatrixSec = Math.max(0, localSec - triggerSec);

  for (let row = 0; row < rows; row++) {
    const cy = (row + 0.5) * cellH;
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const luma = Math.pow(lumaGrid[idx], vCfg.gamma);
      const edge = edgeGrid[idx];

      // 飽和を防ぎ、元映像の明暗階調を素直にコードの明るさへ反映する
      const baseTone = Math.min(1, luma * 0.88 + edge * vCfg.edgeBoost);
      if (baseTone < vCfg.floorCutoff) {
        continue;
      }

      const { glyph, rainIntensity } = sampleMatrixCell(col, row, rows, elapsedMatrixSec);
      // 文字が流れる感覚は保ちつつ、元映像の明暗を壊さないよう波の強さを抑える
      const waveFactor = 1 - vCfg.streamMix * (1 - rainIntensity);
      const brightness = Math.min(1, baseTone * waveFactor);

      if (brightness > 0.78) {
        const highlight = (brightness - 0.78) / 0.22;
        const r = Math.round(35 + highlight * 170);
        const g = 255;
        const b = Math.round(80 + highlight * 145);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      } else {
        const g = Math.round(28 + brightness * 225);
        const b = Math.round(8 + brightness * 68);
        ctx.fillStyle = `rgb(4, ${g}, ${b})`;
      }

      ctx.fillText(glyph, (col + 0.5) * cellW, cy);
    }
  }

  ctx.restore();

  if (worldState.phase === 'glitch') {
    drawMatrixGlitchBurst(ctx, width, height, worldState.glitchProgress, worldState.glitchIntensity);
  }
}
