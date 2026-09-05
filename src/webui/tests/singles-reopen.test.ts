// ============================================================
// tests/singles-reopen.test.ts —— singles 会话「重开加载历史」复现
// 场景：会话已有落盘历史（含未绑定 Agent 的空 agentId 形态），重新
// 选中会话 → DialogView 同款 loadHistory 调用 → 首屏应带回历史消息。
// 复现对象：workspace/home/sessions/singles/ws-mtoc7l26-yfif/5c2e3bf6-…
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WS from 'ws';

class WsSocketShim {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
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
(globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

import type { BootedTree } from '../../ac-app/src/index.ts';
const { setWireSocketFactory, wireRpc } = await import('../src/api/wire.ts');
setWireSocketFactory(WsSocketShim as unknown as typeof WebSocket);
const { bootTree } = await import('../../ac-app/src/index.ts');
const { useChatStore } = await import('../src/stores/chat.ts');
const { createSingle } = await import('../src/api/singles.ts');
const { createPinia, setActivePinia } = await import('pinia');
const { VIEWER_ID } = await import('../src/constants.ts');

let tree: BootedTree;
let dataRoot: string;
let port = 0;

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'ac-singles-reopen-'));
  tree = await bootTree({
    session: { root: dataRoot },
    singles: { root: dataRoot },
    group: { root: dataRoot },
    conversation: { root: dataRoot },
    usage: { root: dataRoot },
    credentials: { root: dataRoot },
    config: { root: dataRoot },
  });
  port = await tree.ctx.webServer.ready();
  (globalThis as unknown as { location: { host: string; origin: string } }).location.host = `127.0.0.1:${port}`;
  (globalThis as unknown as { location: { origin: string } }).location.origin = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  for (const fiber of [...tree.fibers.values()].reverse()) {
    if (fiber.uid !== null) await fiber.dispose();
  }
  await import('node:fs').then((fs) => fs.rmSync(dataRoot, { recursive: true, force: true }));
}, 30_000);

describe('singles 会话重开：历史首屏加载', () => {
  it('未绑定 Agent（agentId=""）的会话重开应带回历史', { timeout: 30_000 }, async () => {
    // ---- ① 空会话 + 直接种落盘历史（真实形态：user 行 + __standard__ 回复行）----
    const { session } = await createSingle({});
    await tree.ctx.session.append(session.id, 'user', { role: 'user', content: '调整下前端工具消息的ICON' });
    await tree.ctx.session.append(session.id, '__standard__', { role: 'user', content: '改动完成，类型检查通过' });

    // ---- ② 前端同款路径：refresh → selectSingle → DialogView 的 loadHistory ----
    setActivePinia(createPinia());
    const { useSinglesStore } = await import('../src/stores/singles.ts');
    const singlesStore = useSinglesStore();
    await singlesStore.refresh();
    const found = singlesStore.singles.find((s) => s.id === session.id);
    expect(found).toBeDefined();
    expect(found!.agentId).toBe('');
    singlesStore.selectSingle(session.id);

    const chat = useChatStore();
    // DialogView.vue 同款调用（props.single!.agentId 为空串）
    chat.loadHistory(VIEWER_ID.value, found!.agentId, session.id);
    await new Promise((r) => setTimeout(r, 800));

    const msgs = chat.messages;
    // 首屏应含两条落盘历史
    expect(msgs.some((m: any) => m.agent_id === 'user' && m.content === '调整下前端工具消息的ICON')).toBe(true);
    expect(msgs.some((m: any) => m.agent_id === '__standard__' && m.content === '改动完成，类型检查通过')).toBe(true);
  });

  it('RPC 直查：session/history 返回种入的记录', { timeout: 15_000 }, async () => {
    const { session } = await createSingle({ reuse: false });
    await tree.ctx.session.append(session.id, 'user', { role: 'user', content: '直查问题' });
    const r = await wireRpc.call<{ records?: Array<{ role: string; agent_id?: string; content: string }> }>(
      'session/history', { conversationId: session.id, limit: 50, offset: 0 });
    expect((r.records ?? []).some((x) => x.agent_id === 'user' && x.content === '直查问题')).toBe(true);
  });
});
