import { inspectMediaFile } from '../precheck/media-precheck.js';
import { analyzeVideoFileBeats } from '../../lib/audio-beat-analyzer.js';
import {
  BIZARRE_PALETTES,
  ensureBizarreSegmenterReady,
  segmentFrameToSubjectMask,
} from '../../lib/bizarre-shift-engine.js';
import { computeCoverCropRect } from '../../lib/video-engine.js';

/**
 * STEP 02：複数素材の一括配置、カットごとの素材選択、プリチェック案内、スライドトリミングを提供する。
 */
export function renderTrimmerSection(container, template, state, resourcePool, onStateChange) {
  container.innerHTML = '';

  if (template.inputMode === 'beat-sync-video') {
    renderBeatSyncTrimmer(container, template, state, resourcePool, onStateChange);
    return;
  }

  if (template.inputMode === 'bizarre-shift') {
    renderBizarreShiftTrimmer(container, template, state, resourcePool, onStateChange);
    return;
  }

  if (template.inputMode === 'matrix-code') {
    renderMatrixCodeTrimmer(container, template, state, resourcePool, onStateChange);
    return;
  }

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

      if (previousEntry?.element) {
        resourcePool.releaseElement?.(previousEntry.element);
      }
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

function renderBeatSyncTrimmer(container, template, state, resourcePool, onStateChange) {
  const cut = template.cuts[0];
  if (!cut) {
    return;
  }

  const card = document.createElement('article');
  card.className = 'cut-row';
  card.innerHTML = `
    <div class="cut-row-head">
      <div class="cut-row-title-wrap">
        <span class="cut-index">BEAT</span>
        <div>
          <h3 class="cut-row-title">${escapeHtml(cut.label)}</h3>
          <p class="cut-duration-meta" data-role="beat-meta">DURATION ${cut.durationSec.toFixed(1)}S // VIDEO AUDIO SYNC</p>
        </div>
      </div>
      <span class="status-indicator" data-role="status-badge">WAITING</span>
    </div>
  `;

  const fileLabel = document.createElement('label');
  fileLabel.className = 'upload-trigger';
  const labelTextNode = document.createTextNode('ダンス動画を選ぶ（主旋律・メロディ自動解析）');
  fileLabel.appendChild(labelTextNode);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'video/*';
  fileInput.className = 'sr-only';
  fileLabel.appendChild(fileInput);

  const feedbackBox = document.createElement('div');
  feedbackBox.className = 'feedback-area';

  const controlsBox = document.createElement('div');
  controlsBox.className = 'beat-controls-grid hidden';

  card.appendChild(fileLabel);
  card.appendChild(feedbackBox);
  card.appendChild(controlsBox);
  container.appendChild(card);

  const statusBadge = card.querySelector('[data-role="status-badge"]');
  const beatMeta = card.querySelector('[data-role="beat-meta"]');

  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    statusBadge.textContent = 'ANALYZING MELODY...';
    statusBadge.className = 'status-indicator is-loading';
    feedbackBox.innerHTML = '<p class="notice notice-tip">動画と音声の主旋律（メロディ帯域）をブラウザ内で解析しています...</p>';

    try {
      const previousEntry = state.mediaByCutId[cut.id];
      const [inspected, beatAnalysis] = await Promise.all([
        inspectMediaFile(file, cut.durationSec, resourcePool),
        analyzeVideoFileBeats(file),
      ]);

      if (previousEntry?.element) {
        resourcePool.releaseElement?.(previousEntry.element);
      }
      if (previousEntry?.objectUrl) {
        resourcePool.revokeUrl(previousEntry.objectUrl);
      }

      const maxVideoDur = Math.max(0.5, inspected.durationSec || 8);
      const maxAllowedDur = Math.floor(Math.min(300.0, maxVideoDur) * 10) / 10;
      const defaultDur = Number(Math.min(60.0, maxAllowedDur).toFixed(1));
      cut.durationSec = Math.max(0.5, defaultDur);

      inspected.beatAnalysis = beatAnalysis;
      inspected.visualStyle = 'backlight';
      inspected.glowIntensity = 0.6;
      inspected.glowColor = 'warm-gold';
      inspected.trimStartSec = 0;
      state.mediaByCutId[cut.id] = inspected;

      statusBadge.textContent = beatAnalysis.hasAudio ? 'MELODY SYNCED' : 'VIDEO READY';
      statusBadge.className = 'status-indicator is-ready';
      labelTextNode.textContent = `動画を変更する（${inspected.fileName}）`;
      beatMeta.textContent = `DURATION ${cut.durationSec.toFixed(1)}S // ${beatAnalysis.peakCount} MELODY PHRASES`;

      const beatNotice = beatAnalysis.hasAudio
        ? `<p class="notice notice-ok">音声の主旋律（メロディ帯域）を解析しました（${beatAnalysis.peakCount} フレーズ検出）！歌やメロディの抑揚に沿って画面の縁が滑らかに光ります。</p>`
        : '<p class="notice notice-tip">音声トラックが検出できなかったため、標準リズムで縁のバックライト発光を適用します。</p>';

      renderPrecheckMessages(feedbackBox, inspected.warnings);
      feedbackBox.insertAdjacentHTML('afterbegin', beatNotice);

      renderBeatControls(controlsBox, cut, inspected, beatMeta, onStateChange);
      onStateChange();
    } catch (error) {
      statusBadge.textContent = 'ERROR';
      statusBadge.className = 'status-indicator is-error';
      feedbackBox.innerHTML = `<p class="notice notice-error">${escapeHtml(error.message)}</p>`;
    }
  });
}

