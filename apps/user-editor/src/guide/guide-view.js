/**
 * STEP 1：お手本ガイド（構図シルエット・撮影ポイント・おすすめ音源案内）を描画する。
 */
export function renderGuideSection(container, template) {
  const totalSec = template.cuts.reduce((sum, cut) => sum + cut.durationSec, 0);
  const { audioGuide } = template;

  const keywordsHtml = audioGuide.suggestedSearchKeywords
    .map((kw) => `<span class="chip">${escapeHtml(kw)}</span>`)
    .join('');

  const cardsHtml = template.cuts
    .map(
      (cut) => `
      <article class="guide-card">
        <div class="guide-thumb-wrap">
          <img
            src="${escapeHtml(cut.shootingGuide.resolvedSilhouetteUrl)}"
            alt="${escapeHtml(cut.label)}の構図ガイド"
            class="guide-thumb"
          />
        </div>
        <div class="guide-body">
          <div class="guide-header">
            <span class="badge">${cut.durationSec.toFixed(1)}秒</span>
            <h3>${escapeHtml(cut.label)}</h3>
          </div>
          <p class="meta-line"><strong>画角：</strong>${escapeHtml(cut.shootingGuide.shotType)}</p>
          <p class="meta-line"><strong>動き：</strong>${escapeHtml(cut.shootingGuide.cameraMove)}</p>
          <p class="tips-text">${escapeHtml(cut.shootingGuide.tips)}</p>
        </div>
      </article>
    `
    )
    .join('');

  container.innerHTML = `
    <div class="template-summary">
      <div>
        <span class="pill-tag">${escapeHtml(template.aspectRatio)} / 合計 ${totalSec.toFixed(1)}秒 / 無音書き出し</span>
        <h2 class="template-title">${escapeHtml(template.title)}</h2>
        <p class="template-desc">${escapeHtml(template.description)}</p>
      </div>
      <div class="audio-guide-box">
        <h3>Instagram投稿時のおすすめ音源目安</h3>
        <p><strong>曲調：</strong>${escapeHtml(audioGuide.mood)}（目安 BPM ${audioGuide.bpmRange.min}〜${audioGuide.bpmRange.max}）</p>
        <div class="chip-row">${keywordsHtml}</div>
        <p class="audio-note">${escapeHtml(audioGuide.note)}</p>
      </div>
    </div>
    <div class="guide-grid">
      ${cardsHtml}
    </div>
  `;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
