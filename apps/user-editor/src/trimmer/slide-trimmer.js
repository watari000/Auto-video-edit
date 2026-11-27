import { inspectMediaFile } from '../precheck/media-precheck.js';

/**
 * STEP 2〜3：カットごとの素材選択、プリチェック警告表示、長尺動画のスライド式トリミングUIを提供する。
 */
export function renderTrimmerSection(container, template, state, resourcePool, onStateChange) {
  container.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'cut-editor-list';

  template.cuts.forEach((cut) => {
    const card = document.createElement('article');
    card.className = 'cut-editor-card';
    card.dataset.cutId = cut.id;

    const header = document.createElement('div');
    header.className = 'cut-editor-header';
    header.innerHTML = `
      <div>
        <h3>${escapeHtml(cut.label)}</h3>
        <p class="cut-sub">使用時間：<strong>${cut.durationSec.toFixed(1)}秒</strong>（写真・動画どちらもOK）</p>
      </div>
      <span class="status-pill" data-role="status-badge">未選択</span>
    `;

    const fileLabel = document.createElement('label');
    fileLabel.className = 'file-picker-btn';
    fileLabel.textContent = 'カメラロールから素材を選ぶ';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'video/*,image/*';
    fileInput.className = 'sr-only';
    fileLabel.appendChild(fileInput);

    const feedbackBox = document.createElement('div');
    feedbackBox.className = 'feedback-area';

    const trimBox = document.createElement('div');
    trimBox.className = 'trim-box hidden';

    card.appendChild(header);
    card.appendChild(fileLabel);
    card.appendChild(feedbackBox);
    card.appendChild(trimBox);
    list.appendChild(card);

    fileInput.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      const statusBadge = card.querySelector('[data-role="status-badge"]');
      statusBadge.textContent = '確認中...';
      statusBadge.className = 'status-pill is-loading';
      feedbackBox.innerHTML = '';

      try {
        const previousEntry = state.mediaByCutId[cut.id];
        const inspected = await inspectMediaFile(file, cut.durationSec, resourcePool);

        if (previousEntry?.objectUrl) {
          resourcePool.revokeUrl(previousEntry.objectUrl);
        }

        state.mediaByCutId[cut.id] = inspected;
        statusBadge.textContent = `${inspected.mediaType === 'video' ? '動画' : '写真'} OK`;
        statusBadge.className = 'status-pill is-ready';
        fileLabel.childNodes[0].textContent = `素材を変更する（${inspected.fileName}）`;

        renderPrecheckMessages(feedbackBox, inspected.warnings);
        renderSlideTrimmer(trimBox, cut, inspected, onStateChange);
        onStateChange();
      } catch (error) {
        statusBadge.textContent = '読み込みエラー';
        statusBadge.className = 'status-pill is-error';
        feedbackBox.innerHTML = `<p class="notice notice-error">${escapeHtml(error.message)}</p>`;
      }
    });
  });

  container.appendChild(list);
}

function renderPrecheckMessages(container, warnings) {
  if (!warnings || warnings.length === 0) {
    container.innerHTML = '<p class="notice notice-ok">向き・明るさともに良好です！</p>';
    return;
  }

  container.innerHTML = warnings
    .map((w) => `<p class="notice notice-tip">${escapeHtml(w.message)}</p>`)
    .join('');
}

function renderSlideTrimmer(trimBox, cut, mediaEntry, onStateChange) {
  trimBox.innerHTML = '';

  if (mediaEntry.mediaType !== 'video') {
    trimBox.classList.add('hidden');
    return;
  }

  const maxStart = Math.max(0, mediaEntry.durationSec - cut.durationSec);
  if (maxStart <= 0.05) {
    trimBox.classList.remove('hidden');
    trimBox.innerHTML = `<p class="trim-note">動画の長さ（${mediaEntry.durationSec.toFixed(1)}秒）をそのまま使用します。</p>`;
    return;
  }

  trimBox.classList.remove('hidden');
  mediaEntry.trimStartSec = Math.min(mediaEntry.trimStartSec || 0, maxStart);

  const infoRow = document.createElement('div');
  infoRow.className = 'trim-info-row';

  const label = document.createElement('span');
  label.className = 'trim-label';

  const previewMini = document.createElement('video');
  previewMini.className = 'trim-mini-video';
  previewMini.src = mediaEntry.objectUrl;
  previewMini.muted = true;
  previewMini.playsInline = true;

  const track = document.createElement('div');
  track.className = 'trim-track';

  const activeWindow = document.createElement('div');
  activeWindow.className = 'trim-window';
  track.appendChild(activeWindow);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = maxStart.toFixed(2);
  slider.step = '0.05';
  slider.value = String(mediaEntry.trimStartSec);
  slider.className = 'trim-slider';
  slider.setAttribute('aria-label', `${cut.label}の切り出し開始位置`);

  function updateTrimmerUi(startSec) {
    const endSec = Math.min(mediaEntry.durationSec, startSec + cut.durationSec);
    label.textContent = `使用範囲：${startSec.toFixed(1)}秒 〜 ${endSec.toFixed(1)}秒（全${mediaEntry.durationSec.toFixed(1)}秒）`;
    const leftPct = (startSec / mediaEntry.durationSec) * 100;
    const widthPct = Math.min(100 - leftPct, (cut.durationSec / mediaEntry.durationSec) * 100);
    activeWindow.style.left = `${leftPct}%`;
    activeWindow.style.width = `${widthPct}%`;
  }

  updateTrimmerUi(mediaEntry.trimStartSec);

  slider.addEventListener('input', () => {
    const nextStart = Number(slider.value);
    mediaEntry.trimStartSec = nextStart;
    updateTrimmerUi(nextStart);
    if (Number.isFinite(previewMini.duration)) {
      previewMini.currentTime = nextStart;
    }
    onStateChange();
  });

  infoRow.appendChild(label);
  trimBox.appendChild(infoRow);
  trimBox.appendChild(previewMini);
  trimBox.appendChild(track);
  trimBox.appendChild(slider);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
