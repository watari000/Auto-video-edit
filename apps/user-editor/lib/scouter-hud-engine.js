import {
  BIZARRE_ANIMAL_CLASSES,
  ensureBizarreSegmenterReady,
} from './bizarre-shift-engine.js';

const CLASS_LABEL_MAP = {
  3: 'ANIMAL // BIRD',
  8: 'ANIMAL // CAT',
  10: 'ANIMAL // COW',
  12: 'ANIMAL // DOG',
  13: 'ANIMAL // HORSE',
  15: 'HUMAN // TARGET',
  17: 'ANIMAL // SHEEP',
};

export const SCOUTER_THEMES = {
  'ai-emerald': {
    label: 'AIロボ視界（エメラルドグリーン）',
    tint: 'rgba(4, 24, 18, 0.28)',
    primary: '#34d399',
    bright: '#a7f3d0',
    alert: '#fde047',
    panelBg: 'rgba(3, 18, 13, 0.82)',
  },
  'scouter-red': {
    label: '戦闘スカウター（クリムゾンレッド）',
    tint: 'rgba(42, 4, 12, 0.28)',
    primary: '#fb7185',
    bright: '#fecdd3',
    alert: '#fef08a',
    panelBg: 'rgba(28, 4, 10, 0.84)',
  },
  'scouter-green': {
    label: '戦闘スカウター（ネオングリーン）',
    tint: 'rgba(4, 30, 8, 0.26)',
    primary: '#4ade80',
    bright: '#dcfce7',
    alert: '#fde047',
    panelBg: 'rgba(3, 20, 6, 0.84)',
  },
  'cyber-cyan': {
    label: '戦術AIロボット（サイバーブルー）',
    tint: 'rgba(4, 18, 38, 0.30)',
    primary: '#38bdf8',
    bright: '#bae6fd',
    alert: '#facc15',
    panelBg: 'rgba(4, 14, 28, 0.84)',
  },
};

export const SCOUTER_POWER_PRESETS = {
  auto: { label: 'AI自動計測（被写体の大きさ・動物種別から自動算出）', value: null, tag: 'AI AUTO' },
  'power-5': { label: '戦闘力 5（一般市民・地球人レベル）', value: 5, tag: 'CIVILIAN' },
  'power-408': { label: '戦闘力 408（初期・地球の戦士レベル）', value: 408, tag: 'WARRIOR' },
  'power-1330': { label: '戦闘力 1,330（必殺技チャージレベル）', value: 1330, tag: 'CHARGING' },
  'power-1500': { label: '戦闘力 1,500（宇宙偵察兵レベル）', value: 1500, tag: 'SCOUT' },
  'power-4000': { label: '戦闘力 4,000（エリート巨漢戦士レベル）', value: 4000, tag: 'ELITE' },
  'power-8000': {
    label: '戦闘力 8,000↑（8000以上だ…！覚醒レベル）',
    value: 8500,
    displayOverride: '8,000↑',
    tag: 'OVER 8,000!!',
  },
  'power-18000': { label: '戦闘力 18,000（地球襲来エリートレベル）', value: 18000, tag: 'HIGH ELITE' },
  'power-120000': { label: '戦闘力 120,000（特戦隊隊長レベル）', value: 120000, tag: 'CAPTAIN' },
  'power-530000': { label: '戦闘力 530,000（第一形態レベル）', value: 530000, tag: 'EMPEROR-1' },
  'power-1000000': {
    label: '戦闘力 1,000,000↑（計測限界突破レベル）',
    value: 1000000,
    displayOverride: '1,000,000↑',
    tag: 'LIMIT BREAK',
  },
  'power-150000000': {
    label: '戦闘力 150,000,000（伝説の超覚醒レベル）',
    value: 150000000,
    tag: 'LEGENDARY!!',
  },
  custom: { label: '自由入力（好きな戦闘力・名前を指定）', value: null, tag: 'CUSTOM' },
};

let reusableScanCanvas = null;

/**
 * セグメンテーション結果（DeepLab-v3）から人物(15)と動物(3,8,10,12,13,17)の塊を分離し、
 * 最大 maxBoxes 個の正規化バウンディングボックスを返す純粋関数。
 */
