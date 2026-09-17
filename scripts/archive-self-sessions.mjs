// 归档驱动：连本机 AgentChat WS，逐会话调 session/archive，等待完成确认。
// 用法：node scripts/archive-self-sessions.mjs [--ids a~a,b~b] [--timeout 300000]
//
// 帧协议（ac-ws-protocol）：
//   发送 {"type":"rpc/call","data":{"method":"session/archive","requestId":"...","params":{...}}}
//   接收 {"type":"rpc/result","data":{requestId, ok, result|error}}
//   广播 {"type":"archive/completed","data":{conversationId, archived, kept, segment}}
import { WebSocket } from 'ws';

const URL = 'ws://127.0.0.1:3830';
const DEFAULT_IDS = [
  'admin~admin',
  'deloitte-consultant~deloitte-consultant',
  'designer~designer',
  'editor~editor',
  'impc-consultant~impc-consultant',
  'mathematician~mathematician',
  'news~news',
  'writer~writer',
];

const args = process.argv.slice(2);
let idsArg;
{
  const i = args.indexOf('--ids');
  if (i >= 0) idsArg = args[i + 1];
}
const TIMEOUT = (() => {
  const i = args.indexOf('--timeout');
  return i >= 0 ? Number(args[i + 1]) || 300000 : 300000;
})();
const ids = idsArg ? idsArg.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_IDS;

const ws = new WebSocket(URL, { origin: 'http://127.0.0.1:3830' });
const pending = new Map(); // requestId -> resolve
const completed = new Set();
let nextReq = 1;

const timer = setTimeout(() => {
  console.error('[archive-driver] 总超时，未完成会话:', ids.filter((id) => !completed.has(id)));
  process.exit(2);
}, TIMEOUT);

function callRpc(method, params) {
  return new Promise((resolve, reject) => {
    const requestId = `req-${nextReq++}`;
    pending.set(requestId, { resolve, reject });
    ws.send(JSON.stringify({ type: 'rpc/call', data: { method, requestId, params } }));
  });
}

ws.on('open', async () => {
  console.log('[archive-driver] WS 已连接，目标会话:', ids.join(', '));
  try {
    for (const id of ids) {
      const res = await callRpc('session/archive', { conversationId: id });
      console.log(`[archive-driver] ${id} 受理:`, JSON.stringify(res));
    }
    console.log('[archive-driver] 全部已受理，等待 archive/completed 广播...');
  } catch (err) {
    console.error('[archive-driver] 受理失败:', err);
    process.exit(1);
  }
});

ws.on('message', (raw) => {
  let frame;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (frame.type === 'rpc/result') {
    const { requestId, ok, result, error } = frame.data ?? {};
    const entry = pending.get(requestId);
    if (entry) {
      pending.delete(requestId);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error ?? 'rpc error'));
    }
    return;
  }
  if (frame.type === 'archive/completed') {
    const { conversationId, archived, kept, segment } = frame.data ?? {};
    console.log(`[archive-driver] ✓ 归档完成 ${conversationId}: archived=${archived} kept=${kept} segment=${segment ?? '-'}`);
    if (ids.includes(conversationId)) {
      completed.add(conversationId);
      if (completed.size === ids.length) {
        console.log('[archive-driver] 全部归档完成 ✓');
        clearTimeout(timer);
        ws.close();
        process.exit(0);
      }
    }
  }
});

ws.on('error', (err) => {
  console.error('[archive-driver] WS 错误:', err.message);
  process.exit(1);
});
