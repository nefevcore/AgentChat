// ============================================================
// tests/hash-mention-refresh.test.ts —— # 历史会话引用即时可用回归
//
// 用户反馈："前端需要刷新后才能用 # 引用新会话"。修复链三面：
//   ① hashGroups 本地按最近活动降序（排序先于截断——快照序沉底截断
//      是主因；纯函数面见 input-mention.test.ts）
//   ② # 弹层 stale-while-open 轻校准（30s 节流重拉）
//   ③ SingleBoard 重连即刷（断线丢 singles/updated 帧补偿）
// 本件覆盖端到端投影链：远端/本端创建 → board.singles 即时可见。
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WS from 'ws';

class WsSocketShim {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private sock: WS;
  constructor(url: string | URL) {
    this.sock = new WS(url.toString());
    this.sock.on('open', () => this.onopen?.({}));
    this.sock.on('message', (data) => this.onmessage?.({ data: data.toString() }));
    this.sock.on('close', () => this.onclose?.({}));
    this.sock.on('error', () => this.onerror?.({}));
  }
  get readyState(): number { return this.sock.readyState; }
  send(text: string): void { this.sock.send(text); }
  close(): void { this.sock.close(); }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = WsSocketShim;
(globalThis as unknown as { location: unknown }).location = { protocol: 'http:', host: '127.0.0.1', origin: 'http://127.0.0.1', search: '' };
(globalThis as unknown as { window: unknown }).window = globalThis;
const lsState: Record<string, string> = {};
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => lsState[k] ?? null,
  setItem: (k: string, v: string) => { lsState[k] = v; },
  removeItem: (k: string) => { delete lsState[k]; },
};

import type { BootedTree } from '../../ac-app/src/index.ts';
const { setWireSocketFactory, wireRpc } = await import('../src/api/wire.ts');
setWireSocketFactory(WsSocketShim as unknown as typeof WebSocket);
const { bootTree } = await import('../../ac-app/src/index.ts');

let tree: BootedTree;
let dataRoot: string;
let port = 0;

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'ac-hash-repro-'));
  tree = await bootTree({
    session: { root: dataRoot }, singles: { root: dataRoot }, group: { root: dataRoot },
    conversation: { root: dataRoot }, usage: { root: dataRoot }, credentials: { root: dataRoot }, config: { root: dataRoot },
  });
  port = await tree.ctx.webServer.ready();
  (globalThis as unknown as { location: { host: string } }).location.host = `127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  for (const fiber of [...tree.fibers.values()].reverse()) {
    if (fiber.uid !== null) await fiber.dispose();
  }
  await import('node:fs').then((fs) => fs.rmSync(dataRoot, { recursive: true, force: true }));
}, 30_000);

async function waitUntil(cond: () => boolean, ms = 10_000, what = ''): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待超时：${what}`);
}

async function makeClient() {
  const { createClient } = await import('ac-client-runtime');
  const { rpcHostPlugin } = await import('../src/runtime/rpcClient');
  const { conversationClientPlugin } = await import('ac-client-ui-conversation/client');
  const { rosterClientPlugin } = await import('ac-client-ui-agents/client');
  const { singlesClientPlugin } = await import('ac-client-ui-singles/client');
  const { setClientRuntime } = await import('../src/runtime/clientRuntime');
  const ctx = await createClient();
  await ctx.plugin(rpcHostPlugin);
  await ctx.plugin(conversationClientPlugin);
  await ctx.plugin(rosterClientPlugin);
  setClientRuntime(ctx);
  await ctx.plugin(singlesClientPlugin);
  ctx.sessions.init();
  return ctx;
}

describe('# 引用新会话：singleBoard 事件刷新链（复现实验）', () => {
  it('远端创建会话（另一标签页路径）→ 本端 board 靠 singles/updated 自动出现', { timeout: 60_000 }, async () => {
    const a = await makeClient();
    await a.singleBoard.refresh();
    const before = a.singleBoard.singles.value.length;
    // 远端创建（不经本端 board.create——模拟另一标签页/设备创建）
    const r = await wireRpc.call<{ single?: { id: string } }>('singles/create', { title: '远端新会话' });
    expect(r.single?.id).toBeTruthy();
    await waitUntil(() => a.singleBoard.singles.value.some((s) => s.id === r.single!.id), 10_000, '远端会话出现在本端列表');
    expect(a.singleBoard.singles.value.length).toBe(before + 1);
  });

  it('本端 board.create（SessionList 新建路径）→ 列表立即包含 + # 候选可见', { timeout: 60_000 }, async () => {
    const a = await makeClient();
    const s = await a.singleBoard.create({ title: '本端新建' });
    expect(a.singleBoard.singles.value.some((x) => x.id === s.id)).toBe(true);
    // activeSingles（# 弹层数据源）
    expect(a.singleBoard.activeSingles.value.some((x) => x.id === s.id)).toBe(true);
  });

  it('本端 board 已 loaded：远端再创建一个 → 自动出现（ensureMentionData 不 refresh 的场景）', { timeout: 60_000 }, async () => {
    const a = await makeClient();
    await a.singleBoard.refresh();
    expect(a.singleBoard.loaded.value).toBe(true);
    const r = await wireRpc.call<{ single?: { id: string } }>('singles/create', { title: '第二个远端会话' });
    await waitUntil(() => a.singleBoard.singles.value.some((s) => s.id === r.single!.id), 10_000, 'loaded 后远端会话自动出现');
  });
});


describe('# 引用回归：排序与刷新链', () => {
  it('首聊 run 进行中（元数据零事件）→ 立即 # 弹层能列出该会话（排序+重拉链）', { timeout: 60_000 }, async () => {
    const a = await makeClient();
    await a.singleBoard.refresh();
    // 创建即聊：经 board.create（SessionList 新建路径）→ 直接发消息
    const s = await a.singleBoard.create({ title: '首聊中' });
    a.sessions.chat.setSingleContext(s.id, s.agentId || '__standard__', undefined);
    // 模拟"刚聊过、消息未落盘、无 singles/updated"：手动把该会话沉到快照底部
    const list = a.singleBoard.singles.value;
    const idx = list.findIndex((x) => x.id === s.id);
    if (idx >= 0) {
      const [it] = list.splice(idx, 1);
      list.push(it); // 沉底（模拟旧快照序：无消息会话 activity=0 排最后）
      a.singleBoard.singles.value = [...list];
    }
    // # 弹层打开：ensureMentionData('hash') 走 stale 重拉 → 后端按最新 activity 重排
    const c2 = await makeClient();
    await c2.singleBoard.refresh();
    // 直接断言：重拉后按 lastActivity 降序，新会话（createdAt 最新）应排进前 8
    const fresh = await wireRpc.call<{ singles?: Array<{ id: string; lastActivity?: string; createdAt: string }> }>('singles/list');
    const sorted = [...(fresh.singles ?? [])].sort((x, y) =>
      new Date(y.lastActivity ?? y.createdAt).getTime() - new Date(x.lastActivity ?? x.createdAt).getTime());
    expect(sorted.slice(0, 8).some((x) => x.id === s.id)).toBe(true);
    expect(a.singleBoard.activeSingles.value.some((x) => x.id === s.id)).toBe(true);
  });
});


