import {
  computeAdaptiveVideoBitrate,
  computeCoverCropRect,
  drawCutFrame,
  resolveCutAtTime,
} from './video-engine.js';
import {
  ensureBizarreSegmenterReady,
  segmentFrameToSubjectMask,
} from './bizarre-shift-engine.js';

/**
 * タイムライン全体から固定FPS（例: 30fps）のフレーム計画と連続カットグループを生成する。
 * オフライン書き出しで時刻ズレ・コマ落ちを防ぐために使用する純粋関数。
 */
export function buildOfflineFramePlan(segments, fps = 30) {
  const safeFps = Math.max(1, Math.round(Number(fps) || 30));
  const frameDurationSec = 1 / safeFps;
  const totalDurationSec =
    Array.isArray(segments) && segments.length > 0
      ? Math.max(0, Number(segments[segments.length - 1].endSec) || 0)
      : 0;
  const totalFrames = Math.max(1, Math.round(totalDurationSec * safeFps));

  const frames = [];
  const groups = [];

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    const timestampSec = frameIndex * frameDurationSec;
    let resolved = resolveCutAtTime(segments, timestampSec);
    if (!resolved && Array.isArray(segments) && segments.length > 0) {
      const lastSeg = segments[segments.length - 1];
      resolved = {
        segment: lastSeg,
        localSec: Math.max(0, timestampSec - lastSeg.startSec),
      };
    }

    if (!resolved) {
      continue;
    }

    const segmentIndex = segments.indexOf(resolved.segment);
    const item = {
      frameIndex,
      timestampSec,
      durationSec: frameDurationSec,
      segmentIndex,
      cutId: resolved.segment.cut.id,
      localSec: resolved.localSec,
    };
    frames.push(item);

    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.segmentIndex === segmentIndex) {
      lastGroup.frames.push(item);
    } else {
      groups.push({
        segmentIndex,
        segment: resolved.segment,
        frames: [item],
      });
    }
  }

  return {
    fps: safeFps,
    frameDurationSec,
    totalDurationSec,
    totalFrames: frames.length,
    frames,
    groups,
  };
}

/**
 * トリミング範囲 `[trimStartSec, trimStartSec + totalDurationSec)` に対して音声パケットをフィルタリング・時刻シフトする。
 */
export function shiftAudioPacketTimestamp(packetTimestamp, packetDuration, trimStartSec, totalDurationSec) {
  const safeTrim = Math.max(0, Number(trimStartSec) || 0);
  const safeDur = Math.max(0, Number(totalDurationSec) || 0);
  const ts = Number(packetTimestamp) || 0;
  const dur = Math.max(0, Number(packetDuration) || 0);

  if (ts >= safeTrim + safeDur) {
    return { include: false, done: true };
  }
  if (ts + dur <= safeTrim) {
    return { include: false, done: false };
  }
  return {
    include: true,
    done: false,
    shiftedTimestamp: Math.max(0, ts - safeTrim),
  };
}

/**
 * iPhoneの4K縦/横動画デコード時に巨大Canvasを割り当てすぎないよう長辺上限を1920pxに制限するオプションを返す。
 */
export function computeDecodeCanvasMaxSize(displayWidth, displayHeight, maxLongEdge = 1920) {
  const w = Number(displayWidth) || 0;
  const h = Number(displayHeight) || 0;
  if (!w || !h || Math.max(w, h) <= maxLongEdge) {
    return {};
  }
  return w >= h ? { width: maxLongEdge } : { height: maxLongEdge };
}