function renderBeatControls(controlsBox, cut, mediaEntry, beatMeta, onStateChange) {
  controlsBox.classList.remove('hidden');
  const videoDur = Math.max(0.5, mediaEntry.durationSec || 8);
  const maxDur = Math.max(0.5, Math.floor(Math.min(300.0, videoDur) * 10) / 10);
  const minDur = Math.min(2.0, maxDur);
  const initialMaxStart = Math.max(0, Math.floor((videoDur - cut.durationSec) * 10) / 10);

  controlsBox.innerHTML = `
    <div class="beat-control-row">
      <div class="trim-track" aria-hidden="true">
        <div class="trim-window" id="beat-trim-window"></div>
      </div>
    </div>
    <div class="beat-control-row">
      <div class="trim-header">
        <span class="trim-label" id="beat-duration-label">使う長さ：${cut.durationSec.toFixed(1)}秒（全 ${videoDur.toFixed(1)}秒）</span>
      </div>
      <input type="range" id="beat-duration-slider" class="trim-slider" min="${minDur}" max="${maxDur}" step="0.1" value="${cut.durationSec}" aria-label="動画の長さ調整" />
    </div>
    <div class="beat-control-row">
      <div class="trim-header">
        <span class="trim-label" id="beat-start-label">開始位置：0.0秒 〜 ${cut.durationSec.toFixed(1)}秒</span>
      </div>
      <input type="range" id="beat-start-slider" class="trim-slider" min="0" max="${initialMaxStart.toFixed(1)}" step="0.1" value="0" aria-label="切り出し開始位置" />
    </div>
    <p id="beat-long-warning" class="notice notice-tip hidden">
      長尺（60秒超）の書き出しは再生時間と同じ時間がかかります。スマホではメモリ不足になる場合があるため、720×1280軽量モードまたはPCブラウザでの書き出しをおすすめします。
    </p>
    <div class="beat-control-row">
      <label class="trim-label" for="beat-style-select">演出パターン</label>
      <select id="beat-style-select" class="quality-select">
        <option value="backlight" selected>縁バックライト（主旋律）</option>
        <option value="bottom-eq">下部イコライザー（音楽連動）</option>
        <option value="both">縁バックライト ＋ 下部イコライザー</option>
      </select>
    </div>
    <div class="beat-control-row">
      <div class="trim-header">
        <span class="trim-label" id="beat-intensity-label">演出の強さ：標準（0.6）</span>
      </div>
      <input type="range" id="beat-intensity-slider" class="trim-slider" min="0.2" max="1.2" step="0.1" value="0.6" aria-label="演出の強さ" />
    </div>
    <div class="beat-control-row">
      <label class="trim-label" for="beat-color-select">演出の色</label>
      <select id="beat-color-select" class="quality-select">
        <option value="warm-gold" selected>シャンパン暖色（おすすめ）</option>
        <option value="vermilion">バーミリオン（情熱レッド）</option>
        <option value="cool-blue">クールブルー（ステージ光）</option>
        <option value="pure-white">ピュアホワイト（クリア光）</option>
      </select>
    </div>
  `;

  const trimWindow = controlsBox.querySelector('#beat-trim-window');
  const durationSlider = controlsBox.querySelector('#beat-duration-slider');
  const durationLabel = controlsBox.querySelector('#beat-duration-label');
  const startSlider = controlsBox.querySelector('#beat-start-slider');
  const startLabel = controlsBox.querySelector('#beat-start-label');
  const longWarning = controlsBox.querySelector('#beat-long-warning');
  const styleSelect = controlsBox.querySelector('#beat-style-select');
  const intensitySlider = controlsBox.querySelector('#beat-intensity-slider');
  const intensityLabel = controlsBox.querySelector('#beat-intensity-label');
  const colorSelect = controlsBox.querySelector('#beat-color-select');

  function syncLabels() {
    const start = mediaEntry.trimStartSec || 0;
    const end = Math.min(videoDur, start + cut.durationSec);
    const maxStart = Math.max(0, Math.floor((videoDur - cut.durationSec) * 10) / 10);

    startSlider.disabled = maxStart <= 0.05;
    durationLabel.textContent = `使う長さ：${cut.durationSec.toFixed(1)}秒（最大 ${maxDur.toFixed(1)}秒 / 元動画 ${videoDur.toFixed(1)}秒）`;
    startLabel.textContent =
      maxStart <= 0.05
        ? `開始位置：${start.toFixed(1)}秒 〜 ${end.toFixed(1)}秒（動画全体を使用中・長さを短くすると開始位置を動かせます）`
        : `開始位置：${start.toFixed(1)}秒 〜 ${end.toFixed(1)}秒`;

    const leftPct = Math.min(100, (start / videoDur) * 100);
    const widthPct = Math.min(100 - leftPct, (cut.durationSec / videoDur) * 100);
    trimWindow.style.left = `${leftPct}%`;
    trimWindow.style.width = `${widthPct}%`;

    longWarning.classList.toggle('hidden', cut.durationSec <= 60);

    const val = mediaEntry.glowIntensity ?? 0.6;
    const tag = val <= 0.4 ? '微か' : val >= 0.9 ? '明るめ' : '標準';
    intensityLabel.textContent = `演出の強さ：${tag}（${val.toFixed(1)}）`;
    beatMeta.textContent = `DURATION ${cut.durationSec.toFixed(1)}S // ${mediaEntry.beatAnalysis?.peakCount || 0} MELODY PHRASES`;
  }

  durationSlider.addEventListener('input', () => {
    cut.durationSec = Number(durationSlider.value);
    const maxStart = Math.max(0, Math.floor((videoDur - cut.durationSec) * 10) / 10);
    startSlider.max = maxStart.toFixed(1);
    if ((mediaEntry.trimStartSec || 0) > maxStart) {
      mediaEntry.trimStartSec = maxStart;
      startSlider.value = maxStart.toFixed(1);
    }
    syncLabels();
    onStateChange();
  });

  startSlider.addEventListener('input', () => {
    mediaEntry.trimStartSec = Number(startSlider.value);
    syncLabels();
    onStateChange();
  });

  styleSelect.addEventListener('change', () => {
    mediaEntry.visualStyle = styleSelect.value;
    onStateChange();
  });

  intensitySlider.addEventListener('input', () => {
    mediaEntry.glowIntensity = Number(intensitySlider.value);
    syncLabels();
    onStateChange();
  });

  colorSelect.addEventListener('change', () => {
    mediaEntry.glowColor = colorSelect.value;
    onStateChange();
  });

  syncLabels();
}

