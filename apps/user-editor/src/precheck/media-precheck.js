const DARK_LUMA_THRESHOLD = 45;

/**
 * 素材の縦横比・明るさ・尺を事前チェックし、ユーザーに寄り添う優しい日本語案内を返す（強制ブロックはしない）。
 */
export function evaluateMediaMetadata({
  width,
  height,
  durationSec = 0,
  requiredDurationSec = 1,
  averageLuma = null,
  mediaType = 'video',
}) {
  const warnings = [];

  if (width > height) {
    warnings.push({
      code: 'LANDSCAPE_MEDIA',
      level: 'info',
      message: '横向きの素材です。書き出し時は縦向き（9:16）の中央に合わせて自動調整します。',
    });
  }

  if (typeof averageLuma === 'number' && averageLuma < DARK_LUMA_THRESHOLD) {
    warnings.push({
      code: 'DARK_MEDIA',
      level: 'tip',
      message: '少し暗めの素材かもしれません。明るい場所で撮り直すとさらに映えます！（このまま使うこともできます）',
    });
  }

  if (mediaType === 'video' && durationSec > 0 && durationSec + 0.05 < requiredDurationSec) {
    warnings.push({
      code: 'SHORT_VIDEO',
      level: 'info',
      message: `このカットに必要な ${requiredDurationSec} 秒より短いため（${durationSec.toFixed(1)}秒）、不足分は最後のフレームを静止してつなぎます。`,
    });
  }

  return { warnings };
}

function sampleElementLuminance(element) {
  try {
    // 64x64の極小Canvasに縮小して明るさだけを簡易判定し、メモリ負荷を抑える
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 64;
    sampleCanvas.height = 64;
    const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      return null;
    }
    ctx.drawImage(element, 0, 0, 64, 64);
    const { data } = ctx.getImageData(0, 0, 64, 64);
    let totalLuma = 0;
    const pixelCount = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      totalLuma += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }

    return pixelCount > 0 ? totalLuma / pixelCount : null;
  } catch {
    return null;
  }
}

function loadImageElement(objectUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像の読み込みに失敗しました。別の写真を選び直してください。'));
    img.src = objectUrl;
  });
}

function getHiddenMediaHost() {
  if (typeof document === 'undefined' || !document.body) {
    return null;
  }
  let host = document.getElementById('hidden-media-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'hidden-media-host';
    // iOS SafariはDOM未接続・display:noneの動画デコードを強く間引くため、極小・半透明でDOMに保持する
    host.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;overflow:hidden;z-index:-1;';
    host.setAttribute('aria-hidden', 'true');
    document.body.appendChild(host);
  }
  return host;
}

function loadVideoElement(objectUrl) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', 'true');
    video.preload = 'auto';

    const host = getHiddenMediaHost();
    if (host) {
      host.appendChild(video);
    }

    const onError = () => {
      cleanup();
      video.remove();
      reject(
        new Error(
          'この動画形式はブラウザで読み込めませんでした。MP4やMOV形式の動画、または写真を選び直してください。'
        )
      );
    };

    const onLoadedData = () => {
      cleanup();
      resolve(video);
    };

    function cleanup() {
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('error', onError);
    }

    video.addEventListener('loadeddata', onLoadedData, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.src = objectUrl;
    video.load();
  });
}

/**
 * ユーザーが選択したローカルファイルをブラウザ内だけで解析し、メディア要素と事前チェック結果を返す。
 */
export async function inspectMediaFile(file, requiredDurationSec, resourcePool) {
  if (!file) {
    throw new Error('ファイルが選択されていません。');
  }

  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');

  if (!isImage && !isVideo) {
    throw new Error('画像または動画ファイルを選択してください（非対応のファイル形式です）。');
  }

  const objectUrl = resourcePool.registerUrl(URL.createObjectURL(file));

  try {
    if (isImage) {
      const element = await loadImageElement(objectUrl);
      const width = element.naturalWidth;
      const height = element.naturalHeight;
      const averageLuma = sampleElementLuminance(element);
      const { warnings } = evaluateMediaMetadata({
        width,
        height,
        durationSec: requiredDurationSec,
        requiredDurationSec,
        averageLuma,
        mediaType: 'image',
      });

      return {
        mediaType: 'image',
        fileName: file.name,
        width,
        height,
        durationSec: requiredDurationSec,
        trimStartSec: 0,
        objectUrl,
        element,
        warnings,
      };
    }

    const element = resourcePool.registerElement
      ? resourcePool.registerElement(await loadVideoElement(objectUrl))
      : await loadVideoElement(objectUrl);
    const width = element.videoWidth;
    const height = element.videoHeight;
    const durationSec = Number.isFinite(element.duration) ? element.duration : requiredDurationSec;
    const averageLuma = sampleElementLuminance(element);
    const { warnings } = evaluateMediaMetadata({
      width,
      height,
      durationSec,
      requiredDurationSec,
      averageLuma,
      mediaType: 'video',
    });

    return {
      mediaType: 'video',
      fileName: file.name,
      width,
      height,
      durationSec,
      trimStartSec: 0,
      objectUrl,
      element,
      warnings,
    };
  } catch (error) {
    resourcePool.revokeUrl(objectUrl);
    throw error;
  }
}
