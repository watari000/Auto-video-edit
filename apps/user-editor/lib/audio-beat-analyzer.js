export const BEAT_ENVELOPE_HZ = 30;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * モノラルPCM配列から音圧の立ち上がり（ビート強度エンベロープ 0..1）を計算する（純粋関数）。
 */
export function computeBeatEnvelopeFromPcm(channelData, sampleRate, envelopeHz = BEAT_ENVELOPE_HZ) {
  if (!channelData || !channelData.length || !sampleRate || sampleRate <= 0) {
    return { envelope: new Float32Array(0), envelopeHz, peakCount: 0, durationSec: 0 };
  }

  const windowSize = Math.max(1, Math.floor(sampleRate / envelopeHz));
  const frameCount = Math.floor(channelData.length / windowSize);
  const durationSec = channelData.length / sampleRate;

  if (frameCount === 0) {
    return { envelope: new Float32Array(0), envelopeHz, peakCount: 0, durationSec };
  }

  const rms = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const start = i * windowSize;
    let sumSq = 0;
    for (let j = 0; j < windowSize; j++) {
      const sample = channelData[start + j];
      sumSq += sample * sample;
    }
    rms[i] = Math.sqrt(sumSq / windowSize);
  }

  const lookback = Math.max(1, Math.round(envelopeHz * 0.4));
  const rawFlux = new Float32Array(frameCount);
  let maxFlux = 0;

  for (let i = 0; i < frameCount; i++) {
    const from = Math.max(0, i - lookback);
    let sum = 0;
    for (let k = from; k < i; k++) {
      sum += rms[k];
    }
    const localAvg = i > from ? sum / (i - from) : 0;
    const onset = Math.max(0, rms[i] - localAvg * 0.85) + rms[i] * 0.25;
    rawFlux[i] = onset;
    if (onset > maxFlux) {
      maxFlux = onset;
    }
  }

  const envelope = new Float32Array(frameCount);
  if (maxFlux <= 1e-6) {
    return { envelope, envelopeHz, peakCount: 0, durationSec };
  }

  for (let i = 0; i < frameCount; i++) {
    envelope[i] = clamp(rawFlux[i] / maxFlux, 0, 1);
  }

  const minPeakGapFrames = Math.max(1, Math.round(envelopeHz * 0.22));
  let peakCount = 0;
  let lastPeakFrame = -minPeakGapFrames;

  for (let i = 1; i < frameCount - 1; i++) {
    const cur = envelope[i];
    if (
      cur > 0.45 &&
      cur >= envelope[i - 1] &&
      cur >= envelope[i + 1] &&
      i - lastPeakFrame >= minPeakGapFrames
    ) {
      peakCount += 1;
      lastPeakFrame = i;
    }
  }

  return { envelope, envelopeHz, peakCount, durationSec };
}

/**
 * 解析済みビート配列から指定時刻（秒）のビート強度（0..1）を取得する。
 */
export function sampleBeatStrengthAt(beatAnalysis, timeSec) {
  const envelope = beatAnalysis?.envelope;
  const hz = beatAnalysis?.envelopeHz || BEAT_ENVELOPE_HZ;
  if (!envelope || envelope.length === 0) {
    return 0;
  }
  const idx = clamp(Math.round((Number(timeSec) || 0) * hz), 0, envelope.length - 1);
  return envelope[idx];
}

/**
 * ビート強度に応じてカメラをわずかに揺らす正規化オフセットと黒縁防止ズーム量を返す（純粋関数）。
 */
export function computeBeatShakeOffset(beatStrength, timeSec, intensity = 0.6) {
  const strength = clamp(Number(beatStrength) || 0, 0, 1);
  const safeIntensity = clamp(Number(intensity) || 0, 0, 1.5);

  if (strength < 0.32 || safeIntensity <= 0) {
    return { offsetX: 0, offsetY: 0, zoomBoost: 0 };
  }

  const excess = (strength - 0.32) / 0.68;
  const t = Number(timeSec) || 0;
  // 揺れ幅を最大約1.4%前後に抑えて見やすさを維持しつつ、黒縁が出ないよう少しズームする
  const amplitude = 0.014 * excess * safeIntensity;
  const offsetX = Number((Math.sin(t * 42) * amplitude).toFixed(5));
  const offsetY = Number((Math.cos(t * 53 + 1.1) * amplitude * 0.85).toFixed(5));
  const zoomBoost = Number((0.03 + 0.035 * excess * safeIntensity).toFixed(5));

  return { offsetX, offsetY, zoomBoost };
}

/**
 * ローカルの動画ファイルをブラウザ内（Web Audio API）だけでデコードし、音声ビートを解析する。
 * 外部サーバーへの送信は一切行わない（RULE 02）。
 */
export async function analyzeVideoFileBeats(file) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!file || !AudioCtx) {
    return { envelope: null, envelopeHz: BEAT_ENVELOPE_HZ, peakCount: 0, durationSec: 0, hasAudio: false };
  }

  let audioCtx;
  try {
    const arrayBuffer = await file.arrayBuffer();
    audioCtx = new AudioCtx();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    const channel0 = audioBuffer.getChannelData(0);
    let mono = channel0;
    if (audioBuffer.numberOfChannels > 1) {
      const channel1 = audioBuffer.getChannelData(1);
      mono = new Float32Array(channel0.length);
      for (let i = 0; i < channel0.length; i++) {
        mono[i] = (channel0[i] + channel1[i]) * 0.5;
      }
    }

    const result = computeBeatEnvelopeFromPcm(mono, audioBuffer.sampleRate, BEAT_ENVELOPE_HZ);
    return {
      ...result,
      hasAudio: result.peakCount > 0 || result.envelope.some((v) => v > 0.05),
    };
  } catch {
    return { envelope: null, envelopeHz: BEAT_ENVELOPE_HZ, peakCount: 0, durationSec: 0, hasAudio: false };
  } finally {
    if (audioCtx && typeof audioCtx.close === 'function') {
      audioCtx.close().catch(() => {});
    }
  }
}
