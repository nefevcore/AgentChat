// M7 手测脚本：连 ws://127.0.0.1:3830，rpc/call agents/list → usage/tokens → group/list → group/create
// 运行：node --import tsx src/ac-app/src/m7-rpc-check.ts（boot 已起时）
import WebSocket from 'ws';

const url = process.env.AC_WS_URL ?? 'ws://127.0.0.1:3830';
const ws = new WebSocket(url);
const pending = new Map<string, (v: unknown) => void>();
let seq = 0;

function call(method: string, params?: unknown): Promise<unknown> {
  const requestId = `m7-${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ type: 'rpc/call', data: { method, requestId, params } }));
    setTimeout(() => reject(new Error(`rpc ${method} 超时`)), 8000).unref?.();
  });
}

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString()) as { type: string; data?: Record<string, unknown> };
  if (frame.type === 'rpc/result' && typeof frame.data?.requestId === 'string') {
    const resolve = pending.get(frame.data.requestId);
    if (resolve) {
      pending.delete(frame.data.requestId);
      resolve(frame.data);
    }
  } else if (frame.type !== 'ws/ready') {
    console.log(`[帧] ${frame.type} ${JSON.stringify(frame.data).slice(0, 120)}`);
  }
});

ws.on('open', async () => {
  try {
    const agents = await call('agents/list');
    console.log('agents/list →', JSON.stringify((agents as { result?: { agents?: unknown[] } }).result?.agents?.map((a) => (a as { id: string }).id)));
    const usage = await call('usage/tokens');
    console.log('usage/tokens → keys:', Object.keys((usage as { result?: object }).result ?? {}));
    const groups = await call('group/list');
    console.log('group/list →', JSON.stringify((groups as { result?: { groups?: unknown[] } }).result?.groups?.length) + ' 个群');
    const created = await call('group/create', { name: 'M7 手测群', members: [] });
    console.log('group/create →', JSON.stringify((created as { result?: { group?: { id: string } } }).result?.group?.id));
    const gid = (created as { result?: { group?: { id: string } } }).result?.group?.id;
    if (gid) {
      const gone = await call('group/delete', { groupId: gid });
      console.log('group/delete（自清理）→', JSON.stringify((gone as { result?: { deleted?: boolean } }).result?.deleted));
    }
    const bad = await call('no/such-method');
    console.log('no/such-method →', JSON.stringify((bad as { ok?: boolean; error?: string }).error));
    console.log('M7 RPC 面 ✓');
    process.exit(0);
  } catch (err) {
    console.error('手测失败:', err);
    process.exit(1);
  }
});
ws.on('error', (err) => {
  console.error('连接失败:', err.message);
  process.exit(1);
});
