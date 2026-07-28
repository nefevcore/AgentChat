// Frontend static server on 3831
// Serves Vite-built files; proxies /api and /ws to backend on 3830.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3831;
const BACKEND = 'http://localhost:3830';
const STATIC_DIR = path.join(__dirname, 'webui', 'client', 'dist');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

http.createServer((req, res) => {
  // Proxy API and WebSocket upgrade to backend
  if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
    const opts = {
      hostname: 'localhost', port: 3830, path: req.url,
      method: req.method, headers: req.headers,
    };
    const proxy = http.request(opts, (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    });
    proxy.on('error', () => { res.writeHead(502); res.end('Backend unavailable'); });
    req.pipe(proxy);
    return;
  }

  // Serve static file or SPA fallback
  let filePath = path.join(STATIC_DIR, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serveStatic(res, filePath);
  } else {
    // SPA fallback
    const index = path.join(STATIC_DIR, 'index.html');
    if (fs.existsSync(index)) serveStatic(res, index);
    else { res.writeHead(404); res.end('Not found'); }
  }
}).listen(PORT, () => {
  console.log(`[Frontend] :${PORT} (proxy /api -> ${BACKEND})`);
});
