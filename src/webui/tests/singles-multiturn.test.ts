// ============================================================
// tests/singles-multiturn.test.ts —— singles 多轮记忆复现
// 场景：同一 single 会话连发两轮（真全链路：webui store →
// conversation/deliver → conversation → router → loop → scripted LLM），
// 第二轮 LLM 输入应包含第一轮 user 消息与回复。
// 复现对象：ws-mtoc7l26-yfif/5c2e3bf6 第二轮 amnesia（usage：turn2
// promptAcc 74k vs turn1 597k——空历史起步）。
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
const { setWireSocketFactory } = await import('../src/api/wire.ts');
setWireSocketFactory(WsSocketShim as unknown as typeof WebSocket);
const { bootTree } = await import('../../ac-app/src/index.ts');
const { useChatStore } = await import('../src/stores/chat.ts');
const { createAgent } = await import('../src/api/roster.ts');
const { createSingle, updateSingle: singlesUpdate } = await import('../src/api/singles.ts');
const { createPinia, setActivePinia } = await import('pinia');

/** 每次 LLM 调用回一句递增文本；快照全部 input 供断言（含「实录第一句」的 run 首步走工具） */
function seenInputsRow() {
  const inputs: Array<Record<string, unknown>> = [];
  let n = 0;
  const row = {
    name: 'mock-seen-llm',
    inject: ['llm'],
    apply(ctx: any) {
      ctx.llm.register('seen', () => ({
        stream: async function* (input: Record<string, unknown>) {
          inputs.push(JSON.parse(JSON.stringify(input)));
          n += 1;
          const msgs = (input.messages as Array<{ role?: string; content?: string }>) ?? [];
          const hasAssistant = msgs.some((m) => m.role === 'assistant');
          const hasTools = ((input.tools as unknown[]) ?? []).length > 0;
          if (!hasAssistant && hasTools) {
            // 该 run 首步且有工具：走一次工具（生产形态：多步工具循环）；
            // 工具步后消息列表出现 assistant 行 → 后续步回文本，防无限循环
            yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: 'hello' }] };
            yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{"message":"x"}' }] };
            yield { delta: '', finish: 'tool_calls' };
          } else {
            yield { delta: `第${n}次回复` };
            yield { delta: '', finish: 'stop', usage: { prompt: 10, completion: 2 } };
          }
        },
      }), { models: ['mock-1'] });
    },
  };
  return { row, inputs };
}

let tree: BootedTree;
let dataRoot: string;
let port = 0;
let inputs: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'ac-singles-mt-'));
  tree = await bootTree({
    session: { root: dataRoot },
    singles: { root: dataRoot },
    group: { root: dataRoot },
    conversation: { root: dataRoot },
    usage: { root: dataRoot },
    credentials: { root: dataRoot },
    config: { root: dataRoot },
  });
  const seen = seenInputsRow();
  inputs = seen.inputs;
  await tree.ctx.plugin(seen.row as any);
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

