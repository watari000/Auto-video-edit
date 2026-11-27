import {
  buildTimelineSegments,
  drawCutFrame,
  resolveCutAtTime,
} from '../../lib/video-engine.js';

const PREVIEW_WIDTH = 360;
const PREVIEW_HEIGHT = 640;

/**
 * STEP 03〜モニター：9:16 シネマモニターでの軽量プレビューと、テロップ文言調整コンソールを提供する。
 */
export function initPreviewSection(previewContainer, template, state, captionsContainer) {
  previewContainer.innerHTML = `
    <div class="monitor-shell">
      <div class="monitor-hud-top">
        <span class="monitor-hud-rec"><span class="rec-dot" aria-hidden="true"></span>MONITOR 9:16</span>
        <span id="preview-hud-time">00.0 / 00.0s</span>
      </div>
      <div class="monitor-bezel">
        <canvas id="preview-canvas" width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" class="preview-canvas"></canvas>
      </div>
      <div class="monitor-controls${template.allowSourceAudio ? ' has-audio' : ''}">
        <button type="button" id="preview-play-btn" class="btn btn-primary">再生する</button>
        <button type="button" id="preview-restart-btn" class="btn btn-secondary">先頭へ</button>
        ${template.allowSourceAudio ? '<button type="button" id="preview-audio-btn" class="btn btn-secondary" aria-pressed="true">音声: ON</button>' : ''}
      </div>
      <div class="timeline-scrub-row">
        <input type="range" id="preview-scrub" class="scrub-range" min="0" max="5" step="0.05" value="0" aria-label="プレビュー再生位置" />
        <div class="scrub-time">
          <span>TIMELINE SCRUB</span>
          <span id="preview-time-label">0.0s / 0.0s</span>
        </div>
      </div>
    </div>
  `;

  const targetCaptionHost = captionsContainer || previewContainer;
  const captionWrapper = document.createElement('div');
  captionWrapper.className = 'caption-console';
  captionWrapper.innerHTML = `
    <p class="caption-hint">入力した文言は右側のシネマモニターへ即座に反映されます。</p>
    <div id="caption-inputs" class="caption-inputs"></div>
  `;

  if (captionsContainer) {
    captionsContainer.innerHTML = '';
    captionsContainer.appendChild(captionWrapper);
  } else {
    previewContainer.appendChild(captionWrapper);
  }

  const canvas = previewContainer.querySelector('#preview-canvas');
  const ctx = canvas.getContext('2d');
  const playBtn = previewContainer.querySelector('#preview-play-btn');
  const restartBtn = previewContainer.querySelector('#preview-restart-btn');
  const audioToggleBtn = previewContainer.querySelector('#preview-audio-btn');
  const hudTime = previewContainer.querySelector('#preview-hud-time');
  const timeLabel = previewContainer.querySelector('#preview-time-label');
  const scrub = previewContainer.querySelector('#preview-scrub');
  const captionInputs = captionWrapper.querySelector('#caption-inputs');

  let { segments, totalDurationSec } = buildTimelineSegments(template.cuts);
  scrub.max = String(totalDurationSec);
  let previewAudioEnabled = Boolean(template.allowSourceAudio);

  if (audioToggleBtn) {
    audioToggleBtn.addEventListener('click', () => {
      previewAudioEnabled = !previewAudioEnabled;
      audioToggleBtn.setAttribute('aria-pressed', String(previewAudioEnabled));
      audioToggleBtn.textContent = previewAudioEnabled ? '音声: ON' : '音声: OFF';
      for (const entry of Object.values(state.mediaByCutId)) {
        if (entry?.mediaType === 'video') {
          entry.element.muted = !(isPlaying && previewAudioEnabled);
        }
      }
    });
  }

  template.cuts.forEach((cut) => {
    if (!cut.textOverlay) {
      return;
    }
    state.textByCutId[cut.id] = cut.textOverlay.defaultText || '';

    const isKinetic = cut.textOverlay.style === 'kinetic';
    const field = document.createElement('label');
    field.className = 'caption-field';
    field.innerHTML = `
      <span class="caption-field-head">
        <span>${escapeHtml(cut.label)}</span>
        <span class="caption-pos-tag">POS: ${escapeHtml(cut.textOverlay.position.toUpperCase())} / MAX ${cut.textOverlay.maxLength}</span>
      </span>
      <input
        type="text"
        maxlength="${cut.textOverlay.maxLength}"
        value="${escapeHtml(state.textByCutId[cut.id])}"
        placeholder="${escapeHtml(cut.textOverlay.placeholder)}"
      />
      ${isKinetic ? '<span class="caption-kinetic-note">スペース区切りで1語ずつ出現・*単語* で色とサイズを強調</span>' : ''}
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
      video.muted = !(isPlaying && previewAudioEnabled);
      if (isPlaying && video.paused) {
        video.play().catch(() => {});
      }
    } else if (!isPlaying) {
      video.muted = true;
      if (!video.paused) {
        video.pause();
      }
      if (Math.abs(video.currentTime - targetTime) > 0.08) {
        video.currentTime = targetTime;
      }
    } else {
      video.muted = !previewAudioEnabled;
      if (video.paused) {
        video.play().catch(() => {});
      }
    }
  }

  function pauseAllVideos(exceptCutId = null) {
    for (const [cutId, entry] of Object.entries(state.mediaByCutId)) {
      if (cutId !== exceptCutId && entry?.mediaType === 'video') {
        entry.element.muted = true;
        if (!entry.element.paused) {
          entry.element.pause();
        }
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

    const formatted = `${currentSec.toFixed(1)}s / ${totalDurationSec.toFixed(1)}s`;
    timeLabel.textContent = formatted;
    hudTime.textContent = `${currentSec.toFixed(1).padStart(4, '0')} / ${totalDurationSec.toFixed(1)}s`;
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
    refresh: () => {
      const updated = buildTimelineSegments(template.cuts);
      segments = updated.segments;
      totalDurationSec = updated.totalDurationSec;
      scrub.max = String(totalDurationSec);
      renderAt(Math.min(currentSec, totalDurationSec));
    },
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
