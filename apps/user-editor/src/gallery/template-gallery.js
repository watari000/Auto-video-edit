/**
 * テンプレート一覧（ギャラリー画面）を描画し、選択されたテンプレートIDを通知する。
 */
export function renderGalleryView(container, catalogItems, activeTemplateId, onSelectTemplate) {
  container.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'gallery-grid';

  catalogItems.forEach((item, index) => {
    const isActive = item.id === activeTemplateId;
    const card = document.createElement('article');
    card.className = `gallery-card${isActive ? ' is-active' : ''}`;

    card.innerHTML = `
      <div class="gallery-cover">
        <img
          src="${escapeHtml(item.resolvedCoverUrl)}"
          alt="${escapeHtml(item.title)}の構図プレビュー"
          class="gallery-cover-img"
        />
        <span class="gallery-index">${String(index + 1).padStart(2, '0')}</span>
      </div>
      <div class="gallery-card-body">
        <div class="gallery-meta-row">
          <span class="gallery-category">${escapeHtml(item.category)}</span>
          ${isActive ? '<span class="gallery-active-tag">SELECTED</span>' : ''}
        </div>
        <h2 class="gallery-title">${escapeHtml(item.title)}</h2>
        <p class="gallery-summary">${escapeHtml(item.summary)}</p>
        <div class="gallery-specs">
          <span class="spec-tag">${item.cutCount} CUTS / ${Number(item.durationSec).toFixed(1)}S</span>
          <span class="spec-tag">${escapeHtml(item.bpmLabel)}</span>
          <span class="spec-tag is-accent">${escapeHtml(item.filterTag)}</span>
        </div>
        <button type="button" class="btn btn-primary gallery-select-btn">
          ${isActive ? 'このテンプレートを開き直す' : 'このテンプレートで編集する'}
        </button>
      </div>
    `;

    const selectBtn = card.querySelector('.gallery-select-btn');
    selectBtn.addEventListener('click', () => {
      onSelectTemplate(item.id);
    });

    grid.appendChild(card);
  });

  container.appendChild(grid);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
