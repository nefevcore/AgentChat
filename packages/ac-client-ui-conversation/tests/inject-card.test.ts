// ============================================================
// inject-card.test.ts —— 注入卡链路（2026-09-26 注入卡·数据层归位）
//
// 覆盖三面：
//   1. toHistoryMessages：注入型 context 行保留正文（contextContent）；
//      机制行（source:event/error）不带。
//   2. buildTurns 注入行挂轮（数据层）：run 中途注入不拆轮原位挂
//      （afterStep=步序）；cur 空/ viewer 轮暂存挂下一轮头；无轮降级
//      system 空轮 → useTurnDisplayItems 独立卡 item；机制行维持分隔。
//   3. 真实管线回归：pairMessageToChatMessage 透传（子代理视图路径）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { computed } from 'vue';
import { toHistoryMessages } from 'ac-client-ui-conversation/client/historyApi.ts';
import { buildTurns, pairMessageToChatMessage } from 'ac-client-ui-conversation/client/feed.ts';
import { useTurnDisplayItems } from 'ac-client-ui-conversation/client/useTurnDisplayItems.ts';
import { VIEWER_ID } from 'ac-client-ui-conversation/client/viewer.ts';

const INJ_BODY = '<system-reminder>技能正文</system-reminder>';

describe('toHistoryMessages：注入行正文透传', () => {
  it('注入型行（source:skill）带 contextContent，label 仍是行文案', () => {
    const rows = [{ role: 'context', content: INJ_BODY, source: 'skill', label: '已加载技能 demo', agent_id: 'a', message_id: 'ctx-1', timestamp: new Date(1000).toISOString(), seq: 1 }];
    const out = toHistoryMessages(rows as never, 'a~user');
    const ev = out.find((m) => m.role === 'event') as Record<string, unknown>;
    expect(ev).toBeTruthy();
    expect(ev.contextContent).toBe(INJ_BODY);
    expect(ev.content).toBe('已加载技能 demo');
  });

  it('机制行（source:event）与错误行不带——维持分隔符通道', () => {
    const rows = [
      { role: 'context', content: '定时触发', source: 'event', agent_id: 'a', message_id: 'e1', timestamp: new Date(1000).toISOString(), seq: 1 },
      { role: 'context', content: 'LLM 失败', source: 'error', agent_id: 'a', message_id: 'e2', timestamp: new Date(1100).toISOString(), seq: 2 },
    ];
    const out = toHistoryMessages(rows as never, 'a~user');
    for (const m of out) expect((m as Record<string, unknown>).contextContent).toBeUndefined();
  });
});

// —— buildTurns 挂轮（数据层归位）：直播消息形态构造 ——

/** 注入 event 行（直播 showEventNotice 产物同形） */
const injMsg = (id: string, ts: number, content?: string) => ({
  id, role: 'event', content: '已加载技能 demo', agent_id: 'system', timestamp: ts,
  source: { kind: 'skill' },
  ...(content !== undefined ? { contextContent: content } : {}),
} as never);

/** agent 步消息（流式内部形态） */
const stepMsg = (id: string, ts: number, agentId = 'a') => ({
  id, role: 'agent', content: '', thinking: '思考', agent_id: agentId, timestamp: ts, toolCalls: [],
} as never);

