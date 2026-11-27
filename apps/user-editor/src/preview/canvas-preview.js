import {
  buildTimelineSegments,
  drawCutFrame,
  resolveCutAtTime,
} from '../../lib/video-engine.js';

const PREVIEW_WIDTH = 360;
const PREVIEW_HEIGHT = 640;

/**
 * STEP 4：重いMP4書き出しの前にCanvas上でサッと動きとテロップを確認・微調整できる軽量プレビューを提供する。
 */
export function initPreviewSection(container, template, state) {
  container.innerHTML = `
    <div class="preview-layout">
      <div class="preview-stage-wrap">
        <canvas id="preview-canvas" width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" class="preview-canvas"></canvas>
        <div class="preview-controls">
          <button type="button" id="preview-play-btn" class="btn btn-primary">再生 / 一時停止</button>
          <button type="button" id="preview-restart-btn" class="btn btn-secondary">最初から</button>
        </div>
        <div class="timeline-status">
          <span id="preview-time-label">0.0s / 0.0s</span>
          <input type="range" id="preview-scrub" min="0" max="5" step="0.05" value="0" aria-label="プレビュー再生位置" />
        </div>
      </div>
      <div class="caption-editor-wrap">
        <h3>テロップ文言の微調整</h3>
        <p class="caption-hint">文字を変更するとプレビューへ即座に反映されます。</p>
        <div id="caption-inputs" class="caption-inputs"></div>
      </div>
    </div>
  `;

  const canvas = container.querySelector('#preview-canvas');
  const ctx = canvas.getContext('2d');
  const playBtn = container.querySelector('#preview-play-btn');
  const restartBtn = container.querySelector('#preview-restart-btn');
  const timeLabel = container.querySelector('#preview-time-label');
  const scrub = container.querySelector('#preview-scrub');
  const captionInputs = container.querySelector('#caption-inputs');

  const { segments, totalDurationSec } = buildTimelineSegments(template.cuts);
  scrub.max = String(totalDurationSec);

  template.cuts.forEach((cut) => {
    if (!cut.textOverlay) {
      return;
    }
    state.textByCutId[cut.id] = cut.textOverlay.defaultText || '';

    const field = document.createElement('label');
    field.className = 'caption-field';
    field.innerHTML = `
      <span>${escapeHtml(cut.label)}（最大${cut.textOverlay.maxLength}文字）</span>
      <input
        type="text"
        maxlength="${cut.textOverlay.maxLength}"
        value="${escapeHtml(state.textByCutId[cut.id])}"
        placeholder="${escapeHtml(cut.textOverlay.placeholder)}"
      />
    `;
    const input = field.querySelector('input');
    input.addEventListener('input', () => {
      state.textByCutId[cut.id] = input.value;
      renderAt(currentSec);
    });
    captionInputs.appendChild(field);
  });

  let currentSec = 0;
  let isPlaying = false;
  let rafId = null;
  let lastTimestamp = 0;
  let activeVideoId = null;

  function syncVideoForPreview(cut, mediaEntry, localSec) {
    if (!mediaEntry || mediaEntry.mediaType !== 'video') {
      pauseAllVideos();
      activeVideoId = null;
      return;
    }

    const targetTime = Math.min(
      Math.max(0, mediaEntry.durationSec - 0.05),
      (mediaEntry.trimStartSec || 0) + localSec
    );
    const video = mediaEntry.element;

    if (activeVideoId !== cut.id) {
      pauseAllVideos(cut.id);
      activeVideoId = cut.id;
      if (Math.abs(video.currentTime - targetTime) > 0.12) {
        video.currentTime = targetTime;
      }
      if (isPlaying && video.paused) {
        video.play().catch(() => {});
      }
    } else if (!isPlaying) {
      if (!video.paused) {
        video.pause();
      }
      if (Math.abs(video.currentTime - targetTime) > 0.08) {
        video.currentTime = targetTime;
      }
    } else if (video.paused) {
      video.play().catch(() => {});
    }
  }

  function pauseAllVideos(exceptCutId = null) {
    for (const [cutId, entry] of Object.entries(state.mediaByCutId)) {
      if (cutId !== exceptCutId && entry?.mediaType === 'video' && !entry.element.paused) {
        entry.element.pause();
      }
    }
  }

  function renderAt(timeSec) {
    currentSec = Math.max(0, Math.min(totalDurationSec, timeSec));
    const resolved = resolveCutAtTime(segments, currentSec);
    if (!resolved) {
      return;
    }

    const { segment, localSec } = resolved;
    const mediaEntry = state.mediaByCutId[segment.cut.id];
    syncVideoForPreview(segment.cut, mediaEntry, localSec);
    drawCutFrame(
      ctx,
      segment.cut,
      mediaEntry,
      localSec,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
      state.textByCutId[segment.cut.id]
    );

    timeLabel.textContent = `${currentSec.toFixed(1)}s / ${totalDurationSec.toFixed(1)}s`;
    scrub.value = currentSec.toFixed(2);
  }

  function tick(timestamp) {
    if (!isPlaying) {
      return;
    }
    if (!lastTimestamp) {
      lastTimestamp = timestamp;
    }
    const deltaSec = Math.min(0.1, (timestamp - lastTimestamp) / 1000);
    lastTimestamp = timestamp;
    currentSec += deltaSec;

    if (currentSec >= totalDurationSec) {
      currentSec = 0;
    }

    renderAt(currentSec);
    rafId = requestAnimationFrame(tick);
  }

  function stopPlayback() {
    isPlaying = false;
    lastTimestamp = 0;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    pauseAllVideos();
    playBtn.textContent = '再生する';
  }

  function startPlayback() {
    isPlaying = true;
    lastTimestamp = 0;
    playBtn.textContent = '一時停止';
    rafId = requestAnimationFrame(tick);
  }

  playBtn.addEventListener('click', () => {
    if (isPlaying) {
      stopPlayback();
    } else {
      startPlayback();
    }
  });

  restartBtn.addEventListener('click', () => {
    currentSec = 0;
    renderAt(0);
  });

  scrub.addEventListener('input', () => {
    stopPlayback();
    renderAt(Number(scrub.value));
  });

  renderAt(0);

  return {
    refresh: () => renderAt(currentSec),
    stop: stopPlayback,
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
