import { inspectMediaFile } from '../precheck/media-precheck.js';

/**
 * STEP 02：複数素材の一括配置、カットごとの素材選択、プリチェック案内、スライドトリミングを提供する。
 */
export function renderTrimmerSection(container, template, state, resourcePool, onStateChange) {
  container.innerHTML = '';

  const batchBar = document.createElement('div');
  batchBar.className = 'batch-ingest-bar';
  batchBar.innerHTML = `
    <div class="batch-ingest-row">
      <div>
        <p class="batch-ingest-title">まとめて自動配置（最大 ${template.cuts.length} 件）</p>
        <p class="batch-ingest-desc">写真や動画を複数選ぶと、カット 01 から順番に自動で割り当てます。</p>
      </div>
      <label class="btn btn-primary batch-upload-btn">
        写真・動画をまとめて選ぶ
        <input type="file" accept="video/*,image/*" multiple class="sr-only" />
      </label>
    </div>
    <p id="batch-ingest-status" class="batch-ingest-status hidden"></p>
  `;

  const batchInput = batchBar.querySelector('input[type="file"]');
  const batchStatus = batchBar.querySelector('#batch-ingest-status');
  container.appendChild(batchBar);

  const list = document.createElement('div');
  list.className = 'cut-editor-list';

  const cutRefs = [];

  async function assignFileToCut(cut, file, refs) {
    const { statusBadge, feedbackBox, trimBox, labelTextNode } = refs;
    statusBadge.textContent = 'ANALYZING...';
    statusBadge.className = 'status-indicator is-loading';
    feedbackBox.innerHTML = '';

    try {
      const previousEntry = state.mediaByCutId[cut.id];
      const inspected = await inspectMediaFile(file, cut.durationSec, resourcePool);

      if (previousEntry?.objectUrl) {
        resourcePool.revokeUrl(previousEntry.objectUrl);
      }

      state.mediaByCutId[cut.id] = inspected;
      statusBadge.textContent = inspected.mediaType === 'video' ? 'VIDEO READY' : 'PHOTO READY';
      statusBadge.className = 'status-indicator is-ready';
      labelTextNode.textContent = `素材を変更する（${inspected.fileName}）`;

      renderPrecheckMessages(feedbackBox, inspected.warnings);
      renderSlideTrimmer(trimBox, cut, inspected, onStateChange);
      onStateChange();
      return true;
    } catch (error) {
      statusBadge.textContent = 'ERROR';
      statusBadge.className = 'status-indicator is-error';
      feedbackBox.innerHTML = `<p class="notice notice-error">${escapeHtml(error.message)}</p>`;
      return false;
    }
  }

  template.cuts.forEach((cut, index) => {
    const card = document.createElement('article');
    card.className = 'cut-row';
    card.dataset.cutId = cut.id;

    const header = document.createElement('div');
    header.className = 'cut-row-head';
    header.innerHTML = `
      <div class="cut-row-title-wrap">
        <span class="cut-index">${String(index + 1).padStart(2, '0')}</span>
        <div>
          <h3 class="cut-row-title">${escapeHtml(cut.label)}</h3>
          <p class="cut-duration-meta">DURATION ${cut.durationSec.toFixed(1)}S // VIDEO OR PHOTO</p>
        </div>
      </div>
      <span class="status-indicator" data-role="status-badge">WAITING</span>
    `;

    const fileLabel = document.createElement('label');
    fileLabel.className = 'upload-trigger';
    const labelTextNode = document.createTextNode('カメラロールから素材を選ぶ');
    fileLabel.appendChild(labelTextNode);

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

    const refs = {
      cut,
      statusBadge: card.querySelector('[data-role="status-badge"]'),
      feedbackBox,
      trimBox,
      labelTextNode,
    };
    cutRefs.push(refs);

    fileInput.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      await assignFileToCut(cut, file, refs);
    });
  });

  batchInput.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) {
      return;
    }

    const limit = Math.min(files.length, cutRefs.length);
    batchStatus.classList.remove('hidden');
    let okCount = 0;

    for (let i = 0; i < limit; i++) {
      batchStatus.textContent = `${i + 1} / ${limit} 件を読み込み・自動配置中...`;
      const success = await assignFileToCut(cutRefs[i].cut, files[i], cutRefs[i]);
      if (success) {
        okCount += 1;
      }
    }

    const extraNote =
      files.length > cutRefs.length
        ? `（選択された ${files.length} 件のうち先頭 ${cutRefs.length} 件を配置しました）`
        : '';
    batchStatus.textContent = `${okCount} / ${limit} 件を自動配置しました！各カットの差し替えや秒数枠調整もできます。${extraNote}`;
    batchInput.value = '';
  });

  container.appendChild(list);
}

function renderPrecheckMessages(container, warnings) {
  if (!warnings || warnings.length === 0) {
    container.innerHTML = '<p class="notice notice-ok">向き・明るさともに良好です。そのまま美しく仕上がります。</p>';
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

  const trimHeader = document.createElement('div');
  trimHeader.className = 'trim-header';

  const label = document.createElement('span');
  label.className = 'trim-label';
  trimHeader.appendChild(label);

  const miniRow = document.createElement('div');
  miniRow.className = 'trim-mini-row';

  const previewMini = document.createElement('video');
  previewMini.className = 'trim-mini-video';
  previewMini.src = mediaEntry.objectUrl;
  previewMini.muted = true;
  previewMini.playsInline = true;

  const trackWrap = document.createElement('div');
  trackWrap.className = 'trim-track-wrap';

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
    label.textContent = `IN ${startSec.toFixed(1)}s — OUT ${endSec.toFixed(1)}s (全 ${mediaEntry.durationSec.toFixed(1)}s)`;
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

  trackWrap.appendChild(track);
  trackWrap.appendChild(slider);

  miniRow.appendChild(previewMini);
  miniRow.appendChild(trackWrap);

  trimBox.appendChild(trimHeader);
  trimBox.appendChild(miniRow);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
