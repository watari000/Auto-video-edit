import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateTemplateData } from '../apps/user-editor/lib/template-loader.js';
import {
  MAX_OUTPUT_FPS,
  MAX_OUTPUT_HEIGHT,
  MAX_OUTPUT_WIDTH,
  buildTimelineSegments,
  computeAdaptiveVideoBitrate,
  computeCoverCropRect,
  computeFlashOverlayAlpha,
  computeKineticTokenState,
  computeSafeRenderDimensions,
  computeSketchRevealState,
  generateSketchImageData,
  getCanvasFilterString,
  parseKineticTokens,
  resolveCutAtTime,
  selectSupportedRecorderMimeType,
  shouldUseFastOverlayFilter,
} from '../apps/user-editor/lib/video-engine.js';
import {
  computeBeatBacklightState,
  computeBeatEnvelopeFromPcm,
  sampleEqualizerBarsAt,
} from '../apps/user-editor/lib/audio-beat-analyzer.js';
import { createRecordingChunkSink } from '../apps/user-editor/lib/opfs-chunk-sink.js';
import {
  PART_CLOTHES,
  PART_EYES,
  PART_HAIR,
  PART_LIPS,
  PART_SKIN,
  buildBizarreColorLut,
  buildSubjectPartMask,
  computeBizarreShiftState,
  extractSubjectMask,
  stylizeSubjectPartPixels,
  stylizeSubjectPixels,
} from '../apps/user-editor/lib/bizarre-shift-engine.js';
import {
  buildOfflineFramePlan,
  computeDecodeCanvasMaxSize,
  shiftAudioPacketTimestamp,
} from '../apps/user-editor/lib/webcodecs-exporter.js';
import {
  computeGridEdgeMap,
  computeMatrixWorldState,
  normalizeLumaContrast,
  sampleMatrixCell,
} from '../apps/user-editor/lib/matrix-code-engine.js';
import { evaluateMediaMetadata } from '../apps/user-editor/src/precheck/media-precheck.js';
import { APP_UPDATED_AT, APP_VERSION } from '../apps/user-editor/src/version.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('template.schema.json parses as valid Draft 2020-12 JSON Schema', async () => {
  const schemaPath = path.join(REPO_ROOT, 'shared', 'schemas', 'template.schema.json');
  const raw = await fs.readFile(schemaPath, 'utf8');
  const schema = JSON.parse(raw);

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.ok(Array.isArray(schema.required));
  assert.ok(schema.required.includes('cuts'));
  assert.equal(schema.properties.output.properties.muted.const, true);
});

test('sample-cafe-01/template.json validates and all guide-assets exist', async () => {
  const templateDir = path.join(REPO_ROOT, 'shared', 'templates', 'sample-cafe-01');
  const raw = await fs.readFile(path.join(templateDir, 'template.json'), 'utf8');
  const template = JSON.parse(raw);

  const result = validateTemplateData(template);
  assert.equal(result.valid, true, `Validation errors: ${result.errors.join(', ')}`);
  assert.equal(template.output.muted, true);
  assert.equal(template.cuts.length, 3);

  for (const cut of template.cuts) {
    const assetPath = path.join(templateDir, cut.shootingGuide.silhouetteAsset);
    const stat = await fs.stat(assetPath);
    assert.ok(stat.isFile(), `Missing silhouette asset: ${assetPath}`);
  }
});

