/**
 * Minimal same-origin front door for the e2e stack: serves the real
 * production build (dist/) as static files and forwards everything under
 * /api to the real Express server — mirroring the documented self-host
 * nginx topology (SELF_HOST_GUIDE.md) so the browser only ever talks to
 * ONE origin and the Lax session cookie behaves exactly as it does for a
 * real deployment.
 */
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.E2E_PROXY_PORT || 8080);
const EXPRESS_PORT = Number(process.env.E2E_EXPRESS_PORT || 34122);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.join(DIST, urlPath);
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}

function proxyToExpress(req: http.IncomingMessage, res: http.ServerResponse) {
  const proxyReq = http.request(
    {
      host: '127.0.0.1',
      port: EXPRESS_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${EXPRESS_PORT}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    res.writeHead(502).end(`proxy error: ${err.message}`);
  });
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    proxyToExpress(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[e2e-proxy] listening on :${PORT}, forwarding /api to :${EXPRESS_PORT}`);
});
