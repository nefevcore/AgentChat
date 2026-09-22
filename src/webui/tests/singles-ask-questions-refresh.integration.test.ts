// ============================================================
// tests/singles-ask-questions-refresh.test.ts —— Bug 复现：
// Single 会话 Agent 调 ask_questions 提问 → 前端刷新 → 无法继续回复
//
// 全链路复现（singles-multiturn 同款脚手架）：
//   ① single 会话 + Agent（scripted LLM：首步调 ask_questions）
//   ② sendMessage → run 中工具挂起等待（durable-interaction pending）
//   ③ 模拟刷新：丢弃全部前端内存态（新 client ctx + 新 pinia），
//      按 main.ts / PrimarySidebarHost 同序列重建（restoreLastSingle +
//      sessions.init → restorePendingInteractions）
//   ④ 断言：interaction 弹窗恢复 + respondInteraction 作答 →
//      Agent run 被唤醒续跑收束（"刷新后无法继续回复"复现/回归）
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

// 后端重启用例：旧前端连接的 in-flight RPC 在 onclose 被 failAll reject
//（生产由前端 catch 面/重连恢复消费；测试全局兜底防 vitest unhandled 噪音）
process.on('unhandledRejection', () => undefined);

// ---- localStorage 桩：可控读写（lastContext 恢复链数据源） ----
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