function renderBizarreShiftTrimmer(container, template, state, resourcePool, onStateChange) {
  const cut = template.cuts[0];
  if (!cut) {
    return;
  }

  const card = document.createElement('article');
  card.className = 'cut-row';
  card.innerHTML = `
    <div class="cut-row-head">
      <div class="cut-row-title-wrap">
        <span class="cut-index">AI</span>
        <div>
          <h3 class="cut-row-title">${escapeHtml(cut.label)}</h3>
          <p class="cut-duration-meta" data-role="bizarre-meta">DURATION ${cut.durationSec.toFixed(1)}S // 2.0S GLITCH SHIFT</p>
        </div>
      </div>
      <span class="status-indicator" data-role="status-badge">WAITING</span>
    </div>
  `;

  const fileLabel = document.createElement('label');
  fileLabel.className = 'upload-trigger';
  const labelTextNode = document.createTextNode('動画または写真を選ぶ（人物・犬・猫・鳥などを自動認識）');
  fileLabel.appendChild(labelTextNode);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'video/*,image/*';
  fileInput.className = 'sr-only';
  fileLabel.appendChild(fileInput);

  const feedbackBox = document.createElement('div');
  feedbackBox.className = 'feedback-area';

  const controlsBox = document.createElement('div');
  controlsBox.className = 'beat-controls-grid hidden';

  card.appendChild(fileLabel);
  card.appendChild(feedbackBox);
  card.appendChild(controlsBox);
  container.appendChild(card);

  const statusBadge = card.querySelector('[data-role="status-badge"]');
  const bizarreMeta = card.querySelector('[data-role="bizarre-meta"]');

  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    statusBadge.textContent = 'LOADING AI...';
    statusBadge.className = 'status-indicator is-loading';
    feedbackBox.innerHTML =
      '<p class="notice notice-tip">人物・動物の自動切り抜きAI（ブラウザ内処理）を読み込んでいます...</p>';

    try {
      const previousEntry = state.mediaByCutId[cut.id];
      const inspected = await inspectMediaFile(file, cut.durationSec, resourcePool);

      if (previousEntry?.element) {
        resourcePool.releaseElement?.(previousEntry.element);
      }
      if (previousEntry?.objectUrl) {
        resourcePool.revokeUrl(previousEntry.objectUrl);
      }

      if (inspected.mediaType === 'video') {
        const videoDur = Math.max(0.5, inspected.durationSec || 6);
        cut.durationSec = Math.max(
          Math.min(2.5, videoDur),
          Number(Math.min(8.0, videoDur).toFixed(1))
        );
      } else {
        cut.durationSec = 6.0;
      }

      inspected.bizarrePalette = 'golden-bizarre';
      inspected.bizarreTouch = 'color-only';
      inspected.bizarreTriggerSec = Math.min(2.0, Math.max(0.5, cut.durationSec - 0.5));
      inspected.trimStartSec = 0;
      state.mediaByCutId[cut.id] = inspected;

      renderBizarreControls(controlsBox, cut, inspected, bizarreMeta, onStateChange);
      onStateChange();

      await ensureBizarreSegmenterReady();
      const crop = computeCoverCropRect(inspected.width, inspected.height, 360, 640, 'none', 0);
      const mask = await segmentFrameToSubjectMask(inspected.element, crop, 360, 640);
      inspected.subjectMask = mask;

      renderPrecheckMessages(feedbackBox, inspected.warnings);
      if (mask && mask.coverageRatio > 0.005) {
        statusBadge.textContent = 'SUBJECT READY';
        statusBadge.className = 'status-indicator is-ready';
        feedbackBox.insertAdjacentHTML(
          'afterbegin',
          '<p class="notice notice-ok">人物・動物を検出しました！背景はそのまま、指定秒数で一瞬「ザザッ」と乱れて異色カラーへ切り替わります。</p>'
        );
      } else {
        statusBadge.textContent = 'AI READY';
        statusBadge.className = 'status-indicator is-ready';
        feedbackBox.insertAdjacentHTML(
          'afterbegin',
          '<p class="notice notice-tip">AIエンジン準備完了（先頭フレームに人物/犬/猫などが少ない場合でも、2秒後に登場したフレームから自動適用されます）。</p>'
        );
      }

      labelTextNode.textContent = `素材を変更する（${inspected.fileName}）`;
      onStateChange();
    } catch (error) {
      statusBadge.textContent = 'ERROR';
      statusBadge.className = 'status-indicator is-error';
      feedbackBox.innerHTML = `<p class="notice notice-error">${escapeHtml(error.message)}</p>`;
    }
  });
}

