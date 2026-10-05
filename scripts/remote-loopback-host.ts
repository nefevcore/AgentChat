// ============================================================
// scripts/remote-loopback-host.ts —— loopback 验证宿主（一次性）
//
// bootTree 起完整组合树（skip llm-pool 等重行不必要——照常全起，脚本会话短），
// remote-link 行注入 relayUrl 指向本地 relay。打印 web-server 端口后待命。
// ============================================================
import { bootTree } from '../src/ac-app/src/index.ts';

const RELAY = process.env.LOOPBACK_RELAY ?? 'ws://127.0.0.1:18443';

// 端口 env 可覆盖（本机 3839 落 Windows 动态端口排除段 3831-3930 时换 LOOPBACK_PORT）
const PORT = Number(process.env.LOOPBACK_PORT ?? 3839);
const AUTO_RECONNECT = process.env.LOOPBACK_AUTO_RECONNECT === '1';
const { ctx } = await bootTree({
  'web-server': { port: PORT, heartbeatMs: 0 },
  'remote-link': { relayUrl: RELAY, autoReconnect: AUTO_RECONNECT, root: 'sandbox/loopback-data', defaultScopes: ['read', 'chat'] },
});

// KK 排查观察口：remote-link 生命周期事件
ctx.on('remote/device-paired', (id: string) => console.log('[host:event] paired', id));
ctx.on('remote/device-online', (id: string) => console.log('[host:event] online', id));
ctx.on('remote/device-offline', (id: string, reason: string) => console.log('[host:event] offline', id, reason));

const web = ctx.get('webServer') as { rpcMethods(): string[]; listening: Promise<number> };
console.log('[host] web-server RPC 面:', web.rpcMethods().filter((m) => m.startsWith('remote/')).join(', '));
console.log('[host] READY port=' + (await web.listening));
if ((await web.listening) !== PORT) { console.error('[host] FATAL: 监听口不符'); process.exit(1); }

// 待命：stdin 结束或 SIGINT 退出
process.stdin.resume();
process.on('SIGINT', () => process.exit(0));