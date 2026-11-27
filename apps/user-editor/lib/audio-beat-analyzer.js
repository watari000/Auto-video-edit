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
 * ビート強度に応じて画面の縁がバックライトのように微かに発光する状態を返す（純粋関数）。
 */
export function computeBeatBacklightState(beatStrength, intensity = 0.6) {
  const strength = clamp(Number(beatStrength) || 0, 0, 1);
  const safeIntensity = clamp(Number(intensity) || 0, 0, 1.5);

  if (strength < 0.28 || safeIntensity <= 0) {
    return { alpha: 0, spreadRatio: 0, edgeLineAlpha: 0 };
  }

  const excess = (strength - 0.28) / 0.72;
  return {
    alpha: Number(clamp(0.14 + 0.34 * excess * safeIntensity, 0, 0.58).toFixed(4)),
    spreadRatio: Number(clamp(0.055 + 0.055 * excess * safeIntensity, 0.04, 0.14).toFixed(4)),
    edgeLineAlpha: Number(clamp(0.2 + 0.45 * excess * safeIntensity, 0, 0.75).toFixed(4)),
  };
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

    // 最大5分の動画でもiOS Safariのメモリ消費を抑えるため、ステレオ時も複製配列を作らずLchを直接解析する
    const channel0 = audioBuffer.getChannelData(0);
    const result = computeBeatEnvelopeFromPcm(channel0, audioBuffer.sampleRate, BEAT_ENVELOPE_HZ);
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
