/**
 * STEP 01：エディトリアル仕様の構成ガイド、ライナーノーツ風音源案内、ビューファインダー式ストーリーボードを描画する。
 */
export function renderGuideSection(container, template) {
  const totalSec = template.cuts.reduce((sum, cut) => sum + cut.durationSec, 0);
  const { audioGuide } = template;

  const keywordsHtml = audioGuide.suggestedSearchKeywords
    .map(
      (kw) => `
      <button type="button" class="keyword-chip" data-copy-keyword="${escapeHtml(kw)}" title="クリックして検索ワードをコピー">
        ${escapeHtml(kw)}
      </button>
    `
    )
    .join('');

  const cardsHtml = template.cuts
    .map(
      (cut, index) => `
      <article class="shot-card">
        <div class="shot-viewfinder">
          <img
            src="${escapeHtml(cut.shootingGuide.resolvedSilhouetteUrl)}"
            alt="${escapeHtml(cut.label)}の構図ガイド"
            class="shot-thumb"
          />
        </div>
        <div class="shot-body">
          <div class="shot-top">
            <span class="shot-num">CUT ${String(index + 1).padStart(2, '0')}</span>
            <span class="shot-duration">${cut.durationSec.toFixed(1)}s</span>
          </div>
          <h3 class="shot-title">${escapeHtml(cut.label)}</h3>
          <ul class="shot-specs">
            <li><strong>画角：</strong>${escapeHtml(cut.shootingGuide.shotType)}</li>
            <li><strong>動き：</strong>${escapeHtml(cut.shootingGuide.cameraMove)}</li>
          </ul>
          <p class="shot-tips">${escapeHtml(cut.shootingGuide.tips)}</p>
        </div>
      </article>
    `
    )
    .join('');

  container.innerHTML = `
    <div class="template-hero">
      <div>
        <div class="template-meta-strip">
          <span class="spec-tag is-accent">${escapeHtml(template.aspectRatio)} VERTICAL</span>
          <span class="spec-tag">${template.cuts.length} CUTS / ${totalSec.toFixed(1)} SEC</span>
          <span class="spec-tag">${template.output.width}×${template.output.height} / ${template.output.fps}FPS</span>
          <span class="spec-tag">MUTED MASTER</span>
        </div>
        <h3 class="template-title">${escapeHtml(template.title)}</h3>
        <p class="template-desc">${escapeHtml(template.description)}</p>
      </div>

      <aside class="audio-liner-notes" aria-label="おすすめ音源ガイド">
        <div class="liner-header">
          <span class="liner-title">SOUND LINER NOTES // IG AUDIO</span>
          <span class="liner-bpm">BPM ${audioGuide.bpmRange.min}–${audioGuide.bpmRange.max}</span>
        </div>
        <p class="liner-mood">${escapeHtml(audioGuide.mood)}</p>
        <div class="keyword-chips">${keywordsHtml}</div>
        <p class="audio-note">${escapeHtml(audioGuide.note)}（キーワードはタップでコピーできます）</p>
      </aside>
    </div>

    <div class="storyboard-grid">
      ${cardsHtml}
    </div>
  `;

  container.querySelectorAll('[data-copy-keyword]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const keyword = btn.getAttribute('data-copy-keyword');
      if (!keyword) {
        return;
      }
      try {
        await navigator.clipboard?.writeText(keyword);
        btn.textContent = `${keyword} ✓ コピー`;
        btn.classList.add('is-copied');
        setTimeout(() => {
          btn.textContent = keyword;
          btn.classList.remove('is-copied');
        }, 1600);
      } catch {
        // クリップボードAPI非対応環境でもエラーを出さず静かにフォールバックする
      }
    });
  });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
