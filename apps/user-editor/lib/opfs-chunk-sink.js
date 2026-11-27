/**
 * 録画中の動画チャンクをブラウザのOPFS（一時ローカル領域）へ逐次書き出し、
 * RAMに溜め込まずに5分動画などの長尺書き出しを安定化させるシンクを作成する。
 * OPFS非対応ブラウザでは自動的にメモリ配列モードへフォールバックする。
 */
export async function createRecordingChunkSink(prefix = 'export') {
  const safePrefix = String(prefix || 'export').replace(/[^a-z0-9-_]/gi, '');

  if (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function') {
    try {
      const root = await navigator.storage.getDirectory();
      const tempName = `auto-video-edit-${safePrefix}-${Date.now()}.tmp`;
      const fileHandle = await root.getFileHandle(tempName, { create: true });

      if (typeof fileHandle.createWritable === 'function') {
        const writable = await fileHandle.createWritable();
        let writeChain = Promise.resolve();
        let closed = false;

        return {
          mode: 'opfs',
          append(chunk) {
            if (!chunk || chunk.size === 0 || closed) {
              return;
            }
            writeChain = writeChain.then(() => writable.write(chunk));
          },
          async finalize(mimeType) {
            await writeChain;
            if (!closed) {
              await writable.close();
              closed = true;
            }
            const file = await fileHandle.getFile();
            return mimeType && file.type !== mimeType
              ? new Blob([file], { type: mimeType })
              : file;
          },
          async cleanup() {
            try {
              await writeChain.catch(() => {});
              if (!closed) {
                await writable.abort().catch(() => {});
                closed = true;
              }
              await root.removeEntry(tempName);
            } catch {
              // すでに削除済みまたはブラウザ終了時のクリーンアップエラーは無視する
            }
          },
        };
      }
    } catch {
      // プライベートブラウズや権限制限時はメモリモードへ安全にフォールバックする
    }
  }

  const chunks = [];
  return {
    mode: 'memory',
    append(chunk) {
      if (chunk && chunk.size > 0) {
        chunks.push(chunk);
      }
    },
    async finalize(mimeType) {
      return new Blob(chunks, { type: mimeType || 'video/webm' });
    },
    async cleanup() {
      chunks.length = 0;
    },
  };
}