async function waitIdle(chat: ReturnType<typeof useChatStore>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!chat.contextBusy) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('singles 多轮记忆（全链路）', () => {
  it('绑定 Agent：第二轮 LLM 输入应包含第一轮对话', { timeout: 60_000 }, async () => {
    await createAgent({ id: 'helper', name: '小助手', provider: 'seen', llm: { model: 'mock-1' }, tools: { include: [] } });
    const { session } = await createSingle({ agentId: 'helper' });

    setActivePinia(createPinia());
    const chat = useChatStore();
    const { useSinglesStore } = await import('../src/stores/singles.ts');
    const singlesStore = useSinglesStore();
    await singlesStore.refresh();
    singlesStore.selectSingle(session.id);

    // ── 第一轮 ──
    chat.sendMessage('第一轮问题');
    await waitIdle(chat);
    await new Promise((r) => setTimeout(r, 300));
    // 首 run 后 singles 自动标题生成也走 llm.chat——按内容定位而非计数
    const turn1 = inputs.find((i) =>
      (i.messages as Array<{ content?: string }> | undefined)?.some((m) => String(m.content ?? '').includes('第一轮问题')));
    expect(turn1).toBeDefined();

    // ── 第二轮（会话空闲后独立投递，与生产时间线一致）──
    chat.sendMessage('第二轮问题');
    await waitIdle(chat);
    await new Promise((r) => setTimeout(r, 300));
    const turn2 = [...inputs].reverse().find((i) =>
      (i.messages as Array<{ content?: string }> | undefined)?.some((m) => String(m.content ?? '').includes('第二轮问题')));
    expect(turn2).toBeDefined();

    const contents = ((turn2 as { messages?: Array<{ role: string; content: string }> }).messages ?? [])
      .map((m) => String(m.content ?? ''));
    expect(contents.some((c) => c.includes('第一轮问题'))).toBe(true);
    expect(contents.some((c) => /第\d+次回复/.test(c))).toBe(true);
  });

  it('未绑定 Agent（默认预设 __standard__，生产实录形态）：第二轮同样应有记忆', { timeout: 60_000 }, async () => {
    const { session: blank } = await createSingle({ reuse: false });
    // 预设模型解析依赖池配置——会话级模型覆盖补齐（portb-e2e 同款）
    await singlesUpdate(blank.id, { model: 'mock-1' });

    setActivePinia(createPinia());
    const chat = useChatStore();
    const { useSinglesStore } = await import('../src/stores/singles.ts');
    const singlesStore = useSinglesStore();
    await singlesStore.refresh();
    singlesStore.selectSingle(blank.id);

    // ── 第一轮 ──
    chat.sendMessage('空会话第一句');
    await waitIdle(chat);
    await new Promise((r) => setTimeout(r, 300));
    const turn1 = inputs.find((i) =>
      (i.messages as Array<{ content?: string }> | undefined)?.some((m) => String(m.content ?? '').includes('空会话第一句')));
    expect(turn1).toBeDefined();

    // ── 第二轮 ──
    chat.sendMessage('空会话第二句');
    await waitIdle(chat);
    await new Promise((r) => setTimeout(r, 300));
    const turn2 = [...inputs].reverse().find((i) =>
      (i.messages as Array<{ content?: string }> | undefined)?.some((m) => String(m.content ?? '').includes('空会话第二句')));
    expect(turn2).toBeDefined();

    const contents = ((turn2 as { messages?: Array<{ role: string; content: string }> }).messages ?? [])
      .map((m) => String(m.content ?? ''));
    expect(contents.some((c) => c.includes('空会话第一句'))).toBe(true);
  });

  it('生产实录形态（工具步 + mid-run 系统通知 steer）：第二轮应有记忆', { timeout: 60_000 }, async () => {
    await createAgent({ id: 'helper2', name: '小助手2', provider: 'seen', llm: { model: 'mock-1' }, tools: { include: ['hello'] } });
    const { session } = await createSingle({ agentId: 'helper2' });

    setActivePinia(createPinia());
    const chat = useChatStore();
    const { useSinglesStore } = await import('../src/stores/singles.ts');
    const singlesStore = useSinglesStore();
    await singlesStore.refresh();
    singlesStore.selectSingle(session.id);

    // ── 第一轮（首步走工具）──
    chat.sendMessage('实录第一句');
    // 会话忙时投递机制通知（ac-job-wakeup 同款：source='event' → steer 通道）
    await tree.ctx.conversation.deliver('helper2', '[系统通知] 后台任务 bash-1（bash）完成：exit code: 0。', {
      sender: 'helper2',
      source: 'event',
      conversationId: session.id,
    });
    await waitIdle(chat);
    await new Promise((r) => setTimeout(r, 300));

    // ── 第二轮 ──
    chat.sendMessage('实录第二句');
    await waitIdle(chat);
    await new Promise((r) => setTimeout(r, 300));

    const turn2 = [...inputs].reverse().find((i) =>
      (i.messages as Array<{ content?: string }> | undefined)?.some((m) => String(m.content ?? '').includes('实录第二句')));
    expect(turn2).toBeDefined();
    const m2 = (turn2 as { messages?: Array<{ role: string; content: string; tool_call_id?: string }> }).messages ?? [];
    const contents = m2.map((m) => String(m.content ?? ''));
    expect(contents.some((c) => c.includes('实录第一句'))).toBe(true);
    expect(contents.some((c) => /第\d+次回复/.test(c))).toBe(true);
    expect(contents.some((c) => c.includes('系统通知'))).toBe(true);
    // 轨迹回放（缺省开）：第一轮的工具调用对也应进第二轮上下文——
    // 进程内视图与文件回放同深（2026-09-05 多轮失忆修复的回归锚）
    const toolRow = m2.find((m) => m.role === 'tool');
    expect(toolRow).toMatchObject({ tool_call_id: 'c1' });
    expect(String(toolRow?.content ?? '')).toContain('hello');
  });
});
