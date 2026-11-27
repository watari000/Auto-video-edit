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
  computeCoverCropRect,
  computeKineticTokenState,
  computeSafeRenderDimensions,
  computeSketchRevealState,
  generateSketchImageData,
  getCanvasFilterString,
  parseKineticTokens,
  resolveCutAtTime,
} from '../apps/user-editor/lib/video-engine.js';
import { evaluateMediaMetadata } from '../apps/user-editor/src/precheck/media-precheck.js';

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

test('shared/templates/index.json lists >= 5 valid templates with existing assets and unique IDs', async () => {
  const templatesRoot = path.join(REPO_ROOT, 'shared', 'templates');
  const catalogRaw = await fs.readFile(path.join(templatesRoot, 'index.json'), 'utf8');
  const catalog = JSON.parse(catalogRaw);

  assert.ok(Array.isArray(catalog) && catalog.length >= 5);
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
