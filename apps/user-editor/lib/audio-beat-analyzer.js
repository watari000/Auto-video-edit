export const BEAT_ENVELOPE_HZ = 30;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * モノラルPCM配列から主旋律帯域（260Hz〜2,600Hz）の音圧を抽出し、滑らかなエンベロープ（0..1）を返す（純粋関数）。
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

  // 主旋律（ボーカル・リード楽器）が集中する260Hz〜2,600Hz付近を残し、キック低音や高域ノイズを抑える
  const hpHz = Math.min(260, sampleRate * 0.25);
  const lpHz = Math.min(2600, sampleRate * 0.42);
  const dt = 1 / sampleRate;
  const rcHp = 1 / (2 * Math.PI * Math.max(1, hpHz));
  const rcLp = 1 / (2 * Math.PI * Math.max(1, lpHz));
  const alphaHp = rcHp / (rcHp + dt);
  const alphaLp = dt / (rcLp + dt);

  let hpPrevIn = 0;
  let hpPrevOut = 0;
  let lpPrevOut = 0;

  const rms = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const start = i * windowSize;
    let sumSq = 0;
    for (let j = 0; j < windowSize; j++) {
      const sample = channelData[start + j];
      const hpOut = alphaHp * (hpPrevOut + sample - hpPrevIn);
      hpPrevIn = sample;
      hpPrevOut = hpOut;

      const lpOut = lpPrevOut + alphaLp * (hpOut - lpPrevOut);
      lpPrevOut = lpOut;
      sumSq += lpOut * lpOut;
    }
    rms[i] = Math.sqrt(sumSq / windowSize);
  }

  const sorted = Float32Array.from(rms).sort();
  const p15 = sorted[Math.floor((frameCount - 1) * 0.15)];
  const p95 = sorted[Math.floor((frameCount - 1) * 0.95)];

  const envelope = new Float32Array(frameCount);
  if (p95 <= 1e-6) {
    return { envelope, envelopeHz, peakCount: 0, durationSec };
  }

  const span = Math.max(p95 - p15, p95 * 0.35, 1e-6);
  let smoothed = 0;

  for (let i = 0; i < frameCount; i++) {
    const normalized = clamp((rms[i] - p15 * 0.85) / span, 0, 1);
    // 立ち上がりは素早く、減衰は余韻を持たせて主旋律の歌い回しに沿って滑らかに光らせる
    const coeff = normalized > smoothed ? 0.48 : 0.18;
    smoothed += coeff * (normalized - smoothed);
    envelope[i] = clamp(smoothed, 0, 1);
  }

  const minPeakGapFrames = Math.max(1, Math.round(envelopeHz * 0.35));
  let peakCount = 0;
  let lastPeakFrame = -minPeakGapFrames;

  for (let i = 1; i < frameCount - 1; i++) {
    const cur = envelope[i];
    if (
      cur > 0.55 &&
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
 * 解析済み主旋律配列から指定時刻（秒）の強度（0..1）を取得する。
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
 * 主旋律の抑揚に応じて画面の縁がバックライトのように滑らかに発光する状態を返す（純粋関数）。
 */
export function computeBeatBacklightState(beatStrength, intensity = 0.6) {
  const strength = clamp(Number(beatStrength) || 0, 0, 1);
  const safeIntensity = clamp(Number(intensity) || 0, 0, 1.5);

  if (strength < 0.04 || safeIntensity <= 0) {
    return { alpha: 0, spreadRatio: 0, edgeLineAlpha: 0 };
  }

  const curved = Math.pow(strength, 1.35);
  return {
    alpha: Number(clamp(0.06 + 0.42 * curved * safeIntensity, 0, 0.56).toFixed(4)),
    spreadRatio: Number(clamp(0.045 + 0.075 * curved * safeIntensity, 0.04, 0.15).toFixed(4)),
    edgeLineAlpha: Number(clamp(0.08 + 0.52 * curved * safeIntensity, 0, 0.72).toFixed(4)),
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
