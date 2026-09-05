// ============================================================
// interaction-restore.test.ts —— ask_questions 多 Agent 并发 pending 回归
//
// 背景 bug（2026-09-06 反馈：刷新后前端无法继续回复 ask_question，
// 多个 Agent 同时发起提问时尤甚）：store 的 ask_questions 交互是全局
// 单槽 interactionState——
//   · 刷新恢复 interaction/list 只取全局最新 1 条（pending[0]），其余
//     pending 记录永不可见；
//   · live 路径后到的 opened 帧直接覆盖前一条（多 Agent 并发提问即丢）；
//   · 作答/别处已答只清空单槽，没有机制拉取剩余 pending——答完一条后
//     其余条目全部失去作答入口（后端 timeout_ms=0 永久等待 → Agent 卡死）；
//   · InteractionBar 按当前 agent 门控：恢复到的"全局最新"若不是当前
//     会话的，当前会话的提问永远弹不出来。
//
// 修复语义：pendingInteractions 列表（按 created_at 降序、按 id upsert）
// + interaction computed 按当前上下文会话键路由（pair = viewer 对桶 /
// single = sid；旧载荷无 key 回落 agent 匹配）+ 重连恢复以快照为真源对账。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rpcCalls, wireHandlers, wireOpenHandlers, state } = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ method: string; params?: any }>,
  wireHandlers: [] as Array<(type: string, args: unknown[]) => void>,
  wireOpenHandlers: [] as Array<() => void>,
  state: { pendingRecords: [] as Array<Record<string, unknown>> },
}));