test('shared/templates/index.json lists >= 7 valid templates with existing assets and unique IDs', async () => {
  const templatesRoot = path.join(REPO_ROOT, 'shared', 'templates');
  const catalogRaw = await fs.readFile(path.join(templatesRoot, 'index.json'), 'utf8');
  const catalog = JSON.parse(catalogRaw);

  assert.ok(Array.isArray(catalog) && catalog.length >= 9);
  const seenIds = new Set();

  for (const entry of catalog) {
    assert.equal(seenIds.has(entry.id), false, `Duplicate template id: ${entry.id}`);
    seenIds.add(entry.id);

    const coverStat = await fs.stat(path.join(templatesRoot, entry.coverAsset));
    assert.ok(coverStat.isFile(), `Missing coverAsset: ${entry.coverAsset}`);

    const templatePath = path.join(templatesRoot, entry.templatePath);
    const templateRaw = await fs.readFile(templatePath, 'utf8');
    const template = JSON.parse(templateRaw);

    const validation = validateTemplateData(template);
    assert.equal(validation.valid, true, `${entry.id} errors: ${validation.errors.join(', ')}`);
    assert.equal(template.id, entry.id);
    assert.equal(template.cuts.length, entry.cutCount);

    const totalSec = Number(template.cuts.reduce((sum, c) => sum + c.durationSec, 0).toFixed(1));
    assert.equal(totalSec, entry.durationSec);

    const templateDir = path.dirname(templatePath);
    for (const cut of template.cuts) {
      const svgStat = await fs.stat(path.join(templateDir, cut.shootingGuide.silhouetteAsset));
      assert.ok(svgStat.isFile(), `Missing SVG for ${entry.id}/${cut.id}`);
    }
  }

  assert.equal(seenIds.has('sample-sketch-art-04'), true);
  assert.equal(seenIds.has('sample-kinetic-caption-05'), true);
  assert.equal(seenIds.has('sample-rapid-recap-06'), true);
  assert.equal(seenIds.has('sample-dance-beat-07'), true);
  assert.equal(seenIds.has('sample-bizarre-shift-08'), true);
  assert.equal(seenIds.has('sample-matrix-code-09'), true);
});

test('validateTemplateData rejects invalid muted=false or missing cuts', () => {
  const invalid = {
    schemaVersion: '1.0.0',
    id: 'Bad_ID',
    title: 'test',
    description: 'desc',
    status: 'published',
    aspectRatio: '9:16',
    output: { width: 1080, height: 1920, fps: 30, muted: false },
    audioGuide: { mood: 'chill', bpmRange: { min: 120, max: 90 }, suggestedSearchKeywords: ['a'], note: 'n' },
    cuts: [],
  };

  const result = validateTemplateData(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 3);
});

test('computeSafeRenderDimensions enforces iOS Safari caps and even pixel sizes', () => {
  const full = computeSafeRenderDimensions({ width: 4000, height: 4000, fps: 60 }, 1);
  assert.equal(full.width, MAX_OUTPUT_WIDTH);
  assert.equal(full.height, MAX_OUTPUT_HEIGHT);
  assert.equal(full.fps, MAX_OUTPUT_FPS);

  const scaled = computeSafeRenderDimensions({ width: 1080, height: 1920, fps: 30 }, 0.6667);
  assert.equal(scaled.width % 2, 0);
  assert.equal(scaled.height % 2, 0);
  assert.ok(scaled.width <= 720 && scaled.height <= 1280);
});

test('computeCoverCropRect handles landscape to 9:16 crop and zoom-in motion', () => {
  const startCrop = computeCoverCropRect(1920, 1080, 1080, 1920, 'zoom-in', 0);
  const endCrop = computeCoverCropRect(1920, 1080, 1080, 1920, 'zoom-in', 1);

  assert.equal(Math.round(startCrop.sh), 1080);
  assert.equal(Math.round(startCrop.sw), 608);
  assert.ok(endCrop.sw < startCrop.sw);
  assert.ok(endCrop.sh < startCrop.sh);
});

test('getCanvasFilterString returns expected CSS filters', () => {
  assert.equal(getCanvasFilterString('none'), 'none');
  assert.match(getCanvasFilterString('warm'), /sepia/);
  assert.match(getCanvasFilterString('vivid'), /saturate/);
});

