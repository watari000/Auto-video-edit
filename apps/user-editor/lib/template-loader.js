const ALLOWED_STATUSES = new Set(['draft', 'review', 'published']);
const ALLOWED_INPUT_MODES = new Set(['multi-clip', 'beat-sync-video']);
const ALLOWED_ASPECT_RATIOS = new Set(['9:16', '1:1', '4:5']);
const ALLOWED_MEDIA_TYPES = new Set(['video', 'image']);
const ALLOWED_MOTIONS = new Set(['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'beat-glow']);
const ALLOWED_TRANSITIONS = new Set(['cut', 'fade', 'sketch-to-reality', 'flash']);
const ALLOWED_SKETCH_STYLES = new Set(['ink-paper', 'chalk-dark', 'pencil-warm']);
const ALLOWED_FILTERS = new Set(['none', 'warm', 'cool', 'vintage', 'vivid']);
const ALLOWED_TEXT_POSITIONS = new Set(['top', 'center', 'bottom']);
const ALLOWED_TEXT_STYLES = new Set(['clean', 'pill', 'shadow', 'kinetic']);
const ALLOWED_TEXT_ANIMATIONS = new Set(['none', 'word-pop', 'slide-beat', 'emphasis-wave']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * テンプレートJSONが shared/schemas/template.schema.json の契約を満たしているか検証する。
 * ブラウザ側・Nodeテスト側の双方で共有するため純粋関数として定義している。
 */
export function validateTemplateData(data) {
  const errors = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['テンプレートデータが正しいJSONオブジェクトではありません。'] };
  }

  if (data.schemaVersion !== '1.0.0') {
    errors.push('schemaVersion は "1.0.0" である必要があります。');
  }

  if (!isNonEmptyString(data.id) || !/^[a-z0-9-]+$/.test(data.id)) {
    errors.push('id は半角小文字英数字とハイフンのみで指定してください。');
  }

  if (!isNonEmptyString(data.title)) {
    errors.push('title は必須です。');
  }

  if (!isNonEmptyString(data.description)) {
    errors.push('description は必須です。');
  }

  if (!ALLOWED_STATUSES.has(data.status)) {
    errors.push('status は draft / review / published のいずれかである必要があります。');
  }

  if (data.inputMode !== undefined && !ALLOWED_INPUT_MODES.has(data.inputMode)) {
    errors.push('inputMode は multi-clip / beat-sync-video のいずれかである必要があります。');
  }

  if (data.allowSourceAudio !== undefined && typeof data.allowSourceAudio !== 'boolean') {
    errors.push('allowSourceAudio は真偽値である必要があります。');
  }

  if (!ALLOWED_ASPECT_RATIOS.has(data.aspectRatio)) {
    errors.push('aspectRatio は 9:16 / 1:1 / 4:5 のいずれかである必要があります。');
  }

  if (!data.output || typeof data.output !== 'object') {
    errors.push('output 設定が不足しています。');
  } else {
    const { width, height, fps, muted } = data.output;
    if (!Number.isInteger(width) || width < 360 || width > 1080) {
      errors.push('output.width は 360〜1080 の整数である必要があります。');
    }
    if (!Number.isInteger(height) || height < 360 || height > 1920) {
      errors.push('output.height は 360〜1920 の整数である必要があります。');
    }
    if (!Number.isInteger(fps) || fps < 24 || fps > 30) {
      errors.push('output.fps は 24〜30 の整数である必要があります。');
    }
    if (muted !== true) {
      errors.push('著作権配慮のため output.muted は true 固定である必要があります。');
    }
  }

  if (!data.audioGuide || typeof data.audioGuide !== 'object') {
    errors.push('audioGuide が不足しています。');
  } else {
    const { mood, bpmRange, suggestedSearchKeywords, note } = data.audioGuide;
    if (!isNonEmptyString(mood)) {
      errors.push('audioGuide.mood は必須です。');
    }
    if (
      !bpmRange ||
      !Number.isInteger(bpmRange.min) ||
      !Number.isInteger(bpmRange.max) ||
      bpmRange.min > bpmRange.max
    ) {
      errors.push('audioGuide.bpmRange は min <= max の整数で指定してください。');
    }
    if (!Array.isArray(suggestedSearchKeywords) || suggestedSearchKeywords.length === 0) {
      errors.push('audioGuide.suggestedSearchKeywords は1件以上必要です。');
    }
    if (!isNonEmptyString(note)) {
      errors.push('audioGuide.note は必須です。');
    }
  }

  if (!Array.isArray(data.cuts) || data.cuts.length === 0) {
    errors.push('cuts は1件以上必要です。');
  } else {
    data.cuts.forEach((cut, idx) => {
      const prefix = `cuts[${idx}]`;
      if (!cut || typeof cut !== 'object') {
        errors.push(`${prefix} がオブジェクトではありません。`);
        return;
      }
      if (!isNonEmptyString(cut.id) || !/^[a-z0-9-]+$/.test(cut.id)) {
        errors.push(`${prefix}.id が不正です。`);
      }
      if (!Number.isInteger(cut.order) || cut.order < 1) {
        errors.push(`${prefix}.order は1以上の整数である必要があります。`);
      }
      if (!isNonEmptyString(cut.label)) {
        errors.push(`${prefix}.label は必須です。`);
      }
      if (
        !Array.isArray(cut.acceptedMedia) ||
        cut.acceptedMedia.length === 0 ||
        cut.acceptedMedia.some((type) => !ALLOWED_MEDIA_TYPES.has(type))
      ) {
        errors.push(`${prefix}.acceptedMedia が不正です。`);
      }
      if (typeof cut.durationSec !== 'number' || cut.durationSec <= 0 || cut.durationSec > 15) {
        errors.push(`${prefix}.durationSec は 0 より大きく 15 以下の数値である必要があります。`);
      }
      if (!cut.shootingGuide || typeof cut.shootingGuide !== 'object') {
        errors.push(`${prefix}.shootingGuide が不足しています。`);
      } else {
        const sg = cut.shootingGuide;
        if (
          !isNonEmptyString(sg.shotType) ||
          !isNonEmptyString(sg.cameraMove) ||
          !isNonEmptyString(sg.tips) ||
          !isNonEmptyString(sg.silhouetteAsset)
        ) {
          errors.push(`${prefix}.shootingGuide の必須項目が不足しています。`);
        }
      }
      if (!cut.effect || typeof cut.effect !== 'object') {
        errors.push(`${prefix}.effect が不足しています。`);
      } else {
        if (!ALLOWED_MOTIONS.has(cut.effect.motion)) {
          errors.push(`${prefix}.effect.motion が不正です。`);
        }
        if (!ALLOWED_TRANSITIONS.has(cut.effect.transitionIn)) {
          errors.push(`${prefix}.effect.transitionIn が不正です。`);
        }
        if (cut.effect.sketchStyle !== undefined && !ALLOWED_SKETCH_STYLES.has(cut.effect.sketchStyle)) {
          errors.push(`${prefix}.effect.sketchStyle が不正です。`);
        }
        if (!ALLOWED_FILTERS.has(cut.effect.filter)) {
          errors.push(`${prefix}.effect.filter が不正です。`);
        }
      }
      if (cut.textOverlay !== undefined) {
        const to = cut.textOverlay;
        if (
          !to ||
          typeof to !== 'object' ||
          typeof to.defaultText !== 'string' ||
          typeof to.placeholder !== 'string' ||
          !Number.isInteger(to.maxLength) ||
          to.maxLength < 1 ||
          !ALLOWED_TEXT_POSITIONS.has(to.position) ||
          !ALLOWED_TEXT_STYLES.has(to.style) ||
          (to.animation !== undefined && !ALLOWED_TEXT_ANIMATIONS.has(to.animation)) ||
          (to.accentColor !== undefined &&
            (typeof to.accentColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(to.accentColor)))
        ) {
          errors.push(`${prefix}.textOverlay の形式が不正です。`);
        }
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 静的ホスティング上の公開テンプレートJSONを取得して検証し、ガイド画像パスを解決して返す。
 * 外部通信はこの公開テンプレートデータの読み込みのみに限定する（RULE 02）。
 */
export async function loadTemplate(templateUrl) {
  let response;
  try {
    response = await fetch(templateUrl, { cache: 'no-cache' });
  } catch {
    throw new Error(
      'テンプレートの読み込みに失敗しました。ローカルサーバー（http://localhost:4173）経由で開いているか確認してください。'
    );
  }

  if (!response.ok) {
    throw new Error(
      `テンプレートが見つかりませんでした（HTTP ${response.status}）。時間をおいて再度お試しください。`
    );
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('テンプレートファイルの形式が正しくありません。管理者の確認が必要です。');
  }

  const validation = validateTemplateData(data);
  if (!validation.valid) {
    throw new Error(`テンプレート定義に不備があります：${validation.errors[0]}`);
  }

  const baseUrl = new URL(templateUrl, window.location.href);
  const resolvedCuts = [...data.cuts]
    .sort((a, b) => a.order - b.order)
    .map((cut) => ({
      ...cut,
      shootingGuide: {
        ...cut.shootingGuide,
        resolvedSilhouetteUrl: new URL(cut.shootingGuide.silhouetteAsset, baseUrl).href,
      },
    }));

  return {
    ...data,
    cuts: resolvedCuts,
  };
}

/**
 * 公開済みテンプレートの一覧カタログ（shared/templates/index.json）を読み込み、パスを解決して返す。
 */
export async function loadTemplateCatalog(catalogUrl) {
  let response;
  try {
    response = await fetch(catalogUrl, { cache: 'no-cache' });
  } catch {
    throw new Error(
      'テンプレート一覧の読み込みに失敗しました。ローカルサーバー（http://localhost:4173）経由で開いているか確認してください。'
    );
  }

  if (!response.ok) {
    throw new Error(`テンプレート一覧を取得できませんでした（HTTP ${response.status}）。`);
  }

  let items;
  try {
    items = await response.json();
  } catch {
    throw new Error('テンプレート一覧のJSON形式が正しくありません。');
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('公開中のテンプレートがまだ登録されていません。');
  }

  const baseUrl = new URL(catalogUrl, window.location.href);
  return items.map((item) => ({
    ...item,
    resolvedTemplateUrl: new URL(item.templatePath, baseUrl).href,
    resolvedCoverUrl: new URL(item.coverAsset, baseUrl).href,
  }));
}
