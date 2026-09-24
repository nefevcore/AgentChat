// ============================================================
// identity-throughput.test.ts —— 身份贯通键控链路验证（2026-12 根治批）
// 后端 runId/stepId 发证 → 流式帧按键路由 → subcall 宿主精确匹配 →
// mergeHistory 键控对齐 → turn 前缀身份复用。含缺键回落启发式的兼容面。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let offlineRpc: typeof import('../client/feedStore.ts').offlineRpc;

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  offlineRpc = (await import('../client/feedStore.ts')).offlineRpc;
});

const CONV = 'alpha~user';

function newFeed() {
  return feedCore.createFeedCore(offlineRpc as never, () => new RosterCore());
}

describe('身份贯通：流式帧按 stepId 键控路由', () => {
  it('多步 run：各步 delta 落到各自载体，步收束关闭本步', () => {
    const feed = newFeed();
    const runId = 'run-x1';
    // run-started（sender=user 的直答会话）
    feed.ingestFrame('loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    // step 0
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { runId, stepId: `${runId}:0`, conversationId: CONV, sender: 'user', source: 'user' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId, stepId: `${runId}:0` } }, { delta: '第一步' }]);
    feed.ingestFrame('loop/after-step', ['alpha', { index: 0, text: '第一步', toolCalls: [{ id: 'tc1', name: 'read', arguments: '{}' }] }, { runId, stepId: `${runId}:0`, conversationId: CONV, sender: 'user', source: 'user' }]);
    // step 1（工具执行窗口后）
    feed.ingestFrame('loop/step-started', ['alpha', 1, [], { runId, stepId: `${runId}:1`, conversationId: CONV, sender: 'user', source: 'user' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId, stepId: `${runId}:1` } }, { delta: '第二步' }]);
    feed.ingestFrame('loop/after-step', ['alpha', { index: 1, text: '第二步', toolCalls: [] }, { runId, stepId: `${runId}:1`, conversationId: CONV, sender: 'user', source: 'user' }]);
    feed.ingestFrame('loop/after-run', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }, { finish: 'stop', text: '第二步' }]);

    const raw = feed.getRaw(`pair:${['alpha', 'user'].sort().join('|')}` as never);
    const agents = raw.filter((m: any) => m.role === 'agent' && m.stepId);
    // 两个 stepId 各自驻留在自己的载体上（不共用、不错位）
    expect(agents.map((m: any) => m.stepId)).toEqual([`${runId}:0`, `${runId}:1`]);
    expect(agents[0].content).toBe('第一步');
    expect(agents[1].content).toBe('第二步');
    // 收束后无残留流式
    expect(raw.some((m: any) => m.isStreaming)).toBe(false);
  });

  it('subcall 宿主：runId 精确挂靠（宿主步已收口仍命中）', () => {
    const feed = newFeed();
    const runId = 'run-x2';
    const dialogId = `pair:${['alpha', 'user'].sort().join('|')}` as never;
    feed.ingestFrame('loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { runId, stepId: `${runId}:0`, conversationId: CONV, sender: 'user', source: 'user' }]);
    // 步收束（带 run_code 调用）→ 宿主步 isStreaming=false
    feed.ingestFrame('loop/after-step', ['alpha', { index: 0, text: '', toolCalls: [{ id: 'hostCall', name: 'run_code', arguments: '{}' }] }, { runId, stepId: `${runId}:0`, conversationId: CONV, sender: 'user', source: 'user' }]);
    // run_code 子调用开始 + 结束（call.runId = 宿主 runId）
    feed.ingestFrame('tool/started', [{ agentId: 'alpha', conversationId: CONV, toolCallId: `${runId}#1`, name: 'read', runCodeSubcall: true, runId }]);
    feed.ingestFrame('tool/after-execute', [{ agentId: 'alpha', conversationId: CONV, toolCallId: `${runId}#1`, name: 'read', runCodeSubcall: true, runId }, { ok: true, output: '文件内容' }]);
    const raw = feed.getRaw(dialogId);
    const host = raw.find((m: any) => m.role === 'agent' && m.stepId === `${runId}:0`);
    expect(host).toBeTruthy();
    // 子调用挂进宿主步的 toolCalls（subcall 标记）——不因宿主步收口而失锚
    const tc = (host as any).toolCalls.find((t: any) => t.id === `${runId}#1`);
    expect(tc).toBeTruthy();
    expect(tc.subcall).toBe(true);
    expect(String(tc.result)).toContain('文件内容');
  });

  it('缺键回落：旧后端帧（无 runId/stepId）走 lastStreaming 路径不回归', () => {
    const feed = newFeed();
    feed.ingestFrame('loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { conversationId: CONV, sender: 'user', source: 'user' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' } }, { delta: '旧式流' }]);
    feed.ingestFrame('loop/after-step', ['alpha', { index: 0, text: '旧式流', toolCalls: [] }, { conversationId: CONV, sender: 'user', source: 'user' }]);
    feed.ingestFrame('loop/after-run', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }, { finish: 'stop', text: '旧式流' }]);
    const raw = feed.getRaw(`pair:${['alpha', 'user'].sort().join('|')}` as never);
    const asst = raw.find((m: any) => m.role === 'agent' && m.content === '旧式流');
    expect(asst).toBeTruthy();
    expect(raw.some((m: any) => m.isStreaming)).toBe(false);
  });
});