function renderBizarreControls(controlsBox, cut, mediaEntry, bizarreMeta, onStateChange) {
  controlsBox.classList.remove('hidden');
  const isVideo = mediaEntry.mediaType === 'video';
  const totalMediaDur = isVideo ? Math.max(0.5, mediaEntry.durationSec || 6) : 15.0;
  const maxDur = isVideo
    ? Math.max(0.5, Math.floor(Math.min(60.0, totalMediaDur) * 10) / 10)
    : 15.0;
  const minDur = Math.min(2.5, maxDur);
  const initialMaxStart = isVideo
    ? Math.max(0, Math.floor((totalMediaDur - cut.durationSec) * 10) / 10)
    : 0;
  const paletteOptions = Object.entries(BIZARRE_PALETTES)
    .map(([key, info]) => `<option value="${escapeHtml(key)}">${escapeHtml(info.label)}</option>`)
    .join('');

  controlsBox.innerHTML = `
    ${
      isVideo
        ? `<div class="beat-control-row">
            <div class="trim-track" aria-hidden="true">
              <div class="trim-window" id="bizarre-trim-window"></div>
            </div>
          </div>`
        : ''
    }
    <div class="beat-control-row">
      <div class="trim-header">
        <span class="trim-label" id="bizarre-duration-label">使う長さ：${cut.durationSec.toFixed(1)}秒</span>
      </div>
      <input type="range" id="bizarre-duration-slider" class="trim-slider" min="${minDur}" max="${maxDur}" step="0.1" value="${cut.durationSec}" aria-label="動画の長さ調整" />
    </div>
    ${
      isVideo
        ? `<div class="beat-control-row">
            <div class="trim-header">
              <span class="trim-label" id="bizarre-start-label">開始位置：0.0秒 〜 ${cut.durationSec.toFixed(1)}秒</span>
            </div>
            <input type="range" id="bizarre-start-slider" class="trim-slider" min="0" max="${initialMaxStart.toFixed(1)}" step="0.1" value="0" aria-label="切り出し開始位置" />
          </div>`
        : ''
    }
    <div class="beat-control-row">
      <div class="trim-header">
        <span class="trim-label" id="bizarre-trigger-label">切替タイミング：${mediaEntry.bizarreTriggerSec.toFixed(1)}秒後（一瞬グリッチ→異色カラー）</span>
      </div>
      <input type="range" id="bizarre-trigger-slider" class="trim-slider" min="0.5" max="${Math.max(0.5, cut.durationSec - 0.5).toFixed(1)}" step="0.1" value="${mediaEntry.bizarreTriggerSec.toFixed(1)}" aria-label="異色カラー切替タイミング" />
    </div>
    <div class="beat-control-row">
      <label class="trim-label" for="bizarre-palette-select">カラー配色（被写体のみ変化・背景そのまま）</label>
      <select id="bizarre-palette-select" class="quality-select">
        ${paletteOptions}
      </select>
    </div>
    <div class="beat-control-row">
      <label class="trim-label" for="bizarre-touch-select">アニメ表現タッチ</label>
      <select id="bizarre-touch-select" class="quality-select">
        <option value="color-only" selected>カラー変化のみ（元の質感を活かして異色化）</option>
        <option value="anime-ink">アニメ輪郭線＋濃い影（太線・パキッと陰影）</option>
      </select>
    </div>
  `;

  const trimWindow = controlsBox.querySelector('#bizarre-trim-window');
  const durationSlider = controlsBox.querySelector('#bizarre-duration-slider');
  const durationLabel = controlsBox.querySelector('#bizarre-duration-label');
  const startSlider = controlsBox.querySelector('#bizarre-start-slider');
  const startLabel = controlsBox.querySelector('#bizarre-start-label');
  const triggerSlider = controlsBox.querySelector('#bizarre-trigger-slider');
  const triggerLabel = controlsBox.querySelector('#bizarre-trigger-label');
  const paletteSelect = controlsBox.querySelector('#bizarre-palette-select');
  const touchSelect = controlsBox.querySelector('#bizarre-touch-select');

  function syncLabels() {
    durationLabel.textContent = isVideo
      ? `使う長さ：${cut.durationSec.toFixed(1)}秒（最大 ${maxDur.toFixed(1)}秒 / 元動画 ${totalMediaDur.toFixed(1)}秒）`
      : `再生時間：${cut.durationSec.toFixed(1)}秒（写真）`;

    if (isVideo && startSlider && startLabel && trimWindow) {
      const start = mediaEntry.trimStartSec || 0;
      const end = Math.min(totalMediaDur, start + cut.durationSec);
      const maxStart = Math.max(0, Math.floor((totalMediaDur - cut.durationSec) * 10) / 10);
      startSlider.disabled = maxStart <= 0.05;
      startLabel.textContent =
        maxStart <= 0.05
          ? `開始位置：${start.toFixed(1)}秒 〜 ${end.toFixed(1)}秒（全体を使用中）`
          : `開始位置：${start.toFixed(1)}秒 〜 ${end.toFixed(1)}秒`;

      const leftPct = Math.min(100, (start / totalMediaDur) * 100);
      const widthPct = Math.min(100 - leftPct, (cut.durationSec / totalMediaDur) * 100);
      trimWindow.style.left = `${leftPct}%`;
      trimWindow.style.width = `${widthPct}%`;
    }

    const trig = mediaEntry.bizarreTriggerSec ?? 2.0;
    triggerLabel.textContent = `切替タイミング：${trig.toFixed(1)}秒後（一瞬ザザッと乱れて異色カラーへ）`;
    bizarreMeta.textContent = `DURATION ${cut.durationSec.toFixed(1)}S // ${trig.toFixed(1)}S GLITCH SHIFT`;
  }

  durationSlider.addEventListener('input', () => {
    cut.durationSec = Number(durationSlider.value);
    if (isVideo && startSlider) {
      const maxStart = Math.max(0, Math.floor((totalMediaDur - cut.durationSec) * 10) / 10);
      startSlider.max = maxStart.toFixed(1);
      if ((mediaEntry.trimStartSec || 0) > maxStart) {
        mediaEntry.trimStartSec = maxStart;
        startSlider.value = maxStart.toFixed(1);
      }
    }
    const maxTrig = Math.max(0.5, Number((cut.durationSec - 0.5).toFixed(1)));
    triggerSlider.max = maxTrig.toFixed(1);
    if ((mediaEntry.bizarreTriggerSec || 2.0) > maxTrig) {
      mediaEntry.bizarreTriggerSec = maxTrig;
      triggerSlider.value = maxTrig.toFixed(1);
    }
    syncLabels();
    onStateChange();
  });

  if (startSlider) {
    startSlider.addEventListener('input', () => {
      mediaEntry.trimStartSec = Number(startSlider.value);
      syncLabels();
      onStateChange();
    });
  }

  triggerSlider.addEventListener('input', () => {
    mediaEntry.bizarreTriggerSec = Number(triggerSlider.value);
    syncLabels();
    onStateChange();
  });

  paletteSelect.addEventListener('change', () => {
    mediaEntry.bizarrePalette = paletteSelect.value;
    onStateChange();
  });

  touchSelect.addEventListener('change', () => {
    mediaEntry.bizarreTouch = touchSelect.value;
    onStateChange();
  });

  syncLabels();
}

