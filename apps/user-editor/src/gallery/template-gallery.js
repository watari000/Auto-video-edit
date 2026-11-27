import { loadTemplate } from '../../lib/template-loader.js';
import {
  buildTimelineSegments,
  drawCutFrame,
  resolveCutAtTime,
} from '../../lib/video-engine.js';
import { createSyntheticSubjectMask } from '../../lib/bizarre-shift-engine.js';

const SAMPLE_WIDTH = 180;
const SAMPLE_HEIGHT = 320;
const FRAME_INTERVAL_MS = 50; // ~20fpsでバッテリーとiOS Safariの描画負荷を抑える

const SCENE_PALETTES = [
  ['#3b281e', '#a46b46', '#f2d3b3'],
  ['#16222e', '#355c7d', '#9dc6e0'],
  ['#2b241d', '#7b5e43', '#e5cba8'],
  ['#1d2a24', '#4b7a62', '#cbe5d4'],
  ['#2a1c28', '#7d4466', '#f0b8d4'],
  ['#1c1e26', '#4a5568', '#cbd5e1'],
];

function paintSyntheticBackdrop(ctx, width, height, templateIndex, cutIndex) {
  const [c1, c2, c3] = SCENE_PALETTES[(templateIndex * 3 + cutIndex) % SCENE_PALETTES.length];
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, c1);
  grad.addColorStop(0.55, c2);
  grad.addColorStop(1, c3);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Sobel線画抽出やフラッシュカットでも視認しやすい幾何モチーフを描画する
  ctx.save();
  const shift = ((cutIndex * 29 + templateIndex * 17) % 40) - 20;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.beginPath();
  ctx.arc(width * 0.5 + shift, height * 0.38, width * 0.24, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.lineWidth = 2;
  ctx.strokeRect(width * 0.18, height * 0.24, width * 0.64, height * 0.48);

  ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
  ctx.fillRect(0, height * 0.68, width, height * 0.32);
  ctx.restore();
}

