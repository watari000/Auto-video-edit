import {
  buildTimelineSegments,
  computeAdaptiveVideoBitrate,
  computeSafeRenderDimensions,
  drawCutFrame,
  resolveCutAtTime,
  selectSupportedRecorderMimeType,
} from '../../lib/video-engine.js';
import { createRecordingChunkSink } from '../../lib/opfs-chunk-sink.js';

async function acquireScreenWakeLock() {
  if (typeof navigator === 'undefined' || typeof navigator.wakeLock?.request !== 'function') {
    return null;
  }
  try {
    return await navigator.wakeLock.request('screen');
  } catch {
    return null;
  }
}

/**
 * STEP 04：マスタリング＆ローカル無音書き出しドック。工程ごとのテレメトリ進捗を表示する。
 */
export function initExporterSection(container, template, state, resourcePool, beforeExportCallback) {
  const canExportAudio = Boolean(template.allowSourceAudio);
  container.innerHTML = `
    <div class="export-dock">
      <div class="export-dock-grid">
        <div>
          <label for="export-scale-select" class="quality-label">RENDER RESOLUTION // iOS SAFARI SAFE</label>
          <select id="export-scale-select" class="quality-select">
            <option value="0.6667" selected>軽量 720×1280（スマホ標準）</option>
            <option value="1">高画質 1080×1920（PC推奨・フルHD）</option>
          </select>
          ${
            canExportAudio
              ? `<label class="audio-export-toggle">
                  <input type="checkbox" id="export-include-audio" checked />
                  <span>元動画の音声を含めて書き出す（音あり）</span>
                </label>`
              : ''
          }
        </div>
        <div>
          <button type="button" id="export-start-btn" class="btn btn-accent">
            ${canExportAudio ? '音声付きで書き出す' : '無音動画を書き出す'}
          </button>
        </div>
      </div>

      <div id="export-progress-wrap" class="progress-telemetry hidden">
        <div class="progress-meta">
          <span id="export-step-label">準備中...</span>
          <span id="export-percent-label">0%</span>
        </div>
        <div class="progress-bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div id="export-progress-fill" class="progress-bar-fill"></div>
        </div>
      </div>

      <div id="export-result-box" class="export-result hidden"></div>
    </div>
  `;

  const scaleSelect = container.querySelector('#export-scale-select');
  const includeAudioCheckbox = container.querySelector('#export-include-audio');
  const startBtn = container.querySelector('#export-start-btn');
  const progressWrap = container.querySelector('#export-progress-wrap');
  const stepLabel = container.querySelector('#export-step-label');
  const percentLabel = container.querySelector('#export-percent-label');
  const progressTrack = container.querySelector('.progress-bar-track');
  const progressFill = container.querySelector('#export-progress-fill');
  const resultBox = container.querySelector('#export-result-box');

  if (includeAudioCheckbox) {
    includeAudioCheckbox.addEventListener('change', () => {
      startBtn.textContent = includeAudioCheckbox.checked ? '音声付きで書き出す' : '無音動画を書き出す';
    });
  }

  let activeDownloadUrl = null;
  let activeChunkSink = null;

  window.addEventListener('beforeunload', () => {
    activeChunkSink?.cleanup();
  });

  function setProgress(stepText, percent) {
    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    progressWrap.classList.remove('hidden');
    stepLabel.textContent = stepText;
    percentLabel.textContent = `${safePercent}%`;
    progressFill.style.width = `${safePercent}%`;
    progressTrack.setAttribute('aria-valuenow', String(safePercent));
  }

  startBtn.addEventListener('click', async () => {
    beforeExportCallback?.();
    resultBox.classList.add('hidden');
    resultBox.innerHTML = '';

    const baseMimeType = selectSupportedRecorderMimeType(false);
    if (baseMimeType === null || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
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

    // 書き出し専用のオフスクリーンCanvasを一時生成し、iOS Safariの間引きを防ぐため隠しホストへ接続する
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;
    const hiddenHost = document.getElementById('hidden-media-host') || document.body;
    exportCanvas.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
    hiddenHost.appendChild(exportCanvas);
    const ctx = exportCanvas.getContext('2d', { alpha: false });

    let stream = null;
    let audioContextToResume = null;
    let exportedWithAudio = false;
    let wakeLock = null;
    let chunkSink = null;
    let finalized = false;
    const primaryVideo = state.mediaByCutId[segments[0]?.cut.id]?.mediaType === 'video'
      ? state.mediaByCutId[segments[0].cut.id].element
      : null;

    try {
      if (activeChunkSink) {
        await activeChunkSink.cleanup();
        activeChunkSink = null;
      }

      wakeLock = await acquireScreenWakeLock();
      chunkSink = await createRecordingChunkSink(template.id);

      await prepareVideosForStart(segments, state.mediaByCutId);
      setProgress('カット合成中...', 12);

      // 先頭カットが動画の場合、録画開始前に再生デコーダを立ち上げて冒頭コマ落ちを防ぐ
      if (primaryVideo) {
        await primaryVideo.play().catch(() => {});
      }

      const canvasStream = exportCanvas.captureStream(fps);
      const tracks = [...canvasStream.getVideoTracks()];

      const wantsAudio = Boolean(canExportAudio && includeAudioCheckbox?.checked && primaryVideo);
      if (wantsAudio) {
        const audioTrackResult = await attachVideoAudioTrack(primaryVideo);
        if (audioTrackResult) {
          tracks.push(audioTrackResult.track);
          audioContextToResume = audioTrackResult.audioCtx;
          exportedWithAudio = true;
          primaryVideo.muted = false;
        }
      }

      stream = new MediaStream(tracks);
      const mimeType = selectSupportedRecorderMimeType(exportedWithAudio) ?? baseMimeType;
      const videoBitsPerSecond = computeAdaptiveVideoBitrate(totalDurationSec, width);
      const recorderOptions = mimeType
        ? { mimeType, videoBitsPerSecond }
        : { videoBitsPerSecond };
      const recorder = new MediaRecorder(stream, recorderOptions);

      const recordingDone = new Promise((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            chunkSink.append(event.data);
          }
        };
        recorder.onerror = () => {
          reject(new Error('動画の録画処理中にエラーが発生しました。軽量モード（720×1280）でお試しください。'));
        };
        recorder.onstop = async () => {
          try {
            const finalType = recorder.mimeType || mimeType || 'video/webm';
            const blob = await chunkSink.finalize(finalType);
            resolve(blob);
          } catch (finalizeError) {
            reject(finalizeError);
          }
        };
      });

      // 長尺動画でもOPFSへ滑らかに逐次フラッシュできるよう1秒間隔でチャンクを受け取る
      recorder.start(1000);
      await runTimelineRecording(ctx, segments, totalDurationSec, fps, width, height, state, (ratio) => {
        setProgress('カット合成中...', 12 + ratio * 76);
      });

      setProgress('動画ファイル生成中...', 92);
      recorder.stop();
      const outputBlob = await recordingDone;
      finalized = true;
      activeChunkSink = chunkSink;

      if (activeDownloadUrl) {
        resourcePool.revokeUrl(activeDownloadUrl);
      }
      activeDownloadUrl = resourcePool.registerUrl(URL.createObjectURL(outputBlob));

      const isMp4 = outputBlob.type.includes('mp4');
      const ext = isMp4 ? 'mp4' : 'webm';
      const fileName = `Auto-video-edit_${template.id}.${ext}`;
      const audioLabel = exportedWithAudio ? '音声あり' : '無音';
      const opfsLabel = chunkSink.mode === 'opfs' ? ' / OPFS省メモリ保存' : '';
      const shareType = outputBlob.type || (isMp4 ? 'video/mp4' : 'video/webm');

      let canShareToPhotos = false;
      let shareFile = null;
      if (typeof File === 'function' && typeof navigator !== 'undefined' && typeof navigator.canShare === 'function') {
        try {
          shareFile = new File([outputBlob], fileName, { type: shareType });
          canShareToPhotos = navigator.canShare({ files: [shareFile] });
        } catch {
          canShareToPhotos = false;
        }
      }

      setProgress('書き出し完了！', 100);
      resultBox.classList.remove('hidden');
      resultBox.innerHTML = `
        <p class="notice notice-ok">
          ${audioLabel}動画（${width}×${height} / ${totalDurationSec.toFixed(1)}秒${opfsLabel}）の書き出しが完了しました。
          ${isMp4 ? '' : '（※このブラウザはMP4直接出力非対応のため WebM 形式で保存されました。Safari等ではMP4で保存されます）'}
        </p>
        <div class="export-result-actions">
          ${
            canShareToPhotos
              ? '<button type="button" id="export-share-photos-btn" class="btn btn-accent">写真アプリに保存（共有 → ビデオを保存）</button>'
              : ''
          }
          <a href="${activeDownloadUrl}" download="${fileName}" class="btn ${canShareToPhotos ? 'btn-secondary' : 'btn-primary'} download-cta">
            ${canShareToPhotos ? 'ファイルとして保存' : `${fileName} を端末に保存する`}
          </a>
        </div>
        <p id="export-share-feedback" class="notice notice-tip hidden"></p>
        <p class="export-next-hint">${
          exportedWithAudio
            ? canShareToPhotos
              ? 'iPhoneでは「写真アプリに保存」→「ビデオを保存」を選ぶとカメラロールに直接入ります。'
              : '保存した動画をそのままSNSへ投稿できます。'
            : '保存後、Instagramのリール投稿画面でおすすめ音源をつけてアップしてください。'
        }</p>
      `;

      const shareBtn = resultBox.querySelector('#export-share-photos-btn');
      const shareFeedback = resultBox.querySelector('#export-share-feedback');
      if (shareBtn && shareFile) {
        shareBtn.addEventListener('click', async () => {
          try {
            await navigator.share({ files: [shareFile], title: template.title });
          } catch (shareError) {
            if (shareError?.name !== 'AbortError' && shareFeedback) {
              shareFeedback.textContent =
                '共有シートを開けませんでした。横の「ファイルとして保存」から保存後、ファイルアプリで「ビデオを保存」を選んでください。';
              shareFeedback.classList.remove('hidden');
            }
          }
        });
      }
    } catch (error) {
      if (chunkSink && !finalized) {
        await chunkSink.cleanup();
      }
      resultBox.classList.remove('hidden');
      resultBox.innerHTML = `<p class="notice notice-error">${escapeHtml(error.message)}</p>`;
    } finally {
      if (wakeLock && typeof wakeLock.release === 'function') {
        wakeLock.release().catch(() => {});
      }
      if (primaryVideo) {
        primaryVideo.muted = true;
      }
      if (audioContextToResume && audioContextToResume.state === 'running') {
        audioContextToResume.suspend().catch(() => {});
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      pauseAllVideos(state.mediaByCutId);
      exportCanvas.remove();
      exportCanvas.width = 0;
      exportCanvas.height = 0;
      startBtn.disabled = false;
    }
  });
}

