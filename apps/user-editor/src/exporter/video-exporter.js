import {
  buildTimelineSegments,
  computeSafeRenderDimensions,
  drawCutFrame,
  resolveCutAtTime,
  selectSupportedRecorderMimeType,
} from '../../lib/video-engine.js';

/**
 * STEP 5：ブラウザ内だけで無音動画を合成・書き出し、工程ごとの進捗を可視化する。
 */
export function initExporterSection(container, template, state, resourcePool, beforeExportCallback) {
  container.innerHTML = `
    <div class="export-panel">
      <div class="export-options">
        <label class="quality-select-label">
          <span>書き出し画質（iPhoneで重い場合は軽量モード推奨）：</span>
          <select id="export-scale-select">
            <option value="0.6667" selected>軽量 720×1280（スマホ推奨）</option>
            <option value="1">標準 1080×1920（フルHD）</option>
          </select>
        </label>
      </div>
      <div class="export-actions">
        <button type="button" id="export-start-btn" class="btn btn-accent">無音動画を書き出す</button>
      </div>
      <div id="export-progress-wrap" class="progress-wrap hidden">
        <div class="progress-meta">
          <span id="export-step-label">準備中...</span>
          <span id="export-percent-label">0%</span>
        </div>
        <progress id="export-progress-bar" max="100" value="0"></progress>
      </div>
      <div id="export-result-box" class="export-result hidden"></div>
    </div>
  `;

  const scaleSelect = container.querySelector('#export-scale-select');
  const startBtn = container.querySelector('#export-start-btn');
  const progressWrap = container.querySelector('#export-progress-wrap');
  const stepLabel = container.querySelector('#export-step-label');
  const percentLabel = container.querySelector('#export-percent-label');
  const progressBar = container.querySelector('#export-progress-bar');
  const resultBox = container.querySelector('#export-result-box');

  let activeDownloadUrl = null;

  function setProgress(stepText, percent) {
    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    progressWrap.classList.remove('hidden');
    stepLabel.textContent = stepText;
    percentLabel.textContent = `${safePercent}%`;
    progressBar.value = safePercent;
  }

  startBtn.addEventListener('click', async () => {
    beforeExportCallback?.();
    resultBox.classList.add('hidden');
    resultBox.innerHTML = '';

    const mimeType = selectSupportedRecorderMimeType();
    if (mimeType === null || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
      resultBox.classList.remove('hidden');
      resultBox.innerHTML = `
        <p class="notice notice-error">
          お使いのブラウザは動画書き出し機能（MediaRecorder / captureStream）に対応していません。最新の Safari または Chrome でお試しください。
        </p>
      `;
      return;
    }

    startBtn.disabled = true;
    setProgress('素材を準備中...', 5);

    const scale = Number(scaleSelect.value) || 0.6667;
    const { width, height, fps } = computeSafeRenderDimensions(template.output, scale);
    const { segments, totalDurationSec } = buildTimelineSegments(template.cuts);

    // 書き出し専用のオフスクリーンCanvasを一時生成し、完了後に解放する
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;
    const ctx = exportCanvas.getContext('2d');

    let stream = null;
    try {
      await prepareVideosForStart(segments, state.mediaByCutId);
      setProgress('カット合成中...', 12);

      stream = exportCanvas.captureStream(fps);
      const recorderOptions = mimeType ? { mimeType, videoBitsPerSecond: 4_500_000 } : undefined;
      const recorder = new MediaRecorder(stream, recorderOptions);
      const chunks = [];

      const recordingDone = new Promise((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            chunks.push(event.data);
          }
        };
        recorder.onerror = () => {
          reject(new Error('動画の録画処理中にエラーが発生しました。軽量モード（720×1280）でお試しください。'));
        };
        recorder.onstop = () => {
          const finalType = recorder.mimeType || mimeType || 'video/webm';
          resolve(new Blob(chunks, { type: finalType }));
        };
      });

      recorder.start(250);
      await runTimelineRecording(ctx, segments, totalDurationSec, fps, width, height, state, (ratio) => {
        setProgress('カット合成中...', 12 + ratio * 76);
      });

      setProgress('動画ファイル生成中...', 92);
      recorder.stop();
      const outputBlob = await recordingDone;

      if (activeDownloadUrl) {
        resourcePool.revokeUrl(activeDownloadUrl);
      }
      activeDownloadUrl = resourcePool.registerUrl(URL.createObjectURL(outputBlob));

      const isMp4 = outputBlob.type.includes('mp4');
      const ext = isMp4 ? 'mp4' : 'webm';
      const fileName = `Auto-video-edit_${template.id}.${ext}`;

      setProgress('書き出し完了！', 100);
      resultBox.classList.remove('hidden');
      resultBox.innerHTML = `
        <p class="notice notice-ok">
          無音動画（${width}×${height} / ${totalDurationSec.toFixed(1)}秒）の書き出しが完了しました。
          ${isMp4 ? '' : '（※このブラウザはMP4直接出力非対応のため WebM 形式で保存されました。Safari等ではMP4で保存されます）'}
        </p>
        <a href="${activeDownloadUrl}" download="${fileName}" class="btn btn-primary download-link">
          ${fileName} を端末に保存する
        </a>
        <p class="export-next-hint">保存後、Instagramのリール投稿画面でおすすめ音源をつけてアップしてください。</p>
      `;
    } catch (error) {
      resultBox.classList.remove('hidden');
      resultBox.innerHTML = `<p class="notice notice-error">${escapeHtml(error.message)}</p>`;
    } finally {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      pauseAllVideos(state.mediaByCutId);
      exportCanvas.width = 0;
      exportCanvas.height = 0;
      startBtn.disabled = false;
    }
  });
}

