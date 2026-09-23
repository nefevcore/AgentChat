// ============================================================
// scripts/remote-loopback-host.ts —— loopback 验证宿主（一次性）
//
// bootTree 起完整组合树（skip llm-pool 等重行不必要——照常全起，脚本会话短），
// remote-link 行注入 relayUrl 指向本地 relay。打印 web-server 端口后待命。
// ============================================================
import { bootTree } from '../src/ac-app/src/index.ts';

const RELAY = process.env.LOOPBACK_RELAY ?? 'ws://127.0.0.1:18443';

const { ctx } = await bootTree({
  'web-server': { port: 3839, heartbeatMs: 0 },
  'remote-link': { relayUrl: RELAY, autoReconnect: false, root: '.dsh/tmp/loopback-data' },
});

const web = ctx.get('webServer') as { rpcMethods(): string[] };
console.log('[host] web-server RPC 面:', web.rpcMethods().filter((m) => m.startsWith('remote/')).join(', '));
console.log('[host] READY port=3839');

// 待命：stdin 结束或 SIGINT 退出
process.stdin.resume();
process.on('SIGINT', () => process.exit(0));