export function detectSubjectBoxesFromClasses(
  categoryData,
  maskWidth,
  maskHeight,
  maxBoxes = 3
) {
  const width = Math.max(1, Math.round(maskWidth));
  const height = Math.max(1, Math.round(maskHeight));
  const total = width * height;
  const visited = new Uint8Array(total);
  const boxes = [];
  const queue = new Int32Array(total);

  for (let i = 0; i < total; i++) {
    if (visited[i]) continue;
    const cls = categoryData[i];
    const isTarget = cls === 15 || BIZARRE_ANIMAL_CLASSES.has(cls);
    if (!isTarget) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    visited[i] = 1;

    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let count = 0;
    let animalVotes = 0;
    const classCounts = new Map();

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx - x) / width;
      const c = categoryData[idx];
      count += 1;
      if (BIZARRE_ANIMAL_CLASSES.has(c)) {
        animalVotes += 1;
      }
      classCounts.set(c, (classCounts.get(c) || 0) + 1);

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x + 1 < width ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y + 1 < height ? idx + width : -1,
      ];
      for (const nIdx of neighbors) {
        if (nIdx >= 0 && !visited[nIdx]) {
          const nc = categoryData[nIdx];
          if (nc === 15 || BIZARRE_ANIMAL_CLASSES.has(nc)) {
            visited[nIdx] = 1;
            queue[tail++] = nIdx;
          }
        }
      }
    }

    const areaRatio = count / total;
    if (areaRatio < 0.005) {
      continue;
    }

    let dominantClass = 15;
    let bestVotes = -1;
    for (const [k, v] of classCounts.entries()) {
      if (v > bestVotes) {
        bestVotes = v;
        dominantClass = k;
      }
    }

    const isAnimal = BIZARRE_ANIMAL_CLASSES.has(dominantClass) || animalVotes > count * 0.45;
    boxes.push({
      xNorm: minX / width,
      yNorm: minY / height,
      wNorm: (maxX - minX + 1) / width,
      hNorm: (maxY - minY + 1) / height,
      classId: dominantClass,
      label: CLASS_LABEL_MAP[dominantClass] || (isAnimal ? 'ANIMAL // TARGET' : 'HUMAN // TARGET'),
      isAnimal,
      areaRatio,
    });
  }

  boxes.sort((a, b) => b.areaRatio - a.areaRatio);
  return boxes.slice(0, maxBoxes);
}

/**
 * スカウターの計測状態（0.0〜0.9秒は高速カウントアップ、0.9秒以降はロックオン確定）を算出する純粋関数。
 */
export function computeScouterReadoutState(localSec, options = {}) {
  const {
    presetKey = 'auto',
    customPower = 530000,
    customLabel = '',
    box = null,
    targetIndex = 0,
  } = options;

  const safeLocal = Math.max(0, Number(localSec) || 0);
  const scanDuration = 0.9;
  const preset = SCOUTER_POWER_PRESETS[presetKey] || SCOUTER_POWER_PRESETS.auto;

  let finalValue = 5;
  let finalDisplay = '5';
  let tag = preset.tag;

  if (presetKey === 'custom') {
    const parsed = Math.max(1, Math.round(Number(customPower) || 530000));
    finalValue = parsed;
    finalDisplay = parsed.toLocaleString('en-US');
    tag = customLabel?.trim() ? customLabel.trim().toUpperCase().slice(0, 18) : 'CUSTOM TARGET';
  } else if (preset.value !== null) {
    finalValue = preset.value;
    finalDisplay = preset.displayOverride || preset.value.toLocaleString('en-US');
  } else {
    // AI自動推定：動物（犬/猫等）は 3〜18、人物は画面占有率に応じて 5〜530,000 のレンジで算出
    const area = box?.areaRatio ?? 0.25;
    if (box?.isAnimal) {
      finalValue = Math.max(2, Math.round(3 + area * 35));
    } else if (targetIndex === 0) {
      finalValue = area > 0.35 ? 18000 : area > 0.18 ? 4000 : area > 0.08 ? 408 : 5;
    } else {
      finalValue = Math.max(5, Math.round(5 + area * 1200));
    }
    finalDisplay = finalValue.toLocaleString('en-US');
    tag = box?.isAnimal ? 'ANIMAL BIO' : finalValue >= 8000 ? 'HIGH ENERGY!!' : 'HUMAN BIO';
  }

  if (safeLocal < scanDuration) {
    const progress = safeLocal / scanDuration;
    const tick = Math.floor(safeLocal * 28) + targetIndex * 7;
    const digits = String(finalValue).length;
    const maxRand = Math.pow(10, Math.min(8, Math.max(2, digits)));
    const spinVal = Math.max(
      1,
      Math.floor(((Math.abs(Math.sin(tick * 19.7 + 3.1)) * 0.85 + 0.1) * maxRand))
    );
    return {
      phase: 'scanning',
      progress,
      displayPower: spinVal.toLocaleString('en-US'),
      numericPower: spinVal,
      tag: 'ANALYZING...',
      isHighThreat: false,
    };
  }

  return {
    phase: 'locked',
    progress: 1,
    displayPower: finalDisplay,
    numericPower: finalValue,
    tag,
    isHighThreat: finalValue >= 8000,
  };
}