function renderMatrixCodeTrimmer(container, template, state, resourcePool, onStateChange) {
  const cut = template.cuts[0];
  if (!cut) {
    return;
  }

  const card = document.createElement('article');
  card.className = 'cut-row';
  card.innerHTML = `
    <div class="cut-row-head">
      <div class="cut-row-title-wrap">
        <span class="cut-index">CODE</span>
        <div>
          <h3 class="cut-row-title">${escapeHtml(cut.label)}</h3>
          <p class="cut-duration-meta" data-role="matrix-meta">DURATION ${cut.durationSec.toFixed(1)}S // 2.0S MATRIX WORLD</p>
        </div>
      </div>
      <span class="status-indicator" data-role="status-badge">WAITING</span>
    </div>
  `;

  const fileLabel = document.createElement('label');
  fileLabel.className = 'upload-trigger';
  const labelTextNode = document.createTextNode('動画または写真を選ぶ（2秒後に黒×緑コード世界へ）');
  fileLabel.appendChild(labelTextNode);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'video/*,image/*';
  fileInput.className = 'sr-only';
  fileLabel.appendChild(fileInput);

  const feedbackBox = document.createElement('div');
  feedbackBox.className = 'feedback-area';

  const controlsBox = document.createElement('div');
  controlsBox.className = 'beat-controls-grid hidden';

  card.appendChild(fileLabel);
  card.appendChild(feedbackBox);
  card.appendChild(controlsBox);
  container.appendChild(card);

  const statusBadge = card.querySelector('[data-role="status-badge"]');
  const matrixMeta = card.querySelector('[data-role="matrix-meta"]');

  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    statusBadge.textContent = 'ANALYZING...';
    statusBadge.className = 'status-indicator is-loading';
    feedbackBox.innerHTML = '';

    try {
      const previousEntry = state.mediaByCutId[cut.id];
      const inspected = await inspectMediaFile(file, cut.durationSec, resourcePool);

      if (previousEntry?.element) {
        resourcePool.releaseElement?.(previousEntry.element);
      }
      if (previousEntry?.objectUrl) {
        resourcePool.revokeUrl(previousEntry.objectUrl);
      }

      if (inspected.mediaType === 'video') {
        const videoDur = Math.max(0.5, inspected.durationSec || 6);
        cut.durationSec = Math.max(
          Math.min(2.5, videoDur),
          Number(Math.min(15.0, videoDur).toFixed(1))
        );
      } else {
        cut.durationSec = 6.0;
      }

      inspected.matrixTriggerSec = Math.min(2.0, Math.max(0.5, cut.durationSec - 0.5));
      inspected.matrixDensity = 'standard';
      inspected.matrixVisibility = 'silhouette';
      inspected.trimStartSec = 0;
      state.mediaByCutId[cut.id] = inspected;

      statusBadge.textContent = inspected.mediaType === 'video' ? 'VIDEO READY' : 'PHOTO READY';
      statusBadge.className = 'status-indicator is-ready';
      labelTextNode.textContent = `素材を変更する（${inspected.fileName}）`;

      renderPrecheckMessages(feedbackBox, inspected.warnings);
      feedbackBox.insertAdjacentHTML(
        'afterbegin',
        '<p class="notice notice-ok">設定完了！2秒後に一瞬「ザザッ」と乱れて、黒と緑のコードだけの世界へ切り替わります。</p>'
      );

      renderMatrixCodeControls(controlsBox, cut, inspected, matrixMeta, onStateChange);
      onStateChange();
    } catch (error) {
      statusBadge.textContent = 'ERROR';
      statusBadge.className = 'status-indicator is-error';
      feedbackBox.innerHTML = `<p class="notice notice-error">${escapeHtml(error.message)}</p>`;
    }
  });
}