test('buildTimelineSegments and resolveCutAtTime map timestamps accurately', () => {
  const { segments, totalDurationSec } = buildTimelineSegments([
    { id: 'c2', order: 2, durationSec: 2.0 },
    { id: 'c1', order: 1, durationSec: 1.5 },
    { id: 'c3', order: 3, durationSec: 1.5 },
  ]);

  assert.equal(totalDurationSec, 5.0);
  assert.equal(segments[0].cut.id, 'c1');

  const atFirst = resolveCutAtTime(segments, 0.5);
  assert.equal(atFirst.segment.cut.id, 'c1');
  assert.equal(atFirst.localSec, 0.5);

  const atSecond = resolveCutAtTime(segments, 2.5);
  assert.equal(atSecond.segment.cut.id, 'c2');
  assert.equal(atSecond.localSec, 1.0);
});

test('evaluateMediaMetadata returns friendly Japanese warnings for landscape, dark, and short videos', () => {
  const landscapeDarkShort = evaluateMediaMetadata({
    width: 1920,
    height: 1080,
    durationSec: 1.0,
    requiredDurationSec: 1.5,
    averageLuma: 30,
    mediaType: 'video',
  });
  assert.equal(landscapeDarkShort.warnings.length, 3);
  assert.deepEqual(
    landscapeDarkShort.warnings.map((w) => w.code),
    ['LANDSCAPE_MEDIA', 'DARK_MEDIA', 'SHORT_VIDEO']
  );

  const cleanVertical = evaluateMediaMetadata({
    width: 1080,
    height: 1920,
    durationSec: 3.0,
    requiredDurationSec: 1.5,
    averageLuma: 140,
    mediaType: 'video',
  });
  assert.equal(cleanVertical.warnings.length, 0);
});

test('apps/user-editor contains no media upload calls (RULE 02 zero-server privacy)', async () => {
  const editorDir = path.join(REPO_ROOT, 'apps', 'user-editor');
  const jsFiles = [];

  async function collectJs(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectJs(fullPath);
      } else if (entry.name.endsWith('.js')) {
        jsFiles.push(fullPath);
      }
    }
  }

  await collectJs(editorDir);
  assert.ok(jsFiles.length >= 6);

  for (const filePath of jsFiles) {
    const content = await fs.readFile(filePath, 'utf8');
    assert.equal(/XMLHttpRequest/.test(content), false, `Forbidden XMLHttpRequest in ${filePath}`);
    assert.equal(/sendBeacon/.test(content), false, `Forbidden sendBeacon in ${filePath}`);
    assert.equal(/method\s*:\s*['"]POST['"]/i.test(content), false, `Forbidden POST in ${filePath}`);
  }
});

test('computeSketchRevealState transitions through sketch-hold, revealing, and reality phases', () => {
  const hold = computeSketchRevealState(0.2, 2.2);
  assert.equal(hold.phase, 'sketch-hold');
  assert.equal(hold.revealRatio, 0);
  assert.ok(hold.frameDrawProgress > 0 && hold.frameDrawProgress < 1);

  const revealing = computeSketchRevealState(1.0, 2.2);
  assert.equal(revealing.phase, 'revealing');
  assert.ok(revealing.revealRatio > 0 && revealing.revealRatio < 1);

  const reality = computeSketchRevealState(1.8, 2.2);
  assert.equal(reality.phase, 'reality');
  assert.equal(reality.revealRatio, 1);
});

test('generateSketchImageData renders paper on flat regions and ink on sharp edges', () => {
  const width = 5;
  const height = 5;
  const flatRgba = new Uint8ClampedArray(width * height * 4).fill(120);
  const flatSketch = generateSketchImageData(flatRgba, width, height, 'ink-paper');
  const centerIdx = (2 * width + 2) * 4;
  assert.equal(flatSketch[centerIdx], 244);
  assert.equal(flatSketch[centerIdx + 1], 239);
  assert.equal(flatSketch[centerIdx + 2], 228);

  const edgeRgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = x >= 2 ? 255 : 0;
      const idx = (y * width + x) * 4;
      edgeRgba[idx] = v;
      edgeRgba[idx + 1] = v;
      edgeRgba[idx + 2] = v;
      edgeRgba[idx + 3] = 255;
    }
  }
  const edgeSketch = generateSketchImageData(edgeRgba, width, height, 'ink-paper');
  assert.equal(edgeSketch[centerIdx], 30);
  assert.equal(edgeSketch[centerIdx + 1], 27);
  assert.equal(edgeSketch[centerIdx + 2], 24);
});