describe('mergeHistory 键控对齐', () => {
  it('历史行 stepId 与直播行同键 → 丢弃历史行不双卡；长度取胜保全内容', () => {
    const feed = newFeed();
    const runId = 'run-x3';
    const dialogId = `pair:${['alpha', 'user'].sort().join('|')}` as never;
    // 直播：run 进行中，step0 已收口（驻留 stepId）
    feed.ingestFrame('loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { runId, stepId: `${runId}:0`, conversationId: CONV, sender: 'user', source: 'user' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId, stepId: `${runId}:0` } }, { delta: '部分' }]);
    feed.ingestFrame('loop/after-step', ['alpha', { index: 0, text: '部分', toolCalls: [{ id: 'tc9', name: 'read', arguments: '{}' }] }, { runId, stepId: `${runId}:0`, conversationId: CONV, sender: 'user', source: 'user' }]);
    // 历史首屏：同 stepId 的 journal 行（更完整）+ viewer 消息
    const merged = feed.mergeHistory(dialogId, [
      { id: 'h-u', role: 'agent', content: '问题', agent_id: 'user', timestamp: 1000, persistedMsgId: 'mu1' },
      { id: 'h-s0', role: 'agent', content: '部分完整版', stepId: `${runId}:0`, agent_id: 'alpha', timestamp: 2000, persistedMsgId: 'ma1' },
    ] as any, true);
    expect(merged).toBeTruthy();
    const raw = feed.getRaw(dialogId);
    // 同键不双卡：stepId 行只有一条
    const keyed = raw.filter((m: any) => m.stepId === `${runId}:0`);
    expect(keyed.length).toBe(1);
    // 长度取胜：直播载体保全了 journal 的完整内容
    expect(keyed[0].content).toBe('部分完整版');
  });
});

describe('turn 前缀身份复用（步边界性能）', () => {
  it('步边界（末两条消息签名变化）→ 未变化前缀 turn 复用旧对象身份', async () => {
    const { buildTurnsIncremental } = await import('../client/feed.ts');
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const mk = (id: string, content: string, streaming = false) => ({
      id, role: 'agent' as const, content, timestamp: t0, agent_id: 'a', isStreaming: streaming,
    });
    // 轮次一（完成）+ 轮次二（步0 完成、步1 流式中）
    const base = [
      { id: 'u0', role: 'user' as const, content: 'q', timestamp: t0, agent_id: 'user' },
      mk('a0', '第一轮答'),
      { id: 'u1', role: 'user' as const, content: 'q2', timestamp: t0 + 5000, agent_id: 'user' },
      mk('a1', '步0'),
      mk('a2', '流式尾部', true),
    ];
    const memo1 = buildTurnsIncremental(null, base as any, true);
    // 步边界：a1 关闭（isStreaming 翻转 false→true 变化签名）+ a2 新增——多条变化
    const next = [...base.slice(0, 4), { ...mk('a2', '流式尾部更多'), isStreaming: true }];
    const memo2 = buildTurnsIncremental(memo1, next as any, true);
    // 前缀 turn（第一轮）身份复用——props 稳定不重渲染
    const first1 = memo1.turns.find((t: any) => t.agent_id === 'a' && t.final?.content === '第一轮答');
    const first2 = memo2.turns.find((t: any) => t.agent_id === 'a' && t.final?.content === '第一轮答');
    expect(first1).toBe(first2); // 同一对象
    // 尾部 turn 内容已更新
    const last = memo2.turns[memo2.turns.length - 1];
    expect((last as any).final).toBe(null); // 流式悬置
  });
});