function createSampleCutMedia(cut, cutIndex, templateIndex, onAssetUpdated) {
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = SAMPLE_WIDTH;
  sampleCanvas.height = SAMPLE_HEIGHT;
  const ctx = sampleCanvas.getContext('2d');

  if (ctx) {
    paintSyntheticBackdrop(ctx, SAMPLE_WIDTH, SAMPLE_HEIGHT, templateIndex, cutIndex);
  }

  const entry = {
    mediaType: 'image',
    width: SAMPLE_WIDTH,
    height: SAMPLE_HEIGHT,
    element: sampleCanvas,
  };

  const svgUrl = cut.shootingGuide?.resolvedSilhouetteUrl;
  if (svgUrl && typeof Image !== 'undefined') {
    const img = new Image();
    img.onload = () => {
      if (!ctx || sampleCanvas.width === 0) {
        return;
      }
      paintSyntheticBackdrop(ctx, SAMPLE_WIDTH, SAMPLE_HEIGHT, templateIndex, cutIndex);
      ctx.save();
      ctx.globalAlpha = 0.72;
      ctx.drawImage(img, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
      ctx.restore();
      // Sketch to Reality の線画キャッシュがある場合は最新サンプルで再生成させる
      entry._sketchCache = null;
      onAssetUpdated?.();
    };
    img.src = svgUrl;
  }

  return entry;
}

/**
 * テンプレート一覧（ギャラリー画面）を描画し、各カード上で実演出のライブプレビューを再生する。
 */
export function renderGalleryView(container, catalogItems, activeTemplateId, onSelectTemplate) {
  container.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'gallery-grid';
  container.appendChild(grid);

  let disposed = false;
  let rafId = null;
  const cardStates = [];

  const observer =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const targetState = cardStates.find((s) => s.card === entry.target);
              if (targetState) {
                targetState.isVisible = entry.isIntersecting;
              }
            }
          },
          { threshold: 0.05 }
        )
      : null;

  catalogItems.forEach((item, index) => {
    const isActive = item.id === activeTemplateId;
    const card = document.createElement('article');
    card.className = `gallery-card${isActive ? ' is-active' : ''}`;

    card.innerHTML = `
      <div class="gallery-cover">
        <span class="gallery-index">${String(index + 1).padStart(2, '0')}</span>
        <span class="gallery-live-badge" data-role="live-badge">LOADING</span>
        <canvas
          width="${SAMPLE_WIDTH}"
          height="${SAMPLE_HEIGHT}"
          class="gallery-preview-canvas"
          title="クリックでサンプル再生を一時停止 / 再開"
          aria-label="${escapeHtml(item.title)}のライブサンプルプレビュー"
        ></canvas>
      </div>
      <div class="gallery-card-body">
        <div class="gallery-meta-row">
          <span class="gallery-category">${escapeHtml(item.category)}</span>
          ${isActive ? '<span class="gallery-active-tag">SELECTED</span>' : ''}
        </div>
        <h2 class="gallery-title">${escapeHtml(item.title)}</h2>
        <p class="gallery-summary">${escapeHtml(item.summary)}</p>
        <div class="gallery-specs">
          <span class="spec-tag">${item.cutCount} CUTS / ${Number(item.durationSec).toFixed(1)}S</span>
          <span class="spec-tag">${escapeHtml(item.bpmLabel)}</span>
          <span class="spec-tag is-accent">${escapeHtml(item.filterTag)}</span>
        </div>
        <button type="button" class="btn btn-primary gallery-select-btn">
          ${isActive ? 'このテンプレートを開き直す' : 'このテンプレートで編集する'}
        </button>
      </div>
    `;

    const canvas = card.querySelector('.gallery-preview-canvas');
    const ctx = canvas.getContext('2d');
    const liveBadge = card.querySelector('[data-role="live-badge"]');
    const selectBtn = card.querySelector('.gallery-select-btn');

    const cardState = {
      card,
      canvas,
      ctx,
      liveBadge,
      isVisible: true,
      paused: false,
      ready: false,
      elapsedSec: (index * 0.45) % Math.max(1, Number(item.durationSec) || 1),
      segments: [],
      totalDurationSec: Number(item.durationSec) || 5,
      sampleMediaByCutId: {},
    };

    canvas.addEventListener('click', () => {
      if (!cardState.ready) {
        return;
      }
      cardState.paused = !cardState.paused;
      liveBadge.textContent = cardState.paused
        ? 'PAUSED'
        : `LIVE ${cardState.elapsedSec.toFixed(1)}s`;
      liveBadge.classList.toggle('is-paused', cardState.paused);
    });

    selectBtn.addEventListener('click', () => {
      onSelectTemplate(item.id);
    });

    grid.appendChild(card);
    cardStates.push(cardState);
    observer?.observe(card);

    loadTemplate(item.resolvedTemplateUrl)
      .then((template) => {
        if (disposed) {
          return;
        }
        const timeline = buildTimelineSegments(template.cuts);
        cardState.segments = timeline.segments;
        cardState.totalDurationSec = timeline.totalDurationSec;

        template.cuts.forEach((cut, cutIdx) => {
          const sampleEntry = createSampleCutMedia(cut, cutIdx, index, () => {
            if (!disposed && cardState.paused) {
              drawCardFrame(cardState);
            }
          });
          if (cut.effect?.motion === 'bizarre-shift') {
            sampleEntry.subjectMask = createSyntheticSubjectMask(SAMPLE_WIDTH, SAMPLE_HEIGHT);
            sampleEntry.bizarrePalette = 'golden-bizarre';
            sampleEntry.bizarreTouch = 'anime-ink';
            sampleEntry.bizarreTriggerSec = 2.0;
          }
          cardState.sampleMediaByCutId[cut.id] = sampleEntry;
        });

        cardState.ready = true;
        drawCardFrame(cardState);
      })
      .catch(() => {
        if (!disposed) {
          liveBadge.textContent = 'PREVIEW ERR';
        }
      });
  });

  function drawCardFrame(cardState) {
    if (!cardState.ctx || !cardState.ready || cardState.segments.length === 0) {
      return;
    }
    const resolved = resolveCutAtTime(cardState.segments, cardState.elapsedSec);
    if (!resolved) {
      return;
    }
    const { segment, localSec } = resolved;
    const mediaEntry = cardState.sampleMediaByCutId[segment.cut.id];
    drawCutFrame(
      cardState.ctx,
      segment.cut,
      mediaEntry,
      localSec,
      SAMPLE_WIDTH,
      SAMPLE_HEIGHT,
      segment.cut.textOverlay?.defaultText
    );
    cardState.liveBadge.textContent = cardState.paused
      ? 'PAUSED'
      : `LIVE ${cardState.elapsedSec.toFixed(1)}s`;
  }

  let lastDrawMs = 0;
  let lastTickMs = 0;

  function tick(nowMs) {
    if (disposed) {
      return;
    }
    if (!lastTickMs) {
      lastTickMs = nowMs;
      lastDrawMs = nowMs;
    }

    if (nowMs - lastDrawMs >= FRAME_INTERVAL_MS) {
      const deltaSec = Math.min(0.15, (nowMs - lastTickMs) / 1000);
      lastTickMs = nowMs;
      lastDrawMs = nowMs;

      for (const cardState of cardStates) {
        if (!cardState.ready || cardState.paused || !cardState.isVisible) {
          continue;
        }
        cardState.elapsedSec = (cardState.elapsedSec + deltaSec) % cardState.totalDurationSec;
        drawCardFrame(cardState);
      }
    }

    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  return {
    stop() {
      disposed = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      observer?.disconnect();
      for (const cardState of cardStates) {
        for (const entry of Object.values(cardState.sampleMediaByCutId)) {
          if (entry?.element) {
            entry.element.width = 0;
            entry.element.height = 0;
          }
          entry._sketchCache = null;
        }
        cardState.sampleMediaByCutId = {};
      }
    },
  };
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