/** scripted LLM：该会话首个 run 首步调 ask_questions，工具结果回来后续步收束回文本 */
function askQuestionsRow() {
  const inputs: Array<Record<string, unknown>> = [];
  const row = {
    name: 'mock-askq-llm',
    inject: ['llm'],
    apply(ctx: any) {
      ctx.llm.register('askq', () => ({
        stream: async function* (input: Record<string, unknown>) {
          inputs.push(JSON.parse(JSON.stringify(input)));
          const msgs = (input.messages as Array<{ role?: string; content?: string }>) ?? [];
          const answered = msgs.some((m) => m.role === 'user' && String(m.content ?? '').includes('已收到用户回答'));
          const hasAssistant = msgs.some((m) => m.role === 'assistant');
          if (!hasAssistant) {
            // 首步：调 ask_questions（run 挂起等待用户回答）
            yield { delta: '', toolCalls: [{ index: 0, id: 'askq-1', name: 'ask_questions' }] };
            yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: JSON.stringify({ questions: [{ question: '选 A 还是 B？', options: ['A', 'B'] }] }) }] };
            yield { delta: '', finish: 'tool_calls' };
          } else if (!answered) {
            // awaiting 已回但答案未注入（2026-02 挂起重构）：收尾说明，
            // 自然停 → loop/run-idle 挂起等用户
            yield { delta: '请你选一下' };
            yield { delta: '', finish: 'stop', usage: { prompt: 10, completion: 2 } };
          } else {
            // 答案注入消息在场（作答后 idle 续走）：收束
            yield { delta: '已收到回答' };
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
  dataRoot = await mkdtemp(join(tmpdir(), 'ac-single-askq-'));
  tree = await bootTree({
    session: { root: dataRoot },
    singles: { root: dataRoot },
    group: { root: dataRoot },
    conversation: { root: dataRoot },
    usage: { root: dataRoot },
    credentials: { root: dataRoot },
    config: { root: dataRoot },
  });
  const r = askQuestionsRow();
  inputs = r.inputs;
  await tree.ctx.plugin(r.row as never);
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

async function waitUntil(cond: () => boolean, ms = 15_000, what = ''): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待超时：${what}`);
}

describe('Single 会话 ask_questions 刷新恢复（全链路）', () => {
  it('run 挂起等待时刷新 → 弹窗恢复 + 作答 → run 续跑收束', { timeout: 90_000 }, async () => {
    const { createAgent } = await import('ac-client-ui-agents/client');
    const { createSingle } = await import('ac-client-ui-singles/client');
    await createAgent({ id: 'helper', name: '小助手', provider: 'askq', llm: { model: 'mock-1' }, tags: ['infra'], tools: { include: ['ask_questions'] } }, wireRpc);
    const { session } = await createSingle({ agentId: 'helper' }, wireRpc);

    // ---- ① 前端（刷新前）：发送消息 → run 挂起在 ask_questions ----
    const { createClient } = await import('ac-client-runtime');
    const { rpcHostPlugin } = await import('../src/runtime/rpcClient');
    const { conversationClientPlugin } = await import('ac-client-ui-conversation/client');
    const { rosterClientPlugin } = await import('ac-client-ui-agents/client');
    const { singlesClientPlugin } = await import('ac-client-ui-singles/client');
    const { setClientRuntime } = await import('../src/runtime/clientRuntime');
    const { createPinia, setActivePinia } = await import('pinia');
    const { useChatStore } = await import('ac-client-ui-conversation/client/chatStore.ts');

    const clientCtx = await createClient();
    await clientCtx.plugin(rpcHostPlugin);
    await clientCtx.plugin(conversationClientPlugin);
    await clientCtx.plugin(rosterClientPlugin);
    setClientRuntime(clientCtx);
    await clientCtx.plugin(singlesClientPlugin);
    clientCtx.sessions.init();
    setActivePinia(createPinia());
    const chat1 = useChatStore();
    const singlesBoard1 = clientCtx.singleBoard;
    await singlesBoard1.refresh();
    singlesBoard1.selectSingle(session.id);

    chat1.sendMessage('帮我选一下');
    // run 到 ask_questions 挂起（live opened 帧到达 + interaction 弹窗出现）
    await waitUntil(() => !!chat1.interaction, 15_000, '刷新前 interaction 弹窗出现');
    expect(chat1.interaction?.questions[0]?.question).toBe('选 A 还是 B？');

    // ---- ② 模拟刷新：丢弃前端内存态（旧 ctx 不再使用；lastContext 已记录 single） ----
    // localStorage 里已有 selectSingle 写入的 {kind:'single', id:sid}
    expect(JSON.parse(lsState['agentchat.lastContext'] ?? '{}').id).toBe(session.id);

    const clientCtx2 = await createClient();
    await clientCtx2.plugin(rpcHostPlugin);
    await clientCtx2.plugin(conversationClientPlugin);
    await clientCtx2.plugin(rosterClientPlugin);
    setClientRuntime(clientCtx2);
    await clientCtx2.plugin(singlesClientPlugin);
    clientCtx2.sessions.init(); // main.ts 同序列 → restorePendingInteractions 发起
    setActivePinia(createPinia());
    const chat2 = useChatStore();
    const singlesBoard2 = clientCtx2.singleBoard;
    await singlesBoard2.refresh();
    // PrimarySidebarHost onMounted 同款恢复
    const restored = singlesBoard2.restoreLastSingle();
    expect(restored).toBe(session.id);

    // ---- ③ 断言：刷新后弹窗恢复（interaction/list → pendingInteractions → computed 路由） ----
    await waitUntil(() => !!chat2.interaction, 15_000, '刷新后 interaction 恢复');
    expect(chat2.interaction?.questions[0]?.question).toBe('选 A 还是 B？');

    // ---- ④ 作答 → 后端 run 唤醒续跑收束 ----
    chat2.respondInteraction(['A']);
    await waitUntil(() => !chat2.contextBusy, 30_000, 'run 续跑收束（contextBusy 回落）');
    // run 收束：续走步的 LLM 输入包含答案注入消息（2026-02 挂起重构：
    // ask_questions 即返 awaiting，答案经 loop/run-idle 注入 user 语义位消息）
    await waitUntil(
      () => inputs.some((i) =>
        (i.messages as Array<{ role?: string; content?: string }> | undefined)
          ?.some((m) => m.role === 'user' && String(m.content ?? '').includes('已收到用户回答'))),
      15_000,
      'LLM 输入包含 answers 注入消息',
    );
    // 历史收束：回答后的最终 assistant 文本落盘
    const hist = await wireRpc.call<{ records?: Array<{ role?: string; agent_id?: string; content?: string }> }>(
      'session/history', { conversationId: session.id });
    const okHist = (hist.records ?? []).some((r) => {
      if (r.agent_id !== 'helper') return false;
      if (String(r.content ?? '').includes('已收到回答')) return true;
      // 收束行折叠形态：终文本在 steps[]（流式分段时 content 为尾段，旧 run
      // 折叠步在 steps——两处都算会话事实）
      const steps = (r as any).steps as Array<{ content?: string }> | undefined;
      return Array.isArray(steps) && steps.some((st) => String(st.content ?? '').includes('已收到回答'));
    });
    expect(okHist).toBe(true);
  });

  it('空会话（未选 Agent → __standard__ 默认预设）同场景：刷新后作答入口恢复', { timeout: 90_000 }, async () => {
    const { createSingle, updateSingle: singlesUpdate } = await import('ac-client-ui-singles/client');
    const { session: blank } = await createSingle({ reuse: false }, wireRpc);
    // 预设模型解析依赖池配置——会话级模型覆盖补齐（portb-e2e 同款）
    await singlesUpdate(blank.id, { model: 'mock-1' }, wireRpc);

    const { createClient } = await import('ac-client-runtime');
    const { rpcHostPlugin } = await import('../src/runtime/rpcClient');
    const { conversationClientPlugin } = await import('ac-client-ui-conversation/client');
    const { rosterClientPlugin } = await import('ac-client-ui-agents/client');
    const { singlesClientPlugin } = await import('ac-client-ui-singles/client');
    const { setClientRuntime } = await import('../src/runtime/clientRuntime');
    const { createPinia, setActivePinia } = await import('pinia');
    const { useChatStore } = await import('ac-client-ui-conversation/client/chatStore.ts');

    // ---- 刷新前：空会话发送 → __standard__ run 挂起 ask_questions ----
    const c1 = await createClient();
    await c1.plugin(rpcHostPlugin);
    await c1.plugin(conversationClientPlugin);
    await c1.plugin(rosterClientPlugin);
    setClientRuntime(c1);
    await c1.plugin(singlesClientPlugin);
    c1.sessions.init();
    setActivePinia(createPinia());
    const chat1 = useChatStore();
    await c1.singleBoard.refresh();
    c1.singleBoard.selectSingle(blank.id);

    chat1.sendMessage('帮我选一下（空会话）');
    await waitUntil(() => !!chat1.interaction, 15_000, '空会话：刷新前弹窗出现');
    expect(chat1.interaction?.agent_id).toBe('__standard__');

    // ---- 刷新（全新 client + 恢复链）----
    const c2 = await createClient();
    await c2.plugin(rpcHostPlugin);
    await c2.plugin(conversationClientPlugin);
    await c2.plugin(rosterClientPlugin);
    setClientRuntime(c2);
    await c2.plugin(singlesClientPlugin);
    c2.sessions.init();
    setActivePinia(createPinia());
    const chat2 = useChatStore();
    await c2.singleBoard.refresh();
    expect(c2.singleBoard.restoreLastSingle()).toBe(blank.id);

    await waitUntil(() => !!chat2.interaction, 15_000, '空会话：刷新后弹窗恢复');
    // 作答 → run 收束
    chat2.respondInteraction(['B']);
    await waitUntil(() => !chat2.contextBusy, 30_000, '空会话：run 续跑收束');
  });

  it('后端重启（进程重启）：pending 提问持久恢复 + 作答后 late-reply 唤醒新 run', { timeout: 120_000 }, async () => {
    // ---- 阶段一：挂起提问（run 死于"重启"）----
    const { createAgent } = await import('ac-client-ui-agents/client');
    const { createSingle } = await import('ac-client-ui-singles/client');
    await createAgent({ id: 'survivor', name: '重启幸存者', provider: 'askq', llm: { model: 'mock-1' }, tags: ['infra'], tools: { include: ['ask_questions'] } }, wireRpc);
    const { session } = await createSingle({ agentId: 'survivor' }, wireRpc);

    const { createClient } = await import('ac-client-runtime');
    const { rpcHostPlugin } = await import('../src/runtime/rpcClient');
    const { conversationClientPlugin } = await import('ac-client-ui-conversation/client');
    const { rosterClientPlugin } = await import('ac-client-ui-agents/client');
    const { singlesClientPlugin } = await import('ac-client-ui-singles/client');
    const { setClientRuntime } = await import('../src/runtime/clientRuntime');
    const { createPinia, setActivePinia } = await import('pinia');
    const { useChatStore } = await import('ac-client-ui-conversation/client/chatStore.ts');

    const bootClient = async () => {
      const c = await createClient();
      await c.plugin(rpcHostPlugin);
      await c.plugin(conversationClientPlugin);
      await c.plugin(rosterClientPlugin);
      setClientRuntime(c);
      await c.plugin(singlesClientPlugin);
      c.sessions.init();
      return c;
    };

    const c1 = await bootClient();
    setActivePinia(createPinia());
    const chat1 = useChatStore();
    await c1.singleBoard.refresh();
    c1.singleBoard.selectSingle(session.id);
    chat1.sendMessage('重启前的问题');
    await waitUntil(() => !!chat1.interaction, 15_000, '重启前：run 挂起 ask_questions');

    // ---- 模拟后端重启：dispose 全部行 fiber（run 死亡、内存 store 清空）----
    for (const fiber of [...tree.fibers.values()].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
    tree.fibers.clear();
    tree = await bootTree({
      session: { root: dataRoot },
      singles: { root: dataRoot },
      group: { root: dataRoot },
      conversation: { root: dataRoot },
      usage: { root: dataRoot },
      credentials: { root: dataRoot },
      config: { root: dataRoot },
    });
    const r2 = askQuestionsRow();
    await tree.ctx.plugin(r2.row as never);
    const port2 = await tree.ctx.webServer.ready();
    (globalThis as unknown as { location: { host: string; origin: string } }).location.host = `127.0.0.1:${port2}`;
    (globalThis as unknown as { location: { origin: string } }).location.origin = `http://127.0.0.1:${port2}`;

    // ---- 阶段二：重启后的前端（刷新恢复链）----
    const c2 = await bootClient();
    setActivePinia(createPinia());
    const chat2 = useChatStore();
    await c2.singleBoard.refresh();
    // 后端重启后 singles 注册表从磁盘重扫——并行负载下扫描可能在首个
    // refresh 响应后才完成（列表缺行）。restoreLastSingle 落空会误清
    // lastContext（副作用），不能轮询 restore 本身——轮询刷新至列表
    // 到位（refresh 的 inFlight 合并防重入），再 restore 一次并断言。
    await waitUntil(() => {
      void c2.singleBoard.refresh();
      return c2.singleBoard.singles.value.some((s) => s.id === session.id);
    }, 15_000, '重启后：singles 列表到位');
    expect(c2.singleBoard.restoreLastSingle()).toBe(session.id);
    // jsonl 持久化：重启后 pending 恢复（修复前 memory 后端——全丢，此断言红）
    await waitUntil(() => !!chat2.interaction, 15_000, '重启后：pending 提问持久恢复');

    // 作答 → late-reply 唤醒（run 已死，无活跃 run）→ 新 run 收束
    chat2.respondInteraction(['A']);
    await waitUntil(() => !chat2.contextBusy, 30_000, '重启后：late-reply 唤醒新 run 收束');
    // 新 run 的最终回复落盘（历史含「已收到回答」）
    await waitUntil(async () => {
      const hist = await wireRpc.call<{ records?: Array<{ agent_id?: string; content?: string }> }>(
        'session/history', { conversationId: session.id });
      return (hist.records ?? []).some((x) => x.agent_id === 'survivor' && String(x.content ?? '').includes('已收到回答'));
    }, 20_000, '重启后：新 run 收束文本落盘');
  });

  it('多条提问并发（同一步两个 ask_questions）+ 纯前端刷新：逐条恢复逐条作答', { timeout: 120_000 }, async () => {
    // scripted LLM：首步【并行】调两个 ask_questions（多 pending 的典型成因——
    // 单 Agent 同一 run 挂起两条交互；用户反馈"多条提问"场景）
    const dualRow = {
      name: 'mock-dual-askq-llm',
      inject: ['llm'],
      apply(ctx: any) {
        ctx.llm.register('dual', () => ({
          stream: async function* (input: Record<string, unknown>) {
            const msgs = (input.messages as Array<{ role?: string; content?: string }>) ?? [];
            const toolMsgs = msgs.filter((m) => m.role === 'tool');
            const answeredCount = toolMsgs.filter((m) => String(m.content ?? '').includes('"answers"')).length;
            const hasAssistant = msgs.some((m) => m.role === 'assistant');
            if (!hasAssistant) {
              // 首步：并行两条提问（index 0/1 两个工具调用）
              yield { delta: '', toolCalls: [{ index: 0, id: 'askq-a', name: 'ask_questions' }] };
              yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: JSON.stringify({ questions: [{ question: '第一问？', options: ['A1', 'B1'] }] }) }] };
              yield { delta: '', toolCalls: [{ index: 1, id: 'askq-b', name: 'ask_questions' }] };
              yield { delta: '', toolCalls: [{ index: 1, argumentsDelta: JSON.stringify({ questions: [{ question: '第二问？', options: ['A2', 'B2'] }] }) }] };
              yield { delta: '', finish: 'tool_calls' };
            } else if (answeredCount < 2) {
              // 两条工具结果未齐（一条已答时中间态）——继续等待模型步不收束
              yield { delta: '', finish: 'stop', usage: { prompt: 10, completion: 1 } };
            } else {
              yield { delta: `两条都答完了：${answeredCount}` };
              yield { delta: '', finish: 'stop', usage: { prompt: 10, completion: 2 } };
            }
          },
        }), { models: ['mock-1'] });
      },
    };
    await tree.ctx.plugin(dualRow as never);

    const { createAgent } = await import('ac-client-ui-agents/client');
    const { createSingle } = await import('ac-client-ui-singles/client');
    await createAgent({ id: 'dualasker', name: '双问者', provider: 'dual', llm: { model: 'mock-1' }, tags: ['infra'], tools: { include: ['ask_questions'] } }, wireRpc);
    const { session } = await createSingle({ agentId: 'dualasker' }, wireRpc);

    const { createClient } = await import('ac-client-runtime');
    const { rpcHostPlugin } = await import('../src/runtime/rpcClient');
    const { conversationClientPlugin } = await import('ac-client-ui-conversation/client');
    const { rosterClientPlugin } = await import('ac-client-ui-agents/client');
    const { singlesClientPlugin } = await import('ac-client-ui-singles/client');
    const { setClientRuntime } = await import('../src/runtime/clientRuntime');
    const { createPinia, setActivePinia } = await import('pinia');
    const { useChatStore } = await import('ac-client-ui-conversation/client/chatStore.ts');

    const bootClient = async () => {
      const c = await createClient();
      await c.plugin(rpcHostPlugin);
      await c.plugin(conversationClientPlugin);
      await c.plugin(rosterClientPlugin);
      setClientRuntime(c);
      await c.plugin(singlesClientPlugin);
      c.sessions.init();
      return c;
    };

    // ---- ① 刷新前：两条 pending 同会话并存 ----
    const c1 = await bootClient();
    setActivePinia(createPinia());
    const chat1 = useChatStore();
    await c1.singleBoard.refresh();
    c1.singleBoard.selectSingle(session.id);
    chat1.sendMessage('问两个问题');
    await waitUntil(() => !!chat1.interaction, 15_000, '刷新前：弹窗出现');

    // 两条 pending 都在后端
    const list = await wireRpc.call<{ interactions?: Array<{ id: string; state: string }> }>(
      'interaction/list', { state: 'pending' });
    const pendings = (list.interactions ?? []).filter((i) => i.state === 'pending');
    expect(pendings.length).toBeGreaterThanOrEqual(2);

    // ---- ② 纯前端刷新（后端不动：run 仍挂起）----
    const c2 = await bootClient();
    setActivePinia(createPinia());
    const chat2 = useChatStore();
    await c2.singleBoard.refresh();
    expect(c2.singleBoard.restoreLastSingle()).toBe(session.id);

    // ---- ③ 刷新后：第一条恢复（列表路由命中） ----
    await waitUntil(() => !!chat2.interaction, 15_000, '刷新后：第一条提问恢复');

    // ---- ④ 逐条作答：列表降序 → 最新（第二问）先显示，答完接棒较早的第一问 ----
    // 调试快照：后端应有两条同会话 pending
    const dbg = await wireRpc.call<{ interactions?: Array<{ id: string; state: string; key: string; createdAt: number }> }>(
      'interaction/list', { state: 'pending' });
    const pendings2 = (dbg.interactions ?? []).filter((i) => i.state === 'pending' && i.key === session.id);
    expect(pendings2.length).toBe(2);
    // 降序路由：先显示 created_at 更大的（后发出的"第二问"）
    expect(chat2.interaction?.questions[0]?.question).toBe('第二问？');
    chat2.respondInteraction(['B2']);
    // 第二问已答 → replied 按 id 出列 → 剩余第一问接棒
    await waitUntil(() => chat2.interaction?.questions[0]?.question === '第一问？', 10_000, '答完第二问：第一问接棒');
    chat2.respondInteraction(['A1']);
    // 两条都答完 → run 收束
    await waitUntil(() => !chat2.contextBusy, 30_000, '两条答完：run 收束');
  });
});