describe('buildTurns：注入行挂轮（数据层）', () => {
  it('run 中途注入不拆轮——单轮承载，afterStep=注入时刻已积步数', () => {
    const turns = buildTurns([
      stepMsg('s1', 1000),      // 步1（已思考）
      injMsg('c1', 1500, INJ_BODY), // mid-run 注入（步1 后）
      stepMsg('s2', 2000),      // 步2（已思考）
    ]);
    expect(turns.length).toBe(1); // ← 核心断言：不拆成两个「思考过程」轮
    expect(turns[0].injects?.length).toBe(1);
    expect(turns[0].injects?.[0].afterStep).toBe(1); // 挂步1 之后
    expect(turns[0].injects?.[0].content).toBe(INJ_BODY);
    expect(turns[0].steps.length).toBe(2);
  });

  it('收束后注入（下一 run 前）→ 挂前轮链尾（时间线原位：注入发生在该 run 后）', () => {
    const turns = buildTurns([
      stepMsg('s1', 1000),
      { id: 'f1', role: 'agent', content: '终稿', thinking: '', agent_id: 'a', timestamp: 1200, toolCalls: [] } as never,
      injMsg('c1', 1500),
      { id: 's2', role: 'agent', content: '', thinking: '新run思考', agent_id: 'b', timestamp: 2000, toolCalls: [] } as never,
    ]);
    // s1+f1 同轮（sender a）；s2 异 sender 另起轮
    expect(turns.length).toBe(2);
    expect(turns[0].injects?.length).toBe(1); // 挂前轮（注入时刻的在场轮）
    expect(turns[0].injects?.[0].afterStep).toBe(2); // 链尾（已积 2 条消息后）
    expect(turns[1].injects).toBeUndefined();
  });

  it('viewer 轮在场（pre-run 手势注入）→ 暂存挂下一 agent 轮头部', () => {
    const turns = buildTurns([
      { id: 'u1', role: 'user', content: '/demo', agent_id: VIEWER_ID.value, timestamp: 1000 } as never,
      injMsg('c1', 1100),
      stepMsg('s1', 2000),
    ]);
    expect(turns.length).toBe(2); // 用户轮 + agent 轮
    expect(turns[0].injects).toBeUndefined(); // 不挂用户轮
    expect(turns[1].injects?.length).toBe(1);
    expect(turns[1].injects?.[0].afterStep).toBe(0);
  });

  it('前后皆无 agent 轮 → system 空轮降级承载（渲染层转独立卡）', () => {
    const turns = buildTurns([injMsg('c1', 1000, INJ_BODY)]);
    const deg = turns.find((t) => t.agent_id === 'system');
    expect(deg?.injects?.length).toBe(1);
  });

  it('机制行（source:event）维持 event 分隔轮，不卡片化', () => {
    const turns = buildTurns([
      { id: 't1', role: 'event', content: '定时触发', agent_id: 'system', timestamp: 1000, source: { kind: 'event' } } as never,
    ]);
    expect(turns[0].final?.role).toBe('event');
    expect(turns[0].injects).toBeUndefined();
  });
});

describe('useTurnDisplayItems：降级轮 → 独立卡 item', () => {
  it('system 空轮 injects 逐卡转独立 item', () => {
    const turns = buildTurns([injMsg('c1', 1000, INJ_BODY)]);
    const items = useTurnDisplayItems(computed(() => turns)).value;
    const inj = items.find((i) => i.type === 'inject');
    expect(inj?.inject?.label).toBe('已加载技能 demo');
    expect(inj?.inject?.content).toBe(INJ_BODY);
  });
});

describe('真实管线回归：pairMessageToChatMessage 透传', () => {
  it('注入 event 行经 pair 转换保留 source/contextContent（子代理视图路径）', () => {
    const rows = [{ role: 'context', content: INJ_BODY, source: 'skill', label: '已加载技能 demo', agent_id: 'a', message_id: 'ctx-1', timestamp: new Date(1000).toISOString(), seq: 1 }];
    const out = toHistoryMessages(rows as never, 'a~user');
    const cm = pairMessageToChatMessage(out[0] as never, 'a');
    expect(cm.source?.kind).toBe('skill');
    expect(cm.contextContent).toBe(INJ_BODY);
    // 经 buildTurns：单轮挂靠（历史路径与直播同构）
    const turns = buildTurns([cm, stepMsg('s1', 2000)]);
    expect(turns.filter((t) => t.steps.length > 0).length).toBe(1);
    expect(turns.find((t) => t.steps.length > 0)?.injects?.length).toBe(1);
  });
});