async function createMediabunnyTarget(mb, templateId, useOpfs) {
  if (
    useOpfs &&
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function'
  ) {
    try {
      const root = await navigator.storage.getDirectory();
      const safePrefix = String(templateId || 'export').replace(/[^a-z0-9-_]/gi, '');
      const tempName = `auto-video-edit-wc-${safePrefix}-${Date.now()}.mp4`;
      const fileHandle = await root.getFileHandle(tempName, { create: true });

      if (typeof fileHandle.createWritable === 'function') {
        const writable = await fileHandle.createWritable();
        let closed = false;

        const writableStream = new WritableStream({
          async write(chunk) {
            await writable.write({
              type: 'write',
              position: chunk.position,
              data: chunk.data,
            });
          },
          async close() {
            if (!closed) {
              await writable.close();
              closed = true;
            }
          },
          async abort() {
            if (!closed) {
              await writable.abort().catch(() => {});
              closed = true;
            }
          },
        });

        return {
          target: new mb.StreamTarget(writableStream, { chunked: true }),
          format: new mb.Mp4OutputFormat({ fastStart: false }),
          storageMode: 'opfs',
          async finalizeBlob() {
            if (!closed) {
              await writable.close();
              closed = true;
            }
            const file = await fileHandle.getFile();
            return new Blob([file], { type: 'video/mp4' });
          },
          async cleanup() {
            try {
              if (!closed) {
                await writable.abort().catch(() => {});
                closed = true;
              }
              await root.removeEntry(tempName);
            } catch {
              // 削除済みや終了時のクリーンアップ失敗は無視する
            }
          },
        };
      }
    } catch {
      // OPFSが使えない環境（プライベートブラウズ等）ではメモリ出力にフォールバックする
    }
  }

  const bufferTarget = new mb.BufferTarget();
  return {
    target: bufferTarget,
    format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
    storageMode: 'memory',
    async finalizeBlob() {
      return new Blob([bufferTarget.buffer], { type: 'video/mp4' });
    },
    async cleanup() {},
  };
}

