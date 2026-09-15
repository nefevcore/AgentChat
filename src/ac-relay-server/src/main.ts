// main.ts —— 传输层适配：ws 库 + TLS + 环境变量配置
//
//   RELAY_PORT      监听端口（缺省 8443）
//   RELAY_TLS_CERT  / RELAY_TLS_KEY   自签证书路径（设了即开 TLS）
//   RELAY_HOST      绑定地址（缺省 0.0.0.0）
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { RelayCore, type RelayConn } from './index.ts';

const core = new RelayCore();

const port = Number(process.env.RELAY_PORT ?? 8443);
const host = process.env.RELAY_HOST ?? '0.0.0.0';
const cert = process.env.RELAY_TLS_CERT;
const key = process.env.RELAY_TLS_KEY;

const httpServer = cert && key
  ? createServer({ cert: readFileSync(cert), key: readFileSync(key) })
  : createServer({}); // 无证书 = 明文 ws（本机回环测试用；生产必配 TLS）

const wss = new WebSocketServer({ server: httpServer, maxPayload: 1024 * 1024 });

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
