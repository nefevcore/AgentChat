// chat-core 消息操作回归（2026-12 架构对齐重写）：regenerate/edit/delete
// 三函数的会话键按形态分流（single = sid / pair = 对桶键）、持久层走
// truncate（单次原子）、附件随重发保留。
import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { createChatCore } from 'ac-client-ui-conversation/client/chat-core.ts';
import type { FeedView } from 'ac-client-ui-conversation/client/feed-core.ts';
import type { ChatMessage } from 'ac-client-ui-conversation/client/types.ts';

function mockFeed(raws: Record<string, ChatMessage[]>) {
  const store = raws; // 引用共享：外部可断言 setRaw 结果
  return {
    // toRefs 消费的响应式状态面（chat-core 构造时解构）
    turnInProgress: ref(false),
    loadingHistory: ref(false),
    hasMoreHistory: ref(false),
    lastStepEndAt: ref(0),
    archivePending: ref(false),
    unreadAgents: ref(new Set<string>()),
    activeDialogId: 'single:s1' as const,
    activeSingleId: 's1' as string | null,
    getRaw: (id: string) => store[id] ?? [],
    setRaw: (id: string, msgs: ChatMessage[]) => { store[id] = msgs; },
    removeMessage: (id: string, msgId: string) => { store[id] = (store[id] ?? []).filter((m) => m.id !== msgId); },
    replaceMessage: (id: string, msgId: string, patch: Partial<ChatMessage>) => {
      store[id] = (store[id] ?? []).map((m) => (m.id === msgId ? { ...m, ...patch } : m));
    },
    truncateAfter: (id: string, index: number) => { store[id] = (store[id] ?? []).slice(0, index); },
    setActiveSingle: () => {},
    clearActiveSingle: () => {},
  } as unknown as FeedView & Record<string, unknown>;
}

function setup(raws: Record<string, ChatMessage[]>) {
  const calls: Array<{ method: string; params: any }> = [];
  void raws;
  const rpc = {
    call: (method: string, params?: any) => { calls.push({ method, params }); return Promise.resolve({}); },
    onEvent: () => () => {},
  };
  const core = createChatCore(mockFeed(raws), rpc as any, () => ({
    activeAgentId: ref('a1'),
    defaultPresetId: ref(''),
    bumpAgent: () => {},
  }) as any);
  return { core, calls };
}

// single 上下文激活（setSingleContext 登记元数据）
function activateSingle(core: ReturnType<typeof createChatCore>) {
  core.setSingleContext('s1', 'a1');
}

const msgs = (extra: ChatMessage[] = []): ChatMessage[] => [
  { id: 'u1', role: 'agent', content: '旧问题', agent_id: 'user', timestamp: 1 },
  { id: 'a1', role: 'agent', content: '旧回答', agent_id: 'a1', timestamp: 2, persistedMsgId: 'm-a1' },
  { id: 'u2', role: 'agent', content: '新问题', agent_id: 'user', timestamp: 3, persistedMsgId: 'm-u2', files: [{ hash: 'h', filename: 'f.png', filesize: 1, text: 'ws://f.png' }] },
  { id: 'a2', role: 'agent', content: '新回答', agent_id: 'a1', timestamp: 4, persistedMsgId: 'm-a2' },
  ...extra,
];

describe('chat-core 消息操作（single 会话键 + truncate + 附件）', () => {
  it('regenerate：truncate 到触发行（含），single 键 = sid，前端不再保留 idx 之后旧消息', async () => {
    const store: Record<string, ChatMessage[]> = { 'single:s1': msgs() };
    const { core, calls } = setup(store);
    activateSingle(core);
    core.regenerateMessage('a2');
    // 持久层：单次 session/truncate，键 = sid，锚点 = 用户触发行
    const trunc = calls.filter((c) => c.method === 'session/truncate');
    expect(trunc).toHaveLength(1);
    expect(trunc[0].params).toEqual({ conversationId: 's1', messageId: 'm-u2' });
    expect(calls.some((c) => c.method === 'session/delete-message')).toBe(false);
    // 前端：触发消息起清空——setRaw 后只剩 旧行前缀 + 新 user 气泡（3 条）
    await vi.waitFor(() => {
      expect(store['single:s1'].length).toBe(3);
    });
    expect(store['single:s1'][2].agent_id).toBe('user');
    expect(store['single:s1'][2].content).toBe('新问题');
  });

  it('regenerate：重发携带原附件（files 透传 _sendRaw → deliver）', async () => {
    const { core, calls } = setup({ 'single:s1': msgs() });
    activateSingle(core);
    core.regenerateMessage('a2');
    await vi.waitFor(() => {
      expect(calls.some((c) => c.method === 'conversation/deliver')).toBe(true);
    });
    const deliver = calls.find((c) => c.method === 'conversation/deliver');
    expect(String(deliver!.params.message)).toContain('新问题');
    expect(String(deliver!.params.message)).toContain('[附件]'); // composeContent 附件行
    expect(deliver!.params.conversationId).toBe('s1');
  });

  it('edit：truncate 单次原子（不再逐条 delete），single 键 = sid', () => {
    const { core, calls } = setup({ 'single:s1': msgs() });
    activateSingle(core);
    core.editMessage('u2', '改后的问题');
    const trunc = calls.filter((c) => c.method === 'session/truncate');
    expect(trunc).toHaveLength(1);
    expect(trunc[0].params).toEqual({ conversationId: 's1', messageId: 'm-u2' });
    expect(calls.some((c) => c.method === 'session/delete-message')).toBe(false);
  });

  it('delete：single 键 = sid（不再恒走对桶键）', () => {
    const { core, calls } = setup({ 'single:s1': msgs() });
    activateSingle(core);
    core.deleteMessage('a1');
    const del = calls.find((c) => c.method === 'session/delete-message');
    expect(del!.params).toEqual({ conversationId: 's1', messageId: 'm-a1' });
  });
});