function seekVideoForOffline(video, timeSec) {
  return new Promise((resolve) => {
    const target = Math.max(0, Math.min(timeSec, Math.max(0, (video.duration || 1) - 0.05)));
    if (Math.abs(video.currentTime - target) < 0.01) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 350);
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

function yieldToUiThread() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * WebCodecs + Mediabunny を使って1フレームずつ正確にH.264 MP4へ書き出す。
 * リアルタイム制約によるコマ落ち（カクつき）を根本解消する。
 */
export async function exportTimelineWithWebCodecs({
  exportCanvas,
  ctx,
  segments,
  totalDurationSec,
  fps,
  width,
  height,
  state,
  templateId,
  wantsAudio,
  primaryVideoEntry,
  onProgress,
}) {
  if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function') {
    return { supported: false };
  }

  const mb = await import('../vendor/mediabunny.min.mjs');
  const videoBitsPerSecond = computeAdaptiveVideoBitrate(totalDurationSec, width);
  const canEncodeAvc = await mb.canEncodeVideo('avc', {
    width,
    height,
    bitrate: videoBitsPerSecond,
  });
  if (!canEncodeAvc) {
    return { supported: false };
  }

  // 90秒を超える長尺のみOPFSストリーミングを使用し、通常尺はFast Start付きMP4で生成する
  const targetHandle = await createMediabunnyTarget(mb, templateId, totalDurationSec > 90);
  const output = new mb.Output({
    format: targetHandle.format,
    target: targetHandle.target,
  });

  const videoSource = new mb.CanvasSource(exportCanvas, {
    codec: 'avc',
    bitrate: videoBitsPerSecond,
    keyFrameInterval: 2,
    latencyMode: 'quality',
  });
  output.addVideoTrack(videoSource, { frameRate: fps });

  let audioInput = null;
  let audioTask = null;
  let exportedWithAudio = false;
  let aborted = false;

  if (wantsAudio && primaryVideoEntry?.file) {
    try {
      audioInput = new mb.Input({
        formats: mb.ALL_FORMATS,
        source: new mb.BlobSource(primaryVideoEntry.file),
      });
      const audioTrack = await audioInput.getPrimaryAudioTrack();
      if (audioTrack) {
        const audioCodec = await audioTrack.getCodec();
        const supportedOutputCodecs = targetHandle.format.getSupportedCodecs();
        const trimStartSec = Number(primaryVideoEntry.trimStartSec) || 0;

        // 元の音声がMP4互換（AAC等）なら無劣化パススルーを優先し、AudioEncoder非対応のiOSでも音あり出力を可能にする
        if (audioCodec && supportedOutputCodecs.includes(audioCodec)) {
          const decoderConfig = await audioTrack.getDecoderConfig();
          if (decoderConfig) {
            const audioSource = new mb.EncodedAudioPacketSource(audioCodec);
            output.addAudioTrack(audioSource);
            exportedWithAudio = true;

            audioTask = async () => {
              try {
                const packetSink = new mb.EncodedPacketSink(audioTrack);
                const startPacket =
                  (await packetSink.getKeyPacket(trimStartSec)) ||
                  (await packetSink.getFirstPacket());
                let sentMetadata = false;

                if (startPacket) {
                  for await (const packet of packetSink.packets(startPacket)) {
                    if (aborted) {
                      break;
                    }
                    const shifted = shiftAudioPacketTimestamp(
                      packet.timestamp,
                      packet.duration,
                      trimStartSec,
                      totalDurationSec
                    );
                    if (shifted.done) {
                      break;
                    }
                    if (!shifted.include) {
                      continue;
                    }
                    const cloned = new mb.EncodedPacket(
                      packet.data,
                      packet.type,
                      shifted.shiftedTimestamp,
                      packet.duration,
                      packet.sequenceNumber,
                      packet.byteLength,
                      packet.sideData
                    );
                    await audioSource.add(
                      cloned,
                      sentMetadata ? undefined : { decoderConfig }
                    );
                    sentMetadata = true;
                  }
                }
              } finally {
                audioSource.close();
              }
            };
          }
        } else if (
          typeof AudioEncoder === 'function' &&
          (await mb.canEncodeAudio('aac')) &&
          (await audioTrack.canDecode())
        ) {
          const audioSource = new mb.AudioSampleSource({
            codec: 'aac',
            bitrate: 128_000,
          });
          output.addAudioTrack(audioSource);
          exportedWithAudio = true;

          audioTask = async () => {
            try {
              const sampleSink = new mb.AudioSampleSink(audioTrack);
              for await (const sample of sampleSink.samples(
                trimStartSec,
                trimStartSec + totalDurationSec
              )) {
                try {
                  if (aborted) {
                    break;
                  }
                  sample.setTimestamp(Math.max(0, sample.timestamp - trimStartSec));
                  await audioSource.add(sample);
                } finally {
                  sample.close();
                }
              }
            } finally {
              audioSource.close();
            }
          };
        }
      }
    } catch {
      // 音声トラック解析・パススルーに失敗した場合でも映像書き出し自体は継続する
      exportedWithAudio = false;
      audioTask = null;
      audioInput?.dispose?.();
      audioInput = null;
    }
  }

  try {
    const needsBizarreAi = segments.some((s) => s.cut.effect?.motion === 'bizarre-shift');
    if (needsBizarreAi) {
      await ensureBizarreSegmenterReady().catch(() => null);
    }

    await output.start();
    const plan = buildOfflineFramePlan(segments, fps);

    const videoTask = async () => {
      let processedFrames = 0;
      let lastUiMs = performance.now();

      try {
        for (const group of plan.groups) {
          if (aborted) {
            break;
          }
          const cut = group.segment.cut;
          const entry = state.mediaByCutId[cut.id];
          const text = state.textByCutId[cut.id];

          let handledByWebCodecsDecode = false;
          if (entry?.mediaType === 'video' && entry.file) {
            let cutInput = null;
            try {
              cutInput = new mb.Input({
                formats: mb.ALL_FORMATS,
                source: new mb.BlobSource(entry.file),
              });
              const videoTrack = await cutInput.getPrimaryVideoTrack();
              if (videoTrack && (await videoTrack.canDecode())) {
                handledByWebCodecsDecode = true;
                const displayW = await videoTrack.getDisplayWidth();
                const displayH = await videoTrack.getDisplayHeight();
                const firstTs = (await videoTrack.getFirstTimestamp?.()) ?? 0;
                const trackDur =
                  (await videoTrack.computeDuration?.()) || entry.durationSec || 1;
                const maxSourceTime = Math.max(firstTs, trackDur - 0.02);
                const trimStart = Number(entry.trimStartSec) || 0;

                const sink = new mb.CanvasSink(videoTrack, {
                  poolSize: 2,
                  ...computeDecodeCanvasMaxSize(displayW, displayH),
                });

                const sourceTimestamps = group.frames.map((frame) =>
                  Math.min(maxSourceTime, Math.max(firstTs, trimStart + frame.localSec))
                );
                // スケッチキャッシュ（_sketchCache）を維持するためグループ内で1つのframeEntryを再利用する
                const frameEntry = { ...entry };
                let lastCanvas = null;
                let idx = 0;

                for await (const wrapped of sink.canvasesAtTimestamps(sourceTimestamps)) {
                  if (aborted) {
                    break;
                  }
                  const frame = group.frames[idx];
                  const srcTime = sourceTimestamps[idx];
                  idx += 1;

                  if (wrapped?.canvas) {
                    lastCanvas = wrapped.canvas;
                  }
                  if (lastCanvas) {
                    frameEntry.element = lastCanvas;
                    frameEntry.width = lastCanvas.width;
                    frameEntry.height = lastCanvas.height;
                    frameEntry.overrideVideoTimeSec = srcTime;
                    if (cut.effect?.motion === 'bizarre-shift') {
                      const triggerSec = frameEntry.bizarreTriggerSec ?? 2.0;
                      if (frame.localSec >= triggerSec) {
                        const crop = computeCoverCropRect(
                          frameEntry.width,
                          frameEntry.height,
                          width,
                          height,
                          'none',
                          0
                        );
                        frameEntry.subjectMask =
                          (await segmentFrameToSubjectMask(
                            frameEntry.element,
                            crop,
                            width,
                            height
                          ).catch(() => null)) || frameEntry.subjectMask;
                      } else {
                        frameEntry.subjectMask = null;
                      }
                    }
                    drawCutFrame(ctx, cut, frameEntry, frame.localSec, width, height, text);
                  } else {
                    drawCutFrame(ctx, cut, entry, frame.localSec, width, height, text);
                  }

                  await videoSource.add(frame.timestampSec, frame.durationSec);
                  processedFrames += 1;

                  const now = performance.now();
                  if (now - lastUiMs >= 120) {
                    lastUiMs = now;
                    onProgress?.(processedFrames / plan.totalFrames);
                  }
                  if (processedFrames % 10 === 0) {
                    await yieldToUiThread();
                  }
                }
              }
            } finally {
              cutInput?.dispose?.();
            }
          }

          if (!handledByWebCodecsDecode) {
            const frameEntry = entry ? { ...entry } : entry;
            for (const frame of group.frames) {
              if (aborted) {
                break;
              }
              if (entry?.mediaType === 'video' && entry.element) {
                const srcTime = Math.min(
                  Math.max(0, (entry.durationSec || 1) - 0.05),
                  (Number(entry.trimStartSec) || 0) + frame.localSec
                );
                await seekVideoForOffline(entry.element, srcTime);
                frameEntry.overrideVideoTimeSec = srcTime;
                if (cut.effect?.motion === 'bizarre-shift') {
                  const triggerSec = frameEntry.bizarreTriggerSec ?? 2.0;
                  if (frame.localSec >= triggerSec) {
                    const crop = computeCoverCropRect(
                      frameEntry.width,
                      frameEntry.height,
                      width,
                      height,
                      'none',
                      0
                    );
                    frameEntry.subjectMask =
                      (await segmentFrameToSubjectMask(
                        frameEntry.element,
                        crop,
                        width,
                        height
                      ).catch(() => null)) || frameEntry.subjectMask;
                  } else {
                    frameEntry.subjectMask = null;
                  }
                }
                drawCutFrame(ctx, cut, frameEntry, frame.localSec, width, height, text);
              } else if (entry && cut.effect?.motion === 'bizarre-shift' && entry.element) {
                const triggerSec = frameEntry.bizarreTriggerSec ?? 2.0;
                if (frame.localSec >= triggerSec && !frameEntry._cachedImageMask) {
                  const crop = computeCoverCropRect(
                    frameEntry.width,
                    frameEntry.height,
                    width,
                    height,
                    'none',
                    0
                  );
                  frameEntry._cachedImageMask = await segmentFrameToSubjectMask(
                    frameEntry.element,
                    crop,
                    width,
                    height
                  ).catch(() => null);
                }
                frameEntry.subjectMask =
                  frame.localSec >= triggerSec ? frameEntry._cachedImageMask : null;
                drawCutFrame(ctx, cut, frameEntry, frame.localSec, width, height, text);
              } else {
                drawCutFrame(ctx, cut, entry, frame.localSec, width, height, text);
              }

              await videoSource.add(frame.timestampSec, frame.durationSec);
              processedFrames += 1;

              const now = performance.now();
              if (now - lastUiMs >= 120) {
                lastUiMs = now;
                onProgress?.(processedFrames / plan.totalFrames);
              }
              if (processedFrames % 10 === 0) {
                await yieldToUiThread();
              }
            }
          }
        }
      } finally {
        videoSource.close();
      }
    };

    await Promise.all(audioTask ? [videoTask(), audioTask()] : [videoTask()]);
    onProgress?.(1);
    await output.finalize();
    const blob = await targetHandle.finalizeBlob();

    return {
      supported: true,
      blob,
      exportedWithAudio,
      storageMode: targetHandle.storageMode,
      cleanup: targetHandle.cleanup,
    };
  } catch (error) {
    aborted = true;
    await output.cancel?.().catch(() => {});
    await targetHandle.cleanup();
    throw error;
  } finally {
    audioInput?.dispose?.();
  }
}