function getReusableCanvas(existing, width, height) {
  const canvas = existing || document.createElement('canvas');
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas;
}

/**
 * DeepLab-v3 を用いてフレーム内の人物・動物のターゲットボックス一覧を検出する。
 */
export async function segmentFrameToSubjectBoxes(sourceElement, crop, targetWidth, targetHeight) {
  if (!sourceElement || !crop || !targetWidth || !targetHeight) {
    return [];
  }
  const { deeplabSegmenter } = await ensureBizarreSegmenterReady();
  if (!deeplabSegmenter) {
    return [];
  }

  const maxEdge = 256;
  const aspect = targetWidth / targetHeight;
  const segW = aspect >= 1 ? maxEdge : Math.max(64, Math.round(maxEdge * aspect));
  const segH = aspect >= 1 ? Math.max(64, Math.round(maxEdge / aspect)) : maxEdge;

  reusableScanCanvas = getReusableCanvas(reusableScanCanvas, segW, segH);
  const segCtx = reusableScanCanvas.getContext('2d', { willReadFrequently: true });
  if (!segCtx) {
    return [];
  }

  segCtx.drawImage(sourceElement, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, segW, segH);
  const result = deeplabSegmenter.segment(reusableScanCanvas);

  try {
    const mask = result?.categoryMask;
    if (!mask) {
      return [];
    }
    const rawClasses = mask.getAsUint8Array();
    return detectSubjectBoxesFromClasses(rawClasses, mask.width, mask.height, 3);
  } finally {
    result?.close?.();
  }
}

/**
 * ギャラリーカード用のサンプルターゲットボックスを生成する。
 */
export function createSyntheticScouterBoxes() {
  return [
    {
      xNorm: 0.28,
      yNorm: 0.28,
      wNorm: 0.44,
      hNorm: 0.5,
      classId: 15,
      label: 'HUMAN // TARGET',
      isAnimal: false,
      areaRatio: 0.22,
    },
  ];
}

function drawCornerBrackets(ctx, x, y, w, h, len, color, lineWidth) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(x, y + len);
  ctx.lineTo(x, y);
  ctx.lineTo(x + len, y);

  ctx.moveTo(x + w - len, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + len);

  ctx.moveTo(x, y + h - len);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x + len, y + h);

  ctx.moveTo(x + w - len, y + h);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w, y + h - len);
  ctx.stroke();
}

/**
 * 1フレーム分の AI ロボット視界 HUD ＋ スカウター戦闘力計測オーバーレイを描画する。
 */
export function drawScouterHudComposite(
  ctx,
  sourceElement,
  crop,
  width,
  height,
  localSec,
  options = {}
) {
  const {
    themeKey = 'ai-emerald',
    presetKey = 'auto',
    customPower = 530000,
    customLabel = '',
    subjectBoxes = [],
  } = options;

  const theme = SCOUTER_THEMES[themeKey] || SCOUTER_THEMES['ai-emerald'];

  // 1) 元映像を描画し、その上に AI ロボット光学センサーのティントと走査線を重ねる
  ctx.drawImage(sourceElement, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);

  ctx.save();
  ctx.fillStyle = theme.tint;
  ctx.fillRect(0, 0, width, height);

  // 微細な走査線（AIロボのカメラ視界感）
  ctx.fillStyle = 'rgba(0, 0, 0, 0.14)';
  const stepY = Math.max(4, Math.round(height * 0.008));
  for (let sy = 0; sy < height; sy += stepY * 2) {
    ctx.fillRect(0, sy, width, Math.max(1, Math.round(stepY * 0.45)));
  }

  // 上下に走る光学スキャンビーム
  const scanY = ((localSec * 0.45) % 1) * height;
  const beamGrad = ctx.createLinearGradient(0, scanY - height * 0.04, 0, scanY + height * 0.04);
  beamGrad.addColorStop(0, 'rgba(0,0,0,0)');
  beamGrad.addColorStop(0.5, theme.primary + '44');
  beamGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = beamGrad;
  ctx.fillRect(0, scanY - height * 0.04, width, height * 0.08);

  // 2) 外周の AI ロボット HUD フレーム＆テレメトリ表示
  const pad = Math.round(width * 0.04);
  drawCornerBrackets(ctx, pad, pad, width - pad * 2, height - pad * 2, Math.round(width * 0.07), theme.primary, Math.max(2, Math.round(width * 0.004)));

  const monoSmall = Math.max(10, Math.round(width * 0.025));
  ctx.font = `700 ${monoSmall}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillStyle = theme.bright;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('AI-UNIT // OPTICAL NEURAL HUD', pad + 10, pad + 8);
  ctx.fillText(`SCAN T+${localSec.toFixed(2)}S`, pad + 10, pad + 12 + monoSmall);

  ctx.textAlign = 'right';
  ctx.fillStyle = theme.primary;
  ctx.fillText(subjectBoxes.length > 0 ? `TARGETS: ${subjectBoxes.length}` : 'SCANNING AREA...', width - pad - 10, pad + 8);

  // 3) 検出された人物・動物（未検出時は中央仮ターゲット）に戦闘力スカウターを描画
  const activeBoxes =
    Array.isArray(subjectBoxes) && subjectBoxes.length > 0
      ? subjectBoxes
      : [
          {
            xNorm: 0.25,
            yNorm: 0.28,
            wNorm: 0.5,
            hNorm: 0.44,
            label: 'SECTOR // SCAN',
            isAnimal: false,
            areaRatio: 0.2,
            isFallback: true,
          },
        ];

  activeBoxes.forEach((box, idx) => {
    const bx = Math.round(box.xNorm * width);
    const by = Math.round(box.yNorm * height);
    const bw = Math.max(Math.round(width * 0.18), Math.round(box.wNorm * width));
    const bh = Math.max(Math.round(height * 0.14), Math.round(box.hNorm * height));

    const readout = computeScouterReadoutState(localSec, {
      presetKey: idx === 0 ? presetKey : 'auto',
      customPower,
      customLabel,
      box,
      targetIndex: idx,
    });

    const boxColor =
      readout.phase === 'locked' && readout.isHighThreat ? theme.alert : theme.primary;

    // ターゲット枠と中心照準レティクル
    drawCornerBrackets(ctx, bx, by, bw, bh, Math.max(14, Math.round(Math.min(bw, bh) * 0.2)), boxColor, Math.max(2, Math.round(width * 0.005)));

    const cx = bx + bw * 0.5;
    const cy = by + bh * 0.35;
    const reticleR = Math.max(10, Math.round(width * 0.032));
    ctx.strokeStyle = boxColor;
    ctx.lineWidth = Math.max(1.5, Math.round(width * 0.003));
    ctx.beginPath();
    ctx.arc(cx, cy, reticleR, 0, Math.PI * 2);
    ctx.stroke();

    // 戦闘力パネル（ターゲット枠の上または内側上部に配置）
    const panelW = Math.min(width - pad * 2, Math.max(Math.round(width * 0.46), bw));
    const panelH = Math.round(width * 0.13);
    const px = Math.min(width - pad - panelW, Math.max(pad, bx));
    const py = by - panelH - 8 > pad + monoSmall * 2.5 ? by - panelH - 8 : Math.min(height - pad - panelH, by + 8);

    ctx.fillStyle = theme.panelBg;
    ctx.fillRect(px, py, panelW, panelH);
    ctx.strokeStyle = boxColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px, py, panelW, panelH);

    const tagFont = Math.max(9, Math.round(width * 0.022));
    ctx.font = `700 ${tagFont}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = theme.bright;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${box.label} [${readout.tag}]`, px + 8, py + 6, panelW - 16);

    const numFont = Math.max(15, Math.round(width * 0.048));
    ctx.font = `700 ${numFont}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = boxColor;
    ctx.fillText(`POWER ${readout.displayPower}`, px + 8, py + 10 + tagFont, panelW - 16);
  });

  ctx.restore();
}