test('parseKineticTokens extracts *keyword* emphasis and falls back to last word', () => {
  const explicit = parseKineticTokens('今日の *主役* は これ');
  assert.deepEqual(explicit, [
    { text: '今日の', emphasized: false },
    { text: '主役', emphasized: true },
    { text: 'は', emphasized: false },
    { text: 'これ', emphasized: false },
  ]);

  const fallback = parseKineticTokens('今すぐ 保存 してね');
  assert.deepEqual(fallback, [
    { text: '今すぐ', emphasized: false },
    { text: '保存', emphasized: false },
    { text: 'してね', emphasized: true },
  ]);
});

test('computeKineticTokenState staggers word appearance and pop-in animation', () => {
  const hidden = computeKineticTokenState(2, 4, 0.1, 1.6);
  assert.equal(hidden.visible, false);
  assert.equal(hidden.opacity, 0);

  const popping = computeKineticTokenState(1, 4, 0.35, 1.6);
  assert.equal(popping.visible, true);
  assert.ok(popping.scale > 0.6);

  const settled = computeKineticTokenState(0, 4, 1.2, 1.6);
  assert.equal(settled.visible, true);
  assert.equal(settled.opacity, 1);
  assert.equal(settled.scale, 1);
});

test('computeFlashOverlayAlpha peaks at 0s and decays to 0 after 0.09s', () => {
  assert.equal(computeFlashOverlayAlpha(0), 0.55);
  assert.ok(computeFlashOverlayAlpha(0.045) > 0.2 && computeFlashOverlayAlpha(0.045) < 0.35);
  assert.equal(computeFlashOverlayAlpha(0.09), 0);
  assert.equal(computeFlashOverlayAlpha(0.5), 0);
});

test('computeBeatEnvelopeFromPcm tracks melody-band phrases and computeBeatBacklightState glows smoothly', () => {
  const sampleRate = 8000;
  const silent = new Float32Array(sampleRate * 2);
  const silentResult = computeBeatEnvelopeFromPcm(silent, sampleRate);
  assert.equal(silentResult.peakCount, 0);
  assert.equal(silentResult.bandCount, 8);
  const silentBars = sampleEqualizerBarsAt(silentResult, 0.5, 24);
  assert.equal(silentBars.length, 24);
  assert.ok(silentBars.every((v) => v === 0));

  const melody = new Float32Array(sampleRate * 3);
  // 0.3s, 1.1s, 1.9s に主旋律帯域（600Hz）のフレーズを配置
  for (const phraseSec of [0.3, 1.1, 1.9]) {
    const start = Math.floor(phraseSec * sampleRate);
    for (let j = 0; j < Math.floor(sampleRate * 0.35) && start + j < melody.length; j++) {
      melody[start + j] = Math.sin((2 * Math.PI * 600 * j) / sampleRate) * 0.85;
    }
  }
  const melodyResult = computeBeatEnvelopeFromPcm(melody, sampleRate);
  assert.ok(melodyResult.peakCount >= 2, `Expected >= 2 melody peaks, got ${melodyResult.peakCount}`);
  const activeBars = sampleEqualizerBarsAt(melodyResult, 0.45, 24);
  assert.equal(activeBars.length, 24);
  assert.ok(activeBars.some((v) => v > 0.2), 'Expected equalizer bars to react to melody phrase');
  assert.ok(activeBars.every((v) => v >= 0 && v <= 1));

  const quiet = computeBeatBacklightState(0.02, 0.6);
  assert.equal(quiet.alpha, 0);
  assert.equal(quiet.spreadRatio, 0);
  assert.equal(quiet.edgeLineAlpha, 0);

  const gentle = computeBeatBacklightState(0.4, 0.6);
  const swell = computeBeatBacklightState(0.95, 0.6);
  assert.ok(gentle.alpha > 0.06 && gentle.alpha < swell.alpha);
  assert.ok(swell.alpha <= 0.56);
  assert.ok(swell.spreadRatio <= 0.15);
  assert.ok(swell.edgeLineAlpha <= 0.72);
});

