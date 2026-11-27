/**
 * 2秒後の一瞬グリッチ（「ザザッ」）の直後、映像の輪郭（縦・横・右から左・斜めカーブ）の
 * 接線ベクトル場に沿って緑のデジタルコードが滑らかに流れ動く世界を描画するエンジン。
 */

const MATRIX_GLYPHS =
  '01ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const DENSITY_CONFIG = {
  fine: { cols: 112, fontRatio: 1.08 },
  standard: { cols: 84, fontRatio: 1.1 },
  bold: { cols: 56, fontRatio: 1.14 },
};

const VISIBILITY_CONFIG = {
  silhouette: { gamma: 1.7, lumaWeight: 0.42, edgeBoost: 0.96, floorCutoff: 0.14, flowMix: 0.36 },
  balanced: { gamma: 1.45, lumaWeight: 0.56, edgeBoost: 0.78, floorCutoff: 0.09, flowMix: 0.42 },
  rain: { gamma: 1.25, lumaWeight: 0.66, edgeBoost: 0.6, floorCutoff: 0.05, flowMix: 0.5 },
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
 * 経過秒数から「通常 → 一瞬のザザッ（グリッチ） → コード輪郭フロー世界」の状態を返す純粋関数。
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
 * 1フレーム分の輝度配列を最小〜最大の実効レンジへ自動ストレッチする。
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

/**
 * 輝度配列(cols*rows)から各セルの輪郭強度と、輪郭線に沿った接線方向ベクトル (tx, ty) を計算する純粋関数。
 * 横線なら横向き（右から左など）、斜め・カーブならその曲線の向きに沿ってベクトルが揃う。
 */
export function computeContourFlowField(lumaGrid, cols, rows) {
  const total = cols * rows;
  const edges = new Float32Array(total);
  const rawTx = new Float32Array(total);
  const rawTy = new Float32Array(total);

  for (let y = 0; y < rows; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y + 1 < rows ? y + 1 : rows - 1;
    for (let x = 0; x < cols; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x + 1 < cols ? x + 1 : cols - 1;

      // 3x3 Sobel カーネルでノイズを抑えつつ輪郭線をくっきり抽出する
      const gx =
        -lumaGrid[y0 * cols + x0] + lumaGrid[y0 * cols + x1] +
        -2 * lumaGrid[y * cols + x0] + 2 * lumaGrid[y * cols + x1] +
        -lumaGrid[y1 * cols + x0] + lumaGrid[y1 * cols + x1];
      const gy =
        -lumaGrid[y0 * cols + x0] - 2 * lumaGrid[y0 * cols + x] - lumaGrid[y0 * cols + x1] +
        lumaGrid[y1 * cols + x0] + 2 * lumaGrid[y1 * cols + x] + lumaGrid[y1 * cols + x1];
      const mag = Math.hypot(gx, gy) * 0.35;
      const idx = y * cols + x;

      edges[idx] = Math.min(1, Math.pow(mag, 0.8) * 1.35);
      if (mag > 0.008) {
        rawTx[idx] = -gy / (mag / 0.35);
        rawTy[idx] = gx / (mag / 0.35);
      } else {
        rawTx[idx] = -0.707;
        rawTy[idx] = 0.707;
      }
    }
  }

  // 3x3平滑化でカーブの向きを滑らかにつなぐ
  const tx = new Float32Array(total);
  const ty = new Float32Array(total);
  for (let y = 0; y < rows; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y + 1 < rows ? y + 1 : rows - 1;
    for (let x = 0; x < cols; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x + 1 < cols ? x + 1 : cols - 1;
      let sx = 0;
      let sy = 0;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const nIdx = yy * cols + xx;
          const w = 0.2 + edges[nIdx];
          sx += rawTx[nIdx] * w;
          sy += rawTy[nIdx] * w;
        }
      }
      const len = Math.hypot(sx, sy) || 1;
      const idx = y * cols + x;
      tx[idx] = sx / len;
      ty[idx] = sy / len;
    }
  }

  return { edges, tx, ty };
}