function renderMatrixCodeControls(controlsBox, cut, mediaEntry, matrixMeta, onStateChange) {
  controlsBox.classList.remove('hidden');
  const isVideo = mediaEntry.mediaType === 'video';
  const totalMediaDur = isVideo ? Math.max(0.5, mediaEntry.durationSec || 6) : 15.0;
  const maxDur = isVideo
    ? Math.max(0.5, Math.floor(Math.min(60.0, totalMediaDur) * 10) / 10)
    : 15.0;
  const minDur = Math.min(2.5, maxDur);
  const initialMaxStart = isVideo
    ? Math.max(0, Math.floor((totalMediaDur - cut.durationSec) * 10) / 10)
    : 0;

  controlsBox.innerHTML = `
    ${
      isVideo
        ? `<div class="beat-control-row">
            <div class="trim-track" aria-hidden="true">
              <div class="trim-window" id="matrix-trim-window"></div>
            </div>
          </div>`
        : ''
    }
    <div class="beat-control-row">
      <div class="trim-header">
        <span class="trim-label" id="matrix-duration-label">使う長さ：${cut.durationSec.toFixed(1)}秒</span>
      </div>
      <input type="range" id="matrix-duration-slider" class="trim-slider" min="${minDur}" max="${maxDur}" step="0.1" value="${cut.durationSec}" aria-label="動画の長さ調整" />
    </div>
    ${
      isVideo
        ? `<div class="beat-control-row">
            <div class="trim-header">
              <span class="trim-label" id="matrix-start-label">開始位置：0.0秒 〜 ${cut.durationSec.toFixed(1)}秒</span>
            </div>
            <input type="range" id="matrix-start-slider" class="trim-slider" min="0" max="${initialMaxStart.toFixed(1)}" step="0.1" value="0" aria-label="切り出し開始位置" />
          </div>`
        : ''
    }
    <div class="beat-control-row">
      <div class="trim-header">
        <span class="trim-label" id="matrix-trigger-label">切替タイミング：${mediaEntry.matrixTriggerSec.toFixed(1)}秒後</span>
      </div>
      <input type="range" id="matrix-trigger-slider" class="trim-slider" min="0.5" max="${Math.max(0.5, cut.durationSec - 0.5).toFixed(1)}" step="0.1" value="${mediaEntry.matrixTriggerSec.toFixed(1)}" aria-label="コード世界への切替タイミング" />
    </div>
    <div class="beat-control-row">
      <label class="trim-label" for="matrix-density-select">コード文字の細かさ</label>
      <select id="matrix-density-select" class="quality-select">
        <option value="fine">超高精細（輪郭がより細密）</option>
        <option value="standard" selected>標準（輪郭と文字のバランス・おすすめ）</option>
        <option value="bold">大きめ（文字の迫力重視）</option>
      </select>
    </div>
    <div class="beat-control-row">
      <label class="trim-label" for="matrix-visibility-select">輪郭・コードの見え方</label>
      <select id="matrix-visibility-select" class="quality-select">
        <option value="silhouette" selected>輪郭くっきり（コードで形を描く・おすすめ）</option>
        <option value="balanced">輪郭＋明暗バランス</option>
        <option value="rain">画面全体コード多め</option>
      </select>
    </div>
  `;

  const trimWindow = controlsBox.querySelector('#matrix-trim-window');
  const durationSlider = controlsBox.querySelector('#matrix-duration-slider');
  const durationLabel = controlsBox.querySelector('#matrix-duration-label');
  const startSlider = controlsBox.querySelector('#matrix-start-slider');
  const startLabel = controlsBox.querySelector('#matrix-start-label');
  const triggerSlider = controlsBox.querySelector('#matrix-trigger-slider');
  const triggerLabel = controlsBox.querySelector('#matrix-trigger-label');
  const densitySelect = controlsBox.querySelector('#matrix-density-select');
  const visibilitySelect = controlsBox.querySelector('#matrix-visibility-select');

  function syncLabels() {
    durationLabel.textContent = isVideo
      ? `使う長さ：${cut.durationSec.toFixed(1)}秒（最大 ${maxDur.toFixed(1)}秒 / 元動画 ${totalMediaDur.toFixed(1)}秒）`
      : `再生時間：${cut.durationSec.toFixed(1)}秒（写真）`;

    if (isVideo && startSlider && startLabel && trimWindow) {
      const start = mediaEntry.trimStartSec || 0;
      const end = Math.min(totalMediaDur, start + cut.durationSec);
      const maxStart = Math.max(0, Math.floor((totalMediaDur - cut.durationSec) * 10) / 10);
      startSlider.disabled = maxStart <= 0.05;
      startLabel.textContent =
        maxStart <= 0.05
          ? `開始位置：${start.toFixed(1)}秒 〜 ${end.toFixed(1)}秒（全体を使用中）`
          : `開始位置：${start.toFixed(1)}秒 〜 ${end.toFixed(1)}秒`;

      const leftPct = Math.min(100, (start / totalMediaDur) * 100);
      const widthPct = Math.min(100 - leftPct, (cut.durationSec / totalMediaDur) * 100);
      trimWindow.style.left = `${leftPct}%`;
      trimWindow.style.width = `${widthPct}%`;
    }

    const trig = mediaEntry.matrixTriggerSec ?? 2.0;
    triggerLabel.textContent = `切替タイミング：${trig.toFixed(1)}秒後（一瞬ザザッと乱れてコード世界へ）`;
    matrixMeta.textContent = `DURATION ${cut.durationSec.toFixed(1)}S // ${trig.toFixed(1)}S MATRIX WORLD`;
  }

  durationSlider.addEventListener('input', () => {
    cut.durationSec = Number(durationSlider.value);
    if (isVideo && startSlider) {
      const maxStart = Math.max(0, Math.floor((totalMediaDur - cut.durationSec) * 10) / 10);
      startSlider.max = maxStart.toFixed(1);
      if ((mediaEntry.trimStartSec || 0) > maxStart) {
        mediaEntry.trimStartSec = maxStart;
        startSlider.value = maxStart.toFixed(1);
      }
    }
    const maxTrig = Math.max(0.5, Number((cut.durationSec - 0.5).toFixed(1)));
    triggerSlider.max = maxTrig.toFixed(1);
    if ((mediaEntry.matrixTriggerSec || 2.0) > maxTrig) {
      mediaEntry.matrixTriggerSec = maxTrig;
      triggerSlider.value = maxTrig.toFixed(1);
    }
    syncLabels();
    onStateChange();
  });

  if (startSlider) {
    startSlider.addEventListener('input', () => {
      mediaEntry.trimStartSec = Number(startSlider.value);
      syncLabels();
      onStateChange();
    });
  }

  triggerSlider.addEventListener('input', () => {
    mediaEntry.matrixTriggerSec = Number(triggerSlider.value);
    syncLabels();
    onStateChange();
  });

  densitySelect.addEventListener('change', () => {
    mediaEntry.matrixDensity = densitySelect.value;
    onStateChange();
  });

  visibilitySelect.addEventListener('change', () => {
    mediaEntry.matrixVisibility = visibilitySelect.value;
    onStateChange();
  });

  syncLabels();
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
