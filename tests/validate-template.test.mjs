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
  computeSafeRenderDimensions,
  getCanvasFilterString,
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
