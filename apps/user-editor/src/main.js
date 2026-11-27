import { loadTemplate } from '../lib/template-loader.js';
import { createMediaResourcePool } from '../lib/video-engine.js';
import { renderGuideSection } from './guide/guide-view.js';
import { renderTrimmerSection } from './trimmer/slide-trimmer.js';
import { initPreviewSection } from './preview/canvas-preview.js';
import { initExporterSection } from './exporter/video-exporter.js';

const DEFAULT_TEMPLATE_URL = '../../shared/templates/sample-cafe-01/template.json';

async function bootstrap() {
  const banner = document.getElementById('app-banner');
  const readyCounter = document.getElementById('ready-counter');
  const guideEl = document.getElementById('guide-container');
  const trimmerEl = document.getElementById('trimmer-container');
  const captionsEl = document.getElementById('captions-container');
  const previewEl = document.getElementById('preview-container');
  const exporterEl = document.getElementById('exporter-container');

  if (window.location.protocol === 'file:') {
    showBanner(
      banner,
      'file:// で直接開いているためテンプレートを読み込めません。ターミナルで `node tests/serve-static.mjs` を実行し、`http://localhost:4173/apps/user-editor/` を開いてください。',
      'error'
    );
    return;
  }

  const resourcePool = createMediaResourcePool();
  window.addEventListener('beforeunload', () => {
    resourcePool.disposeAll();
  });

  try {
    const template = await loadTemplate(DEFAULT_TEMPLATE_URL);
    const state = {
      mediaByCutId: {},
      textByCutId: {},
    };

    const updateReadyCounter = () => {
      if (!readyCounter) {
        return;
      }
      const loadedCount = template.cuts.filter((cut) => Boolean(state.mediaByCutId[cut.id])).length;
      const total = template.cuts.length;
      readyCounter.textContent = `${loadedCount} / ${total} CUTS READY`;
      readyCounter.classList.toggle('is-complete', loadedCount === total);
    };

    updateReadyCounter();
    renderGuideSection(guideEl, template);
    const previewController = initPreviewSection(previewEl, template, state, captionsEl);
    renderTrimmerSection(trimmerEl, template, state, resourcePool, () => {
      updateReadyCounter();
      previewController.refresh();
    });
    initExporterSection(exporterEl, template, state, resourcePool, () => {
      previewController.stop();
    });

    showBanner(
      banner,
      '選択した写真・動画は外部へ送信されず、ブラウザ内だけで安全に編集されます（ゼロサーバー原則）。',
      'info'
    );
  } catch (error) {
    showBanner(banner, error.message, 'error');
  }
}

function showBanner(bannerEl, message, type) {
  if (!bannerEl) {
    return;
  }
  bannerEl.textContent = message;
  bannerEl.className = `app-banner is-${type}`;
}

bootstrap();