export function computeGridEdgeMap(lumaGrid, cols, rows) {
  return computeContourFlowField(lumaGrid, cols, rows).edges;
}

/**
 * 輪郭接線ベクトル (tx, ty) に沿って流れるコード文字と流線パルス強度(0..1)を返す純粋関数。
 */
export function sampleMatrixCell(col, row, totalRows, elapsedMatrixSec, tx = 0, ty = 1) {
  // 接線方向への射影座標に沿ってデータパケットを流す（横・右から左・斜め・カーブに対応）
  const streamCoord = col * tx + row * ty;
  const speed = 10.5;
  const wavePhase = streamCoord * 0.65 - elapsedMatrixSec * speed;
  const pulse = Math.pow(0.5 + 0.5 * Math.sin(wavePhase), 2.4);

  // 流れる向きに沿って文字インデックスを送り、文字の列自体が輪郭上を走っているように見せる
  const flowStep = Math.floor(elapsedMatrixSec * 12 - streamCoord * 0.85);
  const laneHash = Math.floor(hash2d(Math.round(col * ty - row * tx), 7) * 97);
  const glyphIdx = Math.abs(flowStep + laneHash + col * 3 + row * 5) % MATRIX_GLYPHS.length;
  const glyph = MATRIX_GLYPHS[glyphIdx] || '0';

  return {
    glyph,
    rainIntensity: pulse,
    isHead: pulse > 0.86,
  };
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
 * 1フレーム分の通常映像→一瞬グリッチ→輪郭フローに沿ってコードが流れる世界を描画する。
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
  const { edges: edgeGrid, tx: txGrid, ty: tyGrid } = computeContourFlowField(
    lumaGrid,
    cols,
    rows
  );

  ctx.save();
  ctx.fillStyle = '#010402';
  ctx.fillRect(0, 0, width, height);

  const fontSize = Math.max(5, Math.round(cellW * dCfg.fontRatio));
  ctx.font = `700 ${fontSize}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const elapsedMatrixSec = Math.max(0, localSec - triggerSec);

  for (let row = 0; row < rows; row++) {
    const baseCy = (row + 0.5) * cellH;
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const luma = Math.pow(lumaGrid[idx], vCfg.gamma);
      const edge = edgeGrid[idx];
      const baseTone = Math.min(1, luma * vCfg.lumaWeight + edge * vCfg.edgeBoost);

      if (baseTone < vCfg.floorCutoff) {
        continue;
      }

      const tx = txGrid[idx];
      const ty = tyGrid[idx];
      const { glyph, rainIntensity, isHead } = sampleMatrixCell(
        col,
        row,
        rows,
        elapsedMatrixSec,
        tx,
        ty
      );

      // 輪郭上の文字は接線方向（横・斜め・カーブ）へ微かに滑らせつつ流線パルスを走らせる
      const flowShift = fract(elapsedMatrixSec * 3.2) - 0.5;
      const driftPx = edge > 0.18 ? flowShift * cellW * 0.55 : 0;
      const drawX = (col + 0.5) * cellW + tx * driftPx;
      const drawY = baseCy + ty * driftPx;

      const waveFactor = 1 - vCfg.flowMix * (1 - rainIntensity);
      const brightness = Math.min(1, baseTone * waveFactor + (edge > 0.25 && isHead ? 0.25 : 0));

      if (brightness > 0.76) {
        const highlight = (brightness - 0.76) / 0.24;
        const r = Math.round(45 + highlight * 175);
        const g = 255;
        const b = Math.round(90 + highlight * 145);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      } else {
        const g = Math.round(28 + brightness * 225);
        const b = Math.round(8 + brightness * 68);
        ctx.fillStyle = `rgb(4, ${g}, ${b})`;
      }

      ctx.fillText(glyph, drawX, drawY);
    }
  }

  ctx.restore();

  if (worldState.phase === 'glitch') {
    drawMatrixGlitchBurst(ctx, width, height, worldState.glitchProgress, worldState.glitchIntensity);
  }
}
