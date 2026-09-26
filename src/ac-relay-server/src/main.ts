// main.ts —— 传输层适配：ws 库 + TLS + 环境变量配置
//
//   RELAY_PORT      监听端口（缺省 8443）
//   RELAY_TLS_CERT  / RELAY_TLS_KEY   自签证书路径（设了即开 TLS）
//   RELAY_HOST      绑定地址（缺省 0.0.0.0）
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_LIMITS, RelayCore, type RelayConn } from './index.ts';

const core = new RelayCore();

const port = Number(process.env.RELAY_PORT ?? 8443);
const host = process.env.RELAY_HOST ?? '0.0.0.0';
const cert = process.env.RELAY_TLS_CERT;
const key = process.env.RELAY_TLS_KEY;

const httpServer = cert && key
  ? createHttpsServer({
      cert: readFileSync(cert),
      key: readFileSync(key),
      // 安全基线（sec-scan 2026-09-16）：仅前向保密套件（ECDHE）——禁静态 RSA
      // 密钥交换（AES128/256-SHA 可被录流量+私钥泄露回溯解密）；minVersion
      // 已默认 TLS1.2，套件白名单实际只协商 ECDHE-GCM/CHACHA20
      ciphers: [
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-RSA-CHACHA20-POLY1305',
        'TLS_AES_256_GCM_SHA384',
        'TLS_AES_128_GCM_SHA256',
        'TLS_CHACHA20_POLY1305_SHA256',
      ].join(':'),
      honorCipherOrder: true,
    })
  : createHttpServer({}); // 无证书 = 明文 ws——必须走 node:http（https server 对明文握手只会挂起到超时：本地 loopback 全链路验证的踩坑存档）

// HTTP 面最小实现（上游方案 §4.3）：healthz 存活探测（无信息量：恒 200）。
// 同时兜住非 upgrade 的 HTTP 请求——无 handler 时 node http 会挂起连接
// （socket hang up 的来源），WS upgrade 本身不受影响。
httpServer.on('request', (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  res.writeHead(404).end();
});

// ws 层载荷上限留余量：超限判定归位到应用层（RelayCore 的 maxFrameBytes → 统一 close），
// 两者相等时超限帧在 ws 层即 error——**未挂 error handler 会冒泡崩掉整个中继进程**
// （M3.2 实测：单条 >1MB 帧使 relay status 1009 WS_ERR_UNSUPPORTED_MESSAGE_LENGTH 退出）。
const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: DEFAULT_LIMITS.maxFrameBytes + 64 * 1024,
});

wss.on('connection', (ws: WebSocket, req) => {
  const ip = req.socket.remoteAddress ?? 'unknown';
  const conn: RelayConn = {
    ip,
    send: (s) => { if (ws.readyState === ws.OPEN) ws.send(s); },
    close: () => ws.close(),
    terminate: () => ws.terminate(),
    onMessage: (h) => ws.on('message', (d) => h(d.toString())),
    onClose: (h) => ws.on('close', h),
  };
  // 传输层错误（超限帧/协议错/写失败）→ 只关该连接；中继是公共入口，
  // 单连接异常绝不允许带走进程（同款纪律见 web-server 的 wss error sink）
  ws.on('error', () => ws.terminate());
  if (!core.accept(conn)) ws.close(1013, 'try-again-later');
});

const sweeper = setInterval(() => core.sweep(), 60_000);
sweeper.unref?.();

httpServer.listen(port, host, () => {
  console.log(`[relay] listening on ${host}:${port} tls=${Boolean(cert && key)} rooms=0`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[relay] ${sig} — shutting down`);
    core.shutdown();
    wss.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