async function attachVideoAudioTrack(videoElement) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    return null;
  }
  try {
    // 同じvideo要素に対して複数回createMediaElementSourceを呼ぶと例外になるためインスタンスを保持する
    if (!videoElement._audioBridge) {
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaElementSource(videoElement);
      const destination = audioCtx.createMediaStreamDestination();
      source.connect(destination);
      videoElement._audioBridge = { audioCtx, destination };
    }
    const { audioCtx, destination } = videoElement._audioBridge;
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    const track = destination.stream.getAudioTracks()[0];
    return track ? { track, audioCtx } : null;
  } catch {
    return null;
  }
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
    let nextFrameMs = startWallMs;
    let lastProgressUiMs = startWallMs;
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

      if (nowMs >= nextFrameMs) {
        // 長時間フレーム落ち時も一気に追いついて位相ズレを防ぐ
        nextFrameMs = Math.max(nowMs + frameIntervalMs * 0.5, nextFrameMs + frameIntervalMs);
        const resolved = resolveCutAtTime(segments, elapsedSec);
        if (resolved) {
          const { segment, localSec } = resolved;
          const entry = state.mediaByCutId[segment.cut.id];

          if (entry?.mediaType === 'video') {
            if (currentVideoCutId !== segment.cut.id) {
              pauseAllVideos(state.mediaByCutId, segment.cut.id);
              currentVideoCutId = segment.cut.id;
              if (entry.element.paused) {
                entry.element.play().catch(() => {});
              }
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

        // UI進捗バー更新は250ms間隔に間引き、毎フレームのレイアウト再計算を防ぐ
        if (nowMs - lastProgressUiMs >= 250) {
          lastProgressUiMs = nowMs;
          onProgress(elapsedSec / totalDurationSec);
        }
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
