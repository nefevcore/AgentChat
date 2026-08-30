// singles/files Port B 真链路验证：对运行中的 preview:boot（3830）
// 验证 api/singles.ts（RPC 面）与 api/files.ts（HTTP 面）。
// 用法：node preview/scripts/verify-singles-files-portb.mjs
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:3830');
let seq = 0;
const pending = new Map();

function rpc(method, params) {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const requestId = `v-${nonce}-${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, method });
    ws.send(JSON.stringify({ type: 'rpc/call', data: { method, requestId, params: params ?? {} } }));
    setTimeout(() => {
      if (pending.has(requestId)) { pending.delete(requestId); reject(new Error(`timeout: ${method}`)); }
    }, 8000);
  });
}

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.type !== 'rpc/result') return;
  const p = pending.get(frame.data.requestId);
  if (!p) return;
  pending.delete(frame.data.requestId);
  if (frame.data.ok) p.resolve(frame.data.result); else p.reject(new Error(`${p.method}: ${frame.data.error}`));
});

async function http(path, init) {
  const resp = await fetch(`http://127.0.0.1:3830${path}`, init);
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

ws.on('open', async () => {
  try {
    // singles CRUD（活数据只读验证 + 建删闭环）
    const before = await rpc('singles/list');
    console.log(`singles/list: ${(before.singles ?? []).length} 个 active`);
    const created = await rpc('singles/create', { title: 'port-b 验证会话' });
    const sid = created.single?.id;
    console.log(`singles/create: ${sid} agentId="${created.single?.agentId}"`);
    const upd = await rpc('singles/update', { id: sid, title: 'port-b 改名' });
    console.log(`singles/update: title="${upd.single?.title}"`);
    const arch = await rpc('singles/archive', { id: sid });
    console.log(`singles/archive: status=${arch.single?.status}`);
    const del = await rpc('singles/delete', { id: sid });
    console.log(`singles/delete: ${JSON.stringify(del)}`);

    // workspaces CRUD（HTTP）
    const wsList = await http('/api/workspaces');
    console.log(`workspaces: ${wsList.status} → ${(wsList.body?.workspaces ?? []).length} 个登记`);

    // workspace 文件面（HTTP）
    const tree = await http('/api/workspace/tree');
    console.log(`workspace/tree: ${tree.status} → ${(tree.body?.children ?? []).length} 个根节点`);
    const firstFile = (tree.body?.children ?? []).find((c) => c.type === 'file');
    if (firstFile) {
      const file = await http(`/api/workspace/file?path=${encodeURIComponent(firstFile.name)}`);
      console.log(`workspace/file(${firstFile.name}): ${file.status} base64=${file.body?.base64} binary 注入点=${file.body?.base64 !== undefined} contentType=${file.body?.contentType ?? ''}`);
    }
    const uiExt = await http('/api/ui/extensions');
    console.log(`ui/extensions: ${uiExt.status} → ${(uiExt.body?.extensions ?? []).length} 个`);

    console.log('OK: singles/files Port B 后端面全部就绪');
    ws.close(); process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    ws.close(); process.exit(1);
  }
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
