/**
 * Minimal static server for local development: `npm run serve`.
 * Serves the repo root so the page can load both src/ and node_modules/.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT ?? 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.musicxml': 'application/vnd.recordare.musicxml+xml',
  '.svg': 'image/svg+xml',
};

createServer((request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  let path = join(root, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ''));

  if (!path.startsWith(root)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
  if (!existsSync(path)) {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }

  response.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(path).pipe(response);
}).listen(port, () => {
  console.log(`SightScore dev server: http://localhost:${port}`);
});
