// ============================================================
// title-fallback.test.ts —— 列表标题回落形状（cr-891）：空会话
// （lastActivity 缺席 = 无消息，isSingleFresh 同源口径）恒「新会话」——
// 切换预设（agentId 空 → 非空）不改回落形状；有消息后回落 Agent 名。
// 桩 = phantom-singles.test.ts 同款（真 cordis Context + localStorage 桩）。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { Context } from '@agentchat/cordis';

let SingleBoardService: typeof import('../client/index.ts').SingleBoardService;
type SingleSession = import('../client/index.ts').SingleSession;

function makeSession(p: Partial<SingleSession>): SingleSession {
  return {
    id: 's1', agentId: '', createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z', status: 'active', ...p,
  };
}

beforeAll(async () => {
  // index.ts 模块加载时捕获 globalThis.localStorage——桩先注入
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
  };
  ({ SingleBoardService } = await import('../client/index.ts'));
});

function makeBoard() {
  const ctx = new Context() as unknown as Record<string, unknown>;
  const activeSingleId = { value: '' };
  ctx.sessions = {
    feed: { activeSingleId },
    chat: { setSingleContext: () => undefined, clearSingleContext: () => undefined },
  };
  ctx.roster = { defaultPresetId: { value: '__standard__' } };
  ctx.rpc = { onEvent: () => () => undefined, call: async () => ({}) };
  return new SingleBoardService(ctx as never);
}

describe('列表标题回落（cr-891）', () => {
  it('空会话 + 预设已选（agentId 非空）= 恒「新会话」——切换预设不改回落形状', () => {
    expect(makeBoard().titleOf(makeSession({ agentId: '__creator__' }), () => '创建者')).toBe('新会话');
  });

  it('空会话未选预设 =「新会话」（原有行为）', () => {
    expect(makeBoard().titleOf(makeSession({}), () => 'x')).toBe('新会话');
  });

  it('空会话有 title（草稿派生/手改）= title 优先', () => {
    expect(makeBoard().titleOf(makeSession({ agentId: '__creator__', title: '正在写的草稿' }), () => '创建者')).toBe('正在写的草稿');
  });

  it('有消息会话（lastActivity 在场）回落 Agent 名（cr-892：与头部同形状，无创建时间）', () => {
    const title = makeBoard().titleOf(makeSession({ agentId: '__creator__', lastActivity: '2026-11-04T01:00:00.000Z' }), () => '创建者');
    expect(title).toBe('创建者');
  });
});
