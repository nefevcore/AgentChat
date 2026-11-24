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
import { buildTurns, historyRowToChatMessage } from 'ac-client-ui-conversation/client/feed.ts';
import { registerInjectCardView } from 'ac-client-ui-conversation/client/injectCardViews.ts';
import { useTurnDisplayItems } from 'ac-client-ui-conversation/client/useTurnDisplayItems.ts';
import { VIEWER_ID } from 'ac-client-ui-conversation/client/viewer.ts';

const INJ_BODY = '<system-reminder>技能正文</system-reminder>';

describe('toHistoryMessages：注入行正文透传', () => {
  it('注入型行（source:skill）带 contextContent，label 仍是行文案', () => {
    const rows = [{ role: 'context', content: INJ_BODY, source: 'skill', label: '已加载技能 demo', agent_id: 'a', message_id: 'ctx-1', timestamp: new Date(1000).toISOString(), seq: 1 }];
    const out = toHistoryMessages(rows as never, 'a~user');
    const ev = out.find((m) => m.role === 'event')!;
    expect(ev).toBeTruthy();
    expect(ev.contextContent).toBe(INJ_BODY);
    expect(ev.content).toBe('已加载技能 demo');
  });

  it('机制行（source:event 无 label）与错误行不带——维持分隔符通道', () => {
    const rows = [
      { role: 'context', content: '定时触发', source: 'event', agent_id: 'a', message_id: 'e1', timestamp: new Date(1000).toISOString(), seq: 1 },
      { role: 'context', content: 'LLM 失败', source: 'error', agent_id: 'a', message_id: 'e2', timestamp: new Date(1100).toISOString(), seq: 2 },
    ];
    const out = toHistoryMessages(rows as never, 'a~user');
    for (const m of out) expect(m.contextContent).toBeUndefined();
  });

  it('会话设置变更通知行（cr-889：source:event + label/content 双在场）卡片化——正文透传 contextContent', () => {
    const rows = [{
      role: 'context',
      content: '[会话设置] 工具调用模式已切换：程序化——一切工具调用经 run_code 编排完成，不再逐个直调。',
      source: 'event', label: '会话设置变更', agent_id: 'a', message_id: 'e3',
      timestamp: new Date(1000).toISOString(), seq: 3,
    }];
    const out = toHistoryMessages(rows as never, 'a~user');
    const ev = out.find((m) => m.role === 'event')!;
    expect(ev).toBeTruthy();
    expect(ev.contextContent).toBe(rows[0].content);
    expect(ev.content).toBe('会话设置变更');
    // 经 buildTurns + useTurnDisplayItems → 注入卡（与 skill 行同通道）
    const turns = buildTurns([{ ...ev, id: 'live-1' } as never]);
    const deg = turns.find((t) => t.agent_id === 'system');
    expect(deg?.injects?.length).toBe(1);
    expect(deg?.injects?.[0].content).toBe(rows[0].content);
    expect(deg?.injects?.[0].label).toBe('会话设置变更');
    // 机制 event 行（无注载体）维持分隔符轮，不卡片化
    const mech = buildTurns([{ id: 't1', role: 'event', content: '定时触发', agent_id: 'system', timestamp: 1000, source: { kind: 'event' } } as never]);
    expect(mech[0].final?.role).toBe('event');
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

describe('真实管线回归：historyRowToChatMessage 透传', () => {
  it('注入 event 行经历史行转换保留 source/contextContent（pair 只读视图路径）', () => {
    const rows = [{ role: 'context', content: INJ_BODY, source: 'skill', label: '已加载技能 demo', agent_id: 'a', message_id: 'ctx-1', timestamp: new Date(1000).toISOString(), seq: 1 }];
    const out = toHistoryMessages(rows as never, 'a~user');
    const cm = historyRowToChatMessage(out[0] as never, { idPrefix: 'pair', fallbackAgentId: 'a' });
    expect(cm.source?.kind).toBe('skill');
    expect(cm.contextContent).toBe(INJ_BODY);
    // 经 buildTurns：单轮挂靠（历史路径与直播同构）
    const turns = buildTurns([cm, stepMsg('s1', 2000)]);
    expect(turns.filter((t) => t.steps.length > 0).length).toBe(1);
    expect(turns.find((t) => t.steps.length > 0)?.injects?.length).toBe(1);
  });

  it('问答卡载荷经 toHistoryMessages → pair 转换保留 payload（outcome 判据链——回执卡标题不退化为发起态）', () => {
    const rows = [{
      role: 'context', content: '[系统通知] 已收到用户回答…', source: 'durable-interaction', label: '已收到用户回答',
      agent_id: 'a', message_id: 'ctx-ans', timestamp: new Date(1000).toISOString(), seq: 1,
      payload: { questions: [{ question: '选哪个？', options: ['A', 'B'] }], answers: ['A'], outcome: 'answered' },
    }];
    const out = toHistoryMessages(rows as never, 'a~user');
    const ev = out.find((m) => m.role === 'event')!;
    expect(ev.payload).toMatchObject({ outcome: 'answered' });
    // pair 转换（子代理视图路径）不丢 payload——AskCard outcome 判据
    const cm = historyRowToChatMessage(ev as never, { idPrefix: 'pair', fallbackAgentId: 'a' });
    expect(cm.payload).toMatchObject({ outcome: 'answered', answers: ['A'] });
    // buildTurns 注入卡携带 payload（InjectCard 数据面完整）
    const turns = buildTurns([cm, stepMsg('s1', 2000)]);
    const inj = turns.find((t) => t.steps.length > 0)?.injects?.[0];
    expect(inj?.payload?.outcome).toBe('answered');
  });
});

describe('锚挂靠（cr-1132——投影层锚定，启发式坍缩）', () => {
  /** 历史路径消息（historyRowToChatMessage 产物形态——persistedMsgId/anchor 在场） */
  const histMsg = (o: Partial<import('ac-client-ui-conversation/client/types.ts').ChatMessage> & { id: string; role: string; timestamp: number }): any => ({
    agent_id: 'a', ...o,
  });

  it('锚目标在窗口内（卡后）→ 挂目标轮头（afterStep=0）', () => {
    const turns = buildTurns([
      histMsg({ id: 'u1', role: 'user', content: '问', agent_id: VIEWER_ID.value, persistedMsgId: 'u1', timestamp: 1000 }),
      { id: 'c1', role: 'event', content: '记忆注入', agent_id: 'system', timestamp: 1100, contextContent: '体', source: { kind: 'memory-snapshot' }, anchor: 'a1' } as never,
      histMsg({ id: 'a1s0', role: 'agent', content: '', thinking: '想', agent_id: 'a', persistedMsgId: 'a1', timestamp: 2000, toolCalls: [] }),
    ]);
    expect(turns.filter((t) => t.agent_id === 'a').length).toBe(1);
    const owner = turns.find((t) => t.agent_id === 'a')!;
    expect(owner.injects?.length).toBe(1);
    expect(owner.injects?.[0].afterStep).toBe(0);
    expect(turns.find((t) => t.agent_id === 'system')).toBeUndefined(); // 不降级
  });

  it('前向回落锚（卡在目标后）→ 挂最近 agent 轮尾', () => {
    const turns = buildTurns([
      histMsg({ id: 'a1s0', role: 'agent', content: '答', agent_id: 'a', persistedMsgId: 'a1', timestamp: 1000, toolCalls: [] }),
      { id: 'c1', role: 'event', content: '尾部记忆', agent_id: 'system', timestamp: 1100, contextContent: '体', source: { kind: 'memory-snapshot' }, anchor: 'a1' } as never,
    ]);
    const owner = turns.find((t) => t.agent_id === 'a')!;
    expect(owner.injects?.length).toBe(1);
    expect(owner.injects?.[0].afterStep).toBe(1); // 轮尾（1 步后）
  });

  it('锚目标被窗口边界切掉 → 剥锚走位置启发（挂窗口内下一 agent 轮头）', () => {
    const turns = buildTurns([
      { id: 'c1', role: 'event', content: '陈旧卡', agent_id: 'system', timestamp: 1100, contextContent: '体', source: { kind: 'memory-snapshot' }, anchor: 'gone' } as never,
      histMsg({ id: 's1', role: 'agent', content: '', thinking: '想', agent_id: 'a', persistedMsgId: 'a9', timestamp: 2000, toolCalls: [] }),
    ]);
    const owner = turns.find((t) => t.agent_id === 'a')!;
    expect(owner.injects?.length).toBe(1);
    expect(owner.injects?.[0].afterStep).toBe(0);
    expect(owner.injects?.[0].anchor).toBeUndefined(); // 剥锚
  });

  it('窗口内无任何 agent 轮 → 降级 system 空轮（正确语义）', () => {
    const turns = buildTurns([
      { id: 'c1', role: 'event', content: '无轮卡', agent_id: 'system', timestamp: 1100, contextContent: '体', source: { kind: 'memory-snapshot' }, anchor: 'gone' } as never,
    ]);
    const deg = turns.find((t) => t.agent_id === 'system' && (t.injects?.length ?? 0) > 0);
    expect(deg).toBeDefined();
  });
});

describe('渲染契约切片 A（cr-1109：注册声明优先）', () => {
  it('已注册专用卡的词 → 无数据面也卡片化(声明压倒启发式);未注册裸 event 维持分隔符', () => {
    const off = registerInjectCardView('ac-test:notice', { template: '<div/>' } as never);
    try {
      // 消息流:注册词 event 行(无 contextContent/bytes/payload) + 裸 event 行
      const msgs = [
        { id: 'a', role: 'event', content: '声明词标题', timestamp: 1, source: { kind: 'ac-test:notice' } },
        { id: 'b', role: 'event', content: '裸机制通知', timestamp: 2, source: { kind: 'event' } },
      ] as never;
      const turns = buildTurns(msgs, false);
      // 注册词 → 挂轮注入卡(降级独立卡——无在场轮),不是分隔符轮
      const sep = turns.filter((t) => (t.final as { role?: string } | null | undefined)?.role === 'event');
      const sepTexts = sep.map((t) => (t.final as { content?: string } | null | undefined)?.content ?? '');
      expect(sepTexts).toContain('裸机制通知');
      expect(sepTexts).not.toContain('声明词标题');
    } finally {
      off();
    }
  });
});
