// ============================================================
// frontend-server.js —— 前端静态服务 + API/WebSocket 代理
//
// 职责:
//   1. 托管 Vite 构建产物的静态文件 (webui/client/dist/)
//   2. HTTP 代理: /api/* → localhost:3830
//   3. WebSocket 代理: ws:// → ws://localhost:3830
//   4. SPA fallback: 非文件路径回退到 index.html
//
// 端口: 3831
// 后端: localhost:3830
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3831;
const BACKEND_HOST = 'localhost';
const BACKEND_PORT = 3830;
const STATIC_DIR = path.join(__dirname, '..', 'webui', 'client', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2':'font/woff2',
};

// ── HTTP proxy to backend ──
function proxyRequest(req, res) {
  const opts = {
    hostname: BACKEND_HOST,
    port: BACKEND_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` },
  };
  const proxy = http.request(opts, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  proxy.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Backend unavailable');
    }
  });
  req.pipe(proxy);
}

// ── Static file ──
function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ── Server ──
const server = http.createServer((req, res) => {
  // API proxy
  if (req.url.startsWith('/api/')) {
    return proxyRequest(req, res);
  }

  // Static file
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(STATIC_DIR, urlPath === '/' ? 'index.html' : urlPath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return serveStatic(res, filePath);
  }

  // SPA fallback
  const index = path.join(STATIC_DIR, 'index.html');
  if (fs.existsSync(index)) return serveStatic(res, index);

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket upgrade handler ──
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }

  const opts = {
    hostname: BACKEND_HOST,
    port: BACKEND_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` },
  };

  const backendReq = http.request(opts);
  backendReq.on('upgrade', (backendRes, backendSocket, backendHead) => {
    // 告诉浏览器升级成功
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      Object.entries(backendRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') +
      '\r\n\r\n'
    );

    // 双向管道
    socket.pipe(backendSocket).pipe(socket);

    // 写入 WebSocket 握手尾帧
    if (backendHead.length > 0) socket.write(backendHead);
  });

  backendReq.on('error', () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
  });

  backendReq.end();
});

server.listen(PORT, () => {
  console.log(`[Frontend] http://localhost:${PORT} (proxy → ${BACKEND_HOST}:${BACKEND_PORT})`);
  console.log(`[Frontend] ws://localhost:${PORT}/ws (proxy → ws://${BACKEND_HOST}:${BACKEND_PORT}/ws)`);
});