vi.mock('../src/api/wire', () => ({
  wireRpc: {
    call: vi.fn((method: string, params?: any) => {
      rpcCalls.push({ method, params });
      if (method === 'interaction/list') return Promise.resolve({ interactions: state.pendingRecords });
      if (method === 'interaction/reply') return Promise.resolve({ status: 'ok' });
      return Promise.reject(new Error('no rpc in test'));
    }),
    onWireEvent: vi.fn((h: (type: string, args: unknown[]) => void) => {
      wireHandlers.push(h);
      return () => {};
    }),
    onWireOpen: vi.fn((h: () => void) => {
      wireOpenHandlers.push(h);
      return () => {};
    }),
    onWireClose: vi.fn(() => () => {}),
    onWireAck: vi.fn(() => {}),
  },
}));
// node 环境无 window：logger 读取 LOG_LEVEL 会抛错（store 逻辑不受影响，仅降噪）
vi.mock('../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setActivePinia, createPinia } from 'pinia';
import { useFeedStore } from '../src/stores/feed';
import { useChatStore } from '../src/stores/chat';
import { useAgentStore } from '../src/stores/agents';

const A = 'alpha';
const B = 'beta';
const convA = [A, 'user'].sort().join('~'); // 'alpha~user'（bucketKey 同口径）
const convB = [B, 'user'].sort().join('~'); // 'beta~user'

/** interaction/list 恢复记录（原始 store 形：questions 在 payload 内） */
function rec(id: string, owner: string, key: string, createdAt: number, q: string): Record<string, unknown> {
  return {
    kind: 'ask_questions', id, owner, key, state: 'pending', createdAt,
    payload: { questions: [{ question: q, options: ['是', '否'] }] },
  };
}
/** live opened 帧（ws-bridge 整形形：questions 顶层） */
function live(id: string, owner: string, key: string | undefined, createdAt: number, q: string): Record<string, unknown> {
  return {
    kind: 'ask_questions', id, owner, ...(key ? { key } : {}), createdAt,
    questions: [{ question: q, options: ['是', '否'] }],
  };
}

function fire(type: string, ...args: unknown[]): void {
  for (const h of wireHandlers) h(type, args);
}
function openWire(): void {
  for (const h of wireOpenHandlers) h();
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('ask_questions 多 Agent 并发 pending（列表化 + 按会话路由）', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    wireHandlers.length = 0;
    wireOpenHandlers.length = 0;
    state.pendingRecords = [];
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    useAgentStore().activeAgentId = A;
  });

  it('刷新恢复：全部 pending 重挂 + 按当前会话路由（修复前只恢复全局最新 1 条，当前会话的可能永远弹不出来）', async () => {
    state.pendingRecords = [
      rec('dur-a', A, convA, 100, 'A 的问题'),
      rec('dur-b', B, convB, 200, 'B 的问题'), // 更新——修复前恢复的是它
    ];
    const chat = useChatStore();
    await flush();
    // 当前会话 = A：显示 A 的提问（修复前：槽里是全局最新 dur-b，被门控
    // 挡住 → A 会话永远弹不出来）
    expect(chat.interaction?.interaction_id).toBe('dur-a');
    expect(chat.interaction?.questions[0]?.question).toBe('A 的问题');
    // 切到 B 会话：B 的提问就位（同一份恢复数据，无需重拉）
    useAgentStore().activeAgentId = B;
    expect(chat.interaction?.interaction_id).toBe('dur-b');
  });

  it('作答一条：RPC 携正确 id + 出列；另一 Agent 的待答不受影响（修复前答完全局单槽即空，其余永不可答）', async () => {
    state.pendingRecords = [
      rec('dur-a', A, convA, 100, 'A 的问题'),
      rec('dur-b', B, convB, 200, 'B 的问题'),
    ];
    const chat = useChatStore();
    await flush();
    useAgentStore().activeAgentId = B;
    expect(chat.interaction?.interaction_id).toBe('dur-b');

    chat.respondInteraction(['是']);
    expect(rpcCalls.find((c) => c.method === 'interaction/reply')?.params).toMatchObject({
      id: 'dur-b',
      answer: { answers: ['是'] },
    });
    // B 已答 → 当前会话无待答；切回 A：A 的还挂着，作答入口仍在
    expect(chat.interaction).toBeNull();
    useAgentStore().activeAgentId = A;
    expect(chat.interaction?.interaction_id).toBe('dur-a');
  });

  it('live opened 多条共存：别家的提问不覆盖当前会话的显示（修复前后到帧直接覆盖前一条）', async () => {
    const chat = useChatStore();
    await flush();
    // A 先问、B 后问（B 更新）——两帧都落列表，互不覆盖
    fire('durable-interaction/opened', live('dur-a', A, convA, 300, 'A 先问'));
    fire('durable-interaction/opened', live('dur-b', B, convB, 400, 'B 后问'));
    expect(chat.interaction?.interaction_id).toBe('dur-a'); // A 会话不被更新的 B 帧挤掉
    useAgentStore().activeAgentId = B;
    expect(chat.interaction?.interaction_id).toBe('dur-b');
    // 同会话第二条（A 又问）→ 最新优先
    useAgentStore().activeAgentId = A;
    fire('durable-interaction/opened', live('dur-a2', A, convA, 500, 'A 又问'));
    expect(chat.interaction?.interaction_id).toBe('dur-a2');
  });

  it('replied/closed 帧按 id 出列：别处作答/后端超时后弹窗收起，同会话剩余 pending 接棒', async () => {
    const chat = useChatStore();
    await flush();
    fire('durable-interaction/opened', live('dur-a1', A, convA, 300, 'A 第一问'));
    fire('durable-interaction/opened', live('dur-a2', A, convA, 400, 'A 第二问'));
    expect(chat.interaction?.interaction_id).toBe('dur-a2');
    // 当前显示的这条被别处回答 → 下一条（同会话）接棒显示
    fire('durable-interaction/replied', { id: 'dur-a2' });
    expect(chat.interaction?.interaction_id).toBe('dur-a1');
    // 后端超时关闭 → 收起（列表空）
    fire('durable-interaction/closed', { id: 'dur-a1' });
    expect(chat.interaction).toBeNull();
  });

  it('single 会话路由：key = sid 精确匹配，同 Agent 的 1v1 提问不串台', async () => {
    state.pendingRecords = [
      rec('dur-pair', A, convA, 100, 'A 的 1v1 提问'),
      rec('dur-sid', A, 'sid-1', 200, 'A 的独立会话提问'),
    ];
    const chat = useChatStore();
    await flush();
    // 1v1 视图：只看到对桶键那条
    expect(chat.interaction?.interaction_id).toBe('dur-pair');
    // 独立会话视图：只看到 sid 那条（同 Agent 也不串台）
    chat.setSingleContext('sid-1', A);
    expect(chat.interaction?.interaction_id).toBe('dur-sid');
    chat.clearSingleContext();
    expect(chat.interaction?.interaction_id).toBe('dur-pair');
  });

  it('旧载荷（无 key）回落 agent 匹配：A 的提问在 B 会话不显示', async () => {
    const chat = useChatStore();
    await flush();
    fire('durable-interaction/opened', live('dur-legacy', A, undefined, 300, '旧载荷提问'));
    expect(chat.interaction?.interaction_id).toBe('dur-legacy');
    useAgentStore().activeAgentId = B;
    expect(chat.interaction).toBeNull(); // 无 key 回落 agent 匹配——B 会话不显示 A 的
  });

  it('重连对账：快照为真源——离线期间已被答的陈旧条目剔除，恢复在途新到的 live 帧保留', async () => {
    const chat = useChatStore();
    await flush();
    // 离线前 live 收到 dur-stale；离线期间它被别处回答（replied 帧错过）
    fire('durable-interaction/opened', live('dur-stale', A, convA, 300, '离线期间已被回答'));
    expect(chat.interaction?.interaction_id).toBe('dur-stale');
    // 重连：服务器 pending 快照里只有 dur-a（dur-stale 已 answered）
    state.pendingRecords = [rec('dur-a', A, convA, 100, 'A 的问题')];
    openWire();
    // 恢复 RPC 在途时新到的 live 帧（不在快照）——保留
    fire('durable-interaction/opened', live('dur-fresh', A, convA, 400, '在途新到'));
    await flush();
    // dur-stale 被快照剔除；同会话剩余按最新优先：dur-fresh
    expect(chat.interaction?.interaction_id).toBe('dur-fresh');
    // 快照里的 dur-a 仍在列表（dismiss 当前条后接棒）
    chat.dismissInteraction();
    expect(chat.interaction?.interaction_id).toBe('dur-a');
  });
});
