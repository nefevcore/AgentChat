// ============================================================
// live-turn-keys.test.ts —— cr-1289 直播步行键驻留
//
// 验证目标：直播步帧（llm/delta 惰性建卡 / step/journaled 终值）把
// runId + turnId 驻留载体——buildTurns 键控拆轮与 runsInWindow 挂靠
// 在【纯直播窗口】（无历史合并）直接命中，不再依赖历史行补键。
// 对齐 fold 投影语义（cr-1286）：run 承载行 turnId = run。
// 伴随验证：Node 无 window 时装配守卫不抛（浏览器全局接线走
// createFeedCore 装配路径）。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let feedMod: typeof import('../client/feed.ts');

const rpcStub = {
  call: (method: string) => Promise.resolve(method === 'session/history' ? { records: [], hasMore: false } : {}),
  onEvent: () => () => undefined,
};

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  feedMod = await import('../client/feed.ts');
});

const CONV = 'alpha~user';
const DIALOG = 'pair:alpha|user';

function newFeed() {
  return feedCore.createFeedCore(rpcStub as never, () => new RosterCore());
}

function delta(feed: any, stepId: string, payload?: Record<string, unknown>) {
  const runId = stepId.slice(0, stepId.indexOf(':'));
  return feed.ingestFrame('llm/delta', [{
    model: 'm',
    meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId, stepId },
  }, payload ?? {}]);
}

describe('cr-1289 直播步行键驻留', () => {
  it('delta 惰性建卡即驻留 runId/turnId——键控拆轮不依赖历史合并', () => {
    const feed = newFeed();
    feed.init();
    feed.append(DIALOG as never, { id: 'u1', role: 'agent', content: '问', timestamp: 1000, agent_id: 'user' });
    delta(feed, 'r1:0', { reasoning: '想' });
    delta(feed, 'r1:1', { delta: '答' });

    const raw = feed.getRaw(DIALOG as never);
    const steps = raw.filter((m: any) => m.role === 'agent' && m.agent_id === 'alpha');
    expect(steps).toHaveLength(2);
    for (const m of steps) {
      expect(m.runId).toBe('r1');
      expect(m.turnId).toBe('r1');
    }
    // 纯直播窗口键控：viewer 轮 + 单 agent 链；Turn.turnId = 轮首行键
    const turns = feedMod.buildTurns(raw, false);
    const agentTurn = turns.find((t: any) => t.agent_id === 'alpha');
    expect(agentTurn?.steps).toHaveLength(2);
    expect(agentTurn?.turnId).toBe('r1');
  });

  it('journal 终值路径（delta 全丢、step/journaled 兜底建卡）同驻', () => {
    const feed = newFeed();
    feed.init();
    feed.append(DIALOG as never, { id: 'u1', role: 'agent', content: '问', timestamp: 1000, agent_id: 'user' });
    feed.ingestFrame('step/journaled', [{
      agent: 'alpha', conversationId: CONV, run: 'r9', step: 0, stepId: 'r9:0', seq: 10,
      rows: [{ type: 'step/content', text: '兜底', ts: 2 }],
    }]);

    const raw = feed.getRaw(DIALOG as never);
    const step = raw.find((m: any) => m.role === 'agent' && m.stepId === 'r9:0');
    expect(step?.runId).toBe('r9');
    expect(step?.turnId).toBe('r9');
  });

  it('run 中途注入卡（直播帧行带 run 键）在纯直播窗口按键挂靠——inject-run-miss 不计', () => {
    const feed = newFeed();
    feed.init();
    feed.append(DIALOG as never, { id: 'u1', role: 'agent', content: '问', timestamp: 1000, agent_id: 'user' });
    delta(feed, 'r1:0', { reasoning: '想' });
    // context-injected 直播帧（cr-1285 起带 run 键；参数形 = 位置参数
    // [conversationId, agentId, meta]）——showEventNotice 产物行带 runId
    feed.ingestFrame('session/context-injected', [CONV, 'alpha', { source: 'skill', label: '已加载技能 demo', run: 'r1' }]);
    delta(feed, 'r1:1', { delta: '答' });

    const turns = feedMod.buildTurns(feed.getRaw(DIALOG as never), false);
    const agentTurn = turns.find((t: any) => t.agent_id === 'alpha');
    expect(agentTurn?.injects?.length).toBe(1);
    expect(agentTurn?.injects?.[0]?.afterStep).toBe(1); // 挂在步 0 与步 1 之间（run 键命中）
  });
});

describe('cr-1289 观察窗读面（dev 全局）', () => {
  it('Node 无 window：装配守卫跳过不抛（浏览器全局由 createFeedCore 路径挂接）', () => {
    const feed = newFeed();
    feed.init();
    expect(feed.getRaw(DIALOG as never)).toEqual([]);
  });
});
