import { loadTemplate, loadTemplateCatalog } from '../lib/template-loader.js';
import { createMediaResourcePool } from '../lib/video-engine.js';
import { renderGalleryView } from './gallery/template-gallery.js';
import { renderGuideSection } from './guide/guide-view.js';
import { renderTrimmerSection } from './trimmer/slide-trimmer.js';
import { initPreviewSection } from './preview/canvas-preview.js';
import { initExporterSection } from './exporter/video-exporter.js';

const CATALOG_URL = '../../shared/templates/index.json';
const THEME_STORAGE_KEY = 'kinetic-atelier-theme';

function initThemeToggle() {
  const toggleBtn = document.getElementById('theme-toggle-btn');
  const toggleLabel = document.getElementById('theme-toggle-label');
  if (!toggleBtn || !toggleLabel) {
    return;
  }

  const syncUi = (theme) => {
    const isLight = theme === 'light';
    if (isLight) {
      document.documentElement.dataset.theme = 'light';
    } else {
      delete document.documentElement.dataset.theme;
    }
    toggleBtn.setAttribute('aria-pressed', String(isLight));
    toggleLabel.textContent = isLight ? 'THEME: LIGHT' : 'THEME: DARK';
  };

  const initialTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  syncUi(initialTheme);

  toggleBtn.addEventListener('click', () => {
    const nextTheme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    syncUi(nextTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // プライベートブラウズ等でストレージ制限がある場合も動作を止めない
    }
  });
}

function parseTemplateIdFromHash(hashString) {
  const match = /^#template=([a-z0-9-]+)$/i.exec(hashString || '');
  return match ? match[1] : null;
}

async function bootstrap() {
  initThemeToggle();

  const viewGallery = document.getElementById('view-gallery');
  const viewEditor = document.getElementById('view-editor');
  const galleryBanner = document.getElementById('gallery-banner');
  const galleryContainer = document.getElementById('gallery-container');
  const editorBanner = document.getElementById('app-banner');
  const navSteps = document.getElementById('nav-steps');
  const navGalleryBtn = document.getElementById('nav-gallery-btn');
  const backToGalleryBtn = document.getElementById('back-to-gallery-btn');
  const brandHomeLink = document.getElementById('brand-home-link');
  const quickSelect = document.getElementById('quick-template-select');
  const readyCounter = document.getElementById('ready-counter');
  const guideEl = document.getElementById('guide-container');
  const trimmerEl = document.getElementById('trimmer-container');
  const captionsEl = document.getElementById('captions-container');
  const previewEl = document.getElementById('preview-container');
  const exporterEl = document.getElementById('exporter-container');

  if (window.location.protocol === 'file:') {
    showBanner(
      galleryBanner,
      'file:// で直接開いているためテンプレートを読み込めません。ターミナルで `node tests/serve-static.mjs` を実行し、`http://localhost:4173/apps/user-editor/` を開いてください。',
      'error'
    );
    return;
  }

  const resourcePool = createMediaResourcePool();
  window.addEventListener('beforeunload', () => {
    resourcePool.disposeAll();
  });

  let catalogItems = [];
  let activeTemplateId = null;
  let activePreviewController = null;

  function releaseCurrentEditorSession() {
    if (activePreviewController) {
      activePreviewController.stop();
      activePreviewController = null;
    }
    // 画面やテンプレートを切り替える際、旧テンプレートのObjectURLを解放してSafariのメモリ圧迫を防ぐ
    resourcePool.disposeAll();
  }

  function showGallery(syncHash = true) {
    releaseCurrentEditorSession();
    viewEditor.classList.add('hidden');
    viewGallery.classList.remove('hidden');
    navSteps.classList.add('hidden');
    navGalleryBtn.classList.add('hidden');
    readyCounter.classList.add('hidden');

    renderGalleryView(galleryContainer, catalogItems, activeTemplateId, (selectedId) => {
      openTemplate(selectedId, true);
    });

    if (syncHash && window.location.hash !== '#gallery' && window.location.hash !== '') {
      window.location.hash = 'gallery';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function openTemplate(templateId, syncHash = true) {
    const targetItem = catalogItems.find((item) => item.id === templateId) || catalogItems[0];
    if (!targetItem) {
      return;
    }

    releaseCurrentEditorSession();
    activeTemplateId = targetItem.id;
    quickSelect.value = targetItem.id;

    viewGallery.classList.add('hidden');
    viewEditor.classList.remove('hidden');
    navSteps.classList.remove('hidden');
    navGalleryBtn.classList.remove('hidden');
    readyCounter.classList.remove('hidden');

    if (syncHash && window.location.hash !== `#template=${targetItem.id}`) {
      window.location.hash = `template=${targetItem.id}`;
    }

    showBanner(editorBanner, `「${targetItem.title}」を読み込んでいます...`, 'info');

    try {
      const template = await loadTemplate(targetItem.resolvedTemplateUrl);
      const state = {
        mediaByCutId: {},
        textByCutId: {},
      };

      const updateReadyCounter = () => {
        const loadedCount = template.cuts.filter((cut) => Boolean(state.mediaByCutId[cut.id])).length;
        const total = template.cuts.length;
        readyCounter.textContent = `${loadedCount} / ${total} CUTS READY`;
        readyCounter.classList.toggle('is-complete', loadedCount === total);
      };

      updateReadyCounter();
      renderGuideSection(guideEl, template);
      activePreviewController = initPreviewSection(previewEl, template, state, captionsEl);
      renderTrimmerSection(trimmerEl, template, state, resourcePool, () => {
        updateReadyCounter();
        activePreviewController?.refresh();
      });
      initExporterSection(exporterEl, template, state, resourcePool, () => {
        activePreviewController?.stop();
      });

      showBanner(
        editorBanner,
        `「${template.title}」を編集中です。選択した写真・動画はブラウザ内だけで安全に処理されます。`,
        'info'
      );
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      showBanner(editorBanner, error.message, 'error');
    }
  }

  try {
    catalogItems = await loadTemplateCatalog(CATALOG_URL);
    quickSelect.innerHTML = catalogItems
      .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`)
      .join('');

    showBanner(
      galleryBanner,
      `全${catalogItems.length}パターンのテンプレートが利用可能です。選択した写真・動画は外部送信されず端末内だけで編集されます。`,
      'info'
    );

    navGalleryBtn.addEventListener('click', () => showGallery(true));
    backToGalleryBtn.addEventListener('click', () => showGallery(true));
    brandHomeLink.addEventListener('click', (event) => {
      event.preventDefault();
      showGallery(true);
    });
    quickSelect.addEventListener('change', (event) => {
      openTemplate(event.target.value, true);
    });

    window.addEventListener('hashchange', () => {
      const hashId = parseTemplateIdFromHash(window.location.hash);
      if (hashId && catalogItems.some((item) => item.id === hashId)) {
        if (hashId !== activeTemplateId || viewEditor.classList.contains('hidden')) {
          openTemplate(hashId, false);
        }
      } else if (!viewGallery.classList.contains('hidden')) {
        return;
      } else {
        showGallery(false);
      }
    });

    const initialId = parseTemplateIdFromHash(window.location.hash);
    if (initialId && catalogItems.some((item) => item.id === initialId)) {
      await openTemplate(initialId, false);
    } else {
      showGallery(false);
    }
  } catch (error) {
    showBanner(galleryBanner, error.message, 'error');
  }
}

function showBanner(bannerEl, message, type) {
  if (!bannerEl) {
    return;
  }
  bannerEl.textContent = message;
  bannerEl.className = `app-banner is-${type}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

bootstrap();