async function prepareVideosForStart(segments, mediaByCutId) {
  for (const segment of segments) {
    const entry = mediaByCutId[segment.cut.id];
    if (entry?.mediaType === 'video') {
      await seekVideo(entry.element, entry.trimStartSec || 0);
    }
  }
}

function seekVideo(video, timeSec) {
  return new Promise((resolve) => {
    const target = Math.max(0, Math.min(timeSec, Math.max(0, (video.duration || 1) - 0.05)));
    if (Math.abs(video.currentTime - target) < 0.03) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 400);
    video.addEventListener(
      'seeked',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    video.currentTime = target;
  });
}

function pauseAllVideos(mediaByCutId, exceptCutId = null) {
  for (const [cutId, entry] of Object.entries(mediaByCutId)) {
    if (cutId !== exceptCutId && entry?.mediaType === 'video' && !entry.element.paused) {
      entry.element.pause();
    }
  }
}

function runTimelineRecording(ctx, segments, totalDurationSec, fps, width, height, state, onProgress) {
  return new Promise((resolve) => {
    const frameIntervalMs = 1000 / fps;
    const startWallMs = performance.now();
    let lastDrawMs = -frameIntervalMs;
    let currentVideoCutId = null;

    function step(nowMs) {
      const elapsedSec = (nowMs - startWallMs) / 1000;
      if (elapsedSec >= totalDurationSec) {
        const last = resolveCutAtTime(segments, totalDurationSec);
        if (last) {
          drawCutFrame(
            ctx,
            last.segment.cut,
            state.mediaByCutId[last.segment.cut.id],
            last.localSec,
            width,
            height,
            state.textByCutId[last.segment.cut.id]
          );
        }
        onProgress(1);
        resolve();
        return;
      }

      if (nowMs - lastDrawMs >= frameIntervalMs * 0.85) {
        lastDrawMs = nowMs;
        const resolved = resolveCutAtTime(segments, elapsedSec);
        if (resolved) {
          const { segment, localSec } = resolved;
          const entry = state.mediaByCutId[segment.cut.id];

          if (entry?.mediaType === 'video') {
            if (currentVideoCutId !== segment.cut.id) {
              pauseAllVideos(state.mediaByCutId, segment.cut.id);
              currentVideoCutId = segment.cut.id;
              entry.element.play().catch(() => {});
            }
          } else if (currentVideoCutId) {
            pauseAllVideos(state.mediaByCutId);
            currentVideoCutId = null;
          }

          drawCutFrame(
            ctx,
            segment.cut,
            entry,
            localSec,
            width,
            height,
            state.textByCutId[segment.cut.id]
          );
        }
        onProgress(elapsedSec / totalDurationSec);
      }

      requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