test('computeAdaptiveVideoBitrate scales down for >60s clips and createRecordingChunkSink falls back cleanly', async () => {
  assert.equal(computeAdaptiveVideoBitrate(15, 1080), 4_500_000);
  assert.equal(computeAdaptiveVideoBitrate(300, 720), 2_200_000);
  assert.equal(computeAdaptiveVideoBitrate(300, 1080), 3_000_000);

  const sink = await createRecordingChunkSink('test-clip');
  assert.equal(sink.mode, 'memory');
  sink.append(new Blob(['hello ']));
  sink.append(new Blob(['world']));
  const resultBlob = await sink.finalize('video/mp4');
  assert.equal(resultBlob.size, 11);
  assert.equal(resultBlob.type, 'video/mp4');
  await sink.cleanup();
});

test('shouldUseFastOverlayFilter enables GPU overlay fallback on iOS Safari and disables on desktop Chrome', () => {
  assert.equal(
    shouldUseFastOverlayFilter(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    ),
    true
  );
  assert.equal(
    shouldUseFastOverlayFilter(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    ),
    false
  );
});

test('selectSupportedRecorderMimeType selects H.264+AAC MP4 when audio is included', () => {
  const originalMediaRecorder = globalThis.MediaRecorder;
  try {
    const supported = new Set([
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
    ]);
    globalThis.MediaRecorder = {
      isTypeSupported(type) {
        return supported.has(type);
      },
    };
    assert.equal(
      selectSupportedRecorderMimeType(true),
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2'
    );
    assert.equal(
      selectSupportedRecorderMimeType(false),
      'video/mp4;codecs=avc1.42E01E'
    );

    supported.delete('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
    assert.equal(selectSupportedRecorderMimeType(true), 'video/mp4');
  } finally {
    if (originalMediaRecorder === undefined) {
      delete globalThis.MediaRecorder;
    } else {
      globalThis.MediaRecorder = originalMediaRecorder;
    }
  }
});

test('apps/user-editor version metadata matches index.html badge and cache-busting query', async () => {
  assert.match(APP_VERSION, /^v\d+\.\d+\.\d+$/);
  const html = await fs.readFile(path.join(REPO_ROOT, 'apps/user-editor/index.html'), 'utf8');
  assert.ok(html.includes(`>${APP_VERSION}<`), 'Expected header badge in index.html to match APP_VERSION');
  assert.ok(
    html.includes(`VERSION: ${APP_VERSION} (${APP_UPDATED_AT})`),
    'Expected footer version text in index.html to match APP_VERSION and APP_UPDATED_AT'
  );
  assert.ok(
    html.includes(`./src/main.js?v=${APP_VERSION.slice(1)}`),
    'Expected cache-busting query on main.js in index.html to match APP_VERSION'
  );
});

test('webcodecs-exporter helpers build exact 30fps plans, shift audio timestamps, and cap 4K decode size', async () => {
  const { segments } = buildTimelineSegments([
    { id: 'c1', durationSec: 1.0 },
    { id: 'c2', durationSec: 2.0 },
  ]);
  const plan = buildOfflineFramePlan(segments, 30);
  assert.equal(plan.fps, 30);
  assert.equal(plan.totalFrames, 90);
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.groups[0].cutId ?? plan.groups[0].segment.cut.id, 'c1');
  assert.equal(plan.groups[0].frames.length, 30);
  assert.equal(plan.groups[1].frames.length, 60);
  assert.equal(plan.frames[0].timestampSec, 0);
  assert.ok(Math.abs(plan.frames[89].timestampSec - 89 / 30) < 1e-9);

  assert.deepEqual(shiftAudioPacketTimestamp(1.0, 0.02, 2.0, 5.0), {
    include: false,
    done: false,
  });
  assert.deepEqual(shiftAudioPacketTimestamp(2.5, 0.02, 2.0, 5.0), {
    include: true,
    done: false,
    shiftedTimestamp: 0.5,
  });
  assert.deepEqual(shiftAudioPacketTimestamp(7.0, 0.02, 2.0, 5.0), {
    include: false,
    done: true,
  });

  assert.deepEqual(computeDecodeCanvasMaxSize(1080, 1920), {});
  assert.deepEqual(computeDecodeCanvasMaxSize(2160, 3840), { height: 1920 });
  assert.deepEqual(computeDecodeCanvasMaxSize(3840, 2160), { width: 1920 });

  const mb = await import('../apps/user-editor/vendor/mediabunny.min.mjs');
  for (const symbol of [
    'Output',
    'Mp4OutputFormat',
    'CanvasSource',
    'BufferTarget',
    'StreamTarget',
    'Input',
    'BlobSource',
    'CanvasSink',
    'EncodedPacketSink',
    'EncodedAudioPacketSource',
    'EncodedPacket',
    'ALL_FORMATS',
    'canEncodeVideo',
  ]) {
    assert.ok(mb[symbol], `Expected vendored mediabunny.min.mjs to export ${symbol}`);
  }
});

test('sample-bizarre-shift-08 defaults source audio to OFF and bizarre-shift-engine isolates subject only', async () => {
  const raw = await fs.readFile(
    path.join(REPO_ROOT, 'shared', 'templates', 'sample-bizarre-shift-08', 'template.json'),
    'utf8'
  );
  const template = JSON.parse(raw);
  assert.equal(template.inputMode, 'bizarre-shift');
  assert.equal(template.allowSourceAudio, true);
  assert.equal(template.defaultIncludeAudio, false);

  const normal = computeBizarreShiftState(1.9, 2.0);
  assert.equal(normal.phase, 'normal');
  assert.equal(normal.shiftBlend, 0);

  const glitchEarly = computeBizarreShiftState(2.04, 2.0, 0.18);
  assert.equal(glitchEarly.phase, 'glitch');
  assert.ok(glitchEarly.glitchIntensity > 0);
  assert.equal(glitchEarly.shiftBlend, 0);

  const shifted = computeBizarreShiftState(2.2, 2.0, 0.18);
  assert.equal(shifted.phase, 'shifted');
  assert.equal(shifted.shiftBlend, 1);

  // 5x5 マスク中央 3x3 に人物(15)・犬(12)・猫(8)、周囲に背景(0)・椅子(9)を配置
  const classes = new Uint8Array([
    0, 0, 9, 0, 0,
    0, 15, 12, 8, 0,
    9, 15, 12, 8, 0,
    0, 15, 12, 8, 0,
    0, 0, 0, 9, 0,
  ]);
  const extracted = extractSubjectMask(classes, 5, 5);
  assert.ok(extracted.subjectPixelCount >= 6);
  assert.equal(extracted.mask[0], 0);
  assert.ok(extracted.mask[2 * 5 + 2] > 0);

  const lut = buildBizarreColorLut('golden-bizarre', 'anime-ink');
  assert.equal(lut.length, 256 * 3);

  const srcRgba = new Uint8ClampedArray(25 * 4).fill(180);
  const outOnlyColor = stylizeSubjectPixels(srcRgba, extracted.mask, 5, 5, 'golden-bizarre', 'color-only');
  // 背景隅 (0,0) は透明（alpha=0）のまま元映像を残す
  assert.equal(outOnlyColor[3], 0);
  // 中央被写体 (2,2) は異色カラーかつ不透明
  const centerOffset = (2 * 5 + 2) * 4;
  assert.ok(outOnlyColor[centerOffset + 3] >= 200);

  // パーツ別マスク（髪=1, 肌=2, 服=3）がそれぞれ別々の色になることを検証
  const selfieClasses = new Uint8Array([
    0, 1, 1, 0,
    0, 3, 3, 0,
    0, 4, 4, 0,
    0, 0, 0, 0,
  ]);
  const partMaskRes = buildSubjectPartMask({
    width: 4,
    height: 4,
    selfieClasses,
    selfieWidth: 4,
    selfieHeight: 4,
  });
  assert.equal(partMaskRes.partMap[1], PART_HAIR);
  assert.equal(partMaskRes.partMap[5], PART_SKIN);
  assert.equal(partMaskRes.partMap[9], PART_CLOTHES);

  const uniformSrc = new Uint8ClampedArray(16 * 4).fill(180);
  const partRgba = stylizeSubjectPartPixels(
    uniformSrc,
    partMaskRes.partMap,
    4,
    4,
    'golden-bizarre',
    'color-only'
  );
  // 背景は透明
  assert.equal(partRgba[3], 0);
  // 髪(1)・肌(5)・服(9)が同じ元輝度(180)でも全く違うRGB色に変換される
  const hairRgb = [partRgba[1 * 4], partRgba[1 * 4 + 1], partRgba[1 * 4 + 2]];
  const skinRgb = [partRgba[5 * 4], partRgba[5 * 4 + 1], partRgba[5 * 4 + 2]];
  const clothesRgb = [partRgba[9 * 4], partRgba[9 * 4 + 1], partRgba[9 * 4 + 2]];
  assert.notDeepEqual(hairRgb, skinRgb);
  assert.notDeepEqual(skinRgb, clothesRgb);
  assert.notDeepEqual(hairRgb, clothesRgb);
  assert.ok(PART_LIPS !== PART_EYES);
});

test('sample-matrix-code-09 defaults audio to OFF and matrix-code-engine transitions cleanly at 2.0s', async () => {
  const raw = await fs.readFile(
    path.join(REPO_ROOT, 'shared', 'templates', 'sample-matrix-code-09', 'template.json'),
    'utf8'
  );
  const template = JSON.parse(raw);
  assert.equal(template.inputMode, 'matrix-code');
  assert.equal(template.allowSourceAudio, true);
  assert.equal(template.defaultIncludeAudio, false);

  const normal = computeMatrixWorldState(1.9, 2.0);
  assert.equal(normal.phase, 'normal');
  assert.equal(normal.matrixBlend, 0);

  const glitch = computeMatrixWorldState(2.05, 2.0, 0.18);
  assert.equal(glitch.phase, 'glitch');
  assert.ok(glitch.glitchIntensity > 0);

  const matrix = computeMatrixWorldState(2.3, 2.0, 0.18);
  assert.equal(matrix.phase, 'matrix');
  assert.equal(matrix.matrixBlend, 1);

  const cellA = sampleMatrixCell(4, 10, 40, 0.5);
  const cellB = sampleMatrixCell(4, 10, 40, 0.5);
  assert.deepEqual(cellA, cellB);
  assert.equal(typeof cellA.glyph, 'string');
  assert.ok(cellA.glyph.length === 1);
  assert.ok(cellA.rainIntensity >= 0 && cellA.rainIntensity <= 1);

  const lumaGrid = new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  const edges = computeGridEdgeMap(lumaGrid, 3, 3);
  assert.ok(edges[1 * 3 + 1] > 0.8);
  assert.equal(edges[1 * 3 + 0], 0);

  const stretched = normalizeLumaContrast(new Float32Array([0.2, 0.4, 0.6]));
  assert.equal(stretched[0], 0);
  assert.ok(Math.abs(stretched[1] - 0.5) < 1e-6);
  assert.equal(stretched[2], 1);
});
