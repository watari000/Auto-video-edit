import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 4173;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://localhost:${PORT}`);
    let relativePath = decodeURIComponent(requestUrl.pathname);

    if (relativePath === '/') {
      relativePath = '/apps/user-editor/index.html';
    } else if (relativePath.endsWith('/')) {
      relativePath = `${relativePath}index.html`;
    }

    const safePath = path.resolve(REPO_ROOT, `.${relativePath}`);
    if (!safePath.startsWith(REPO_ROOT)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    const stat = await fs.stat(safePath);
    const targetFile = stat.isDirectory() ? path.join(safePath, 'index.html') : safePath;
    const ext = path.extname(targetFile).toLowerCase();
    const content = await fs.readFile(targetFile);

    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Static preview server running at http://127.0.0.1:${PORT}/apps/user-editor/`);
});
