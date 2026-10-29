// ============================================================
// inject-position.test.ts —— 注入行落位（cr-707 双面回归）
//
// 用户实测两症状：
//   ① 直播：注入卡「会挂到倒数第二」——首屏合并把直播行整体押在历史块
//      之后（mergeTimeOrdered 修）；
//   ② 刷新：「已发起提问 / 已收到用户回答」整条消失——宿主读面此前不过
//      滤式投影注入行（context 行 → 注入卡，落回真序位；直播行与刷新行
//      按 injectionId 同锚去重）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { mergeTimeOrdered, mergeHistoryPage, buildTurns } from 'ac-client-ui-conversation/client/feed.ts';
import { toHistoryMessages } from 'ac-client-ui-conversation/client/historyApi.ts';

/** 直播步消息（与 showEventNotice/step 占位同形的内部形态） */
const step = (id: string, ts: number, thinking = '思考') => ({
  id, role: 'agent', content: '', thinking, agent_id: 'a', timestamp: ts, toolCalls: [],
} as never);

/** 直播注入行（showEventNotice 产物：persistedMsgId = injectionId 锚） */
const liveInject = (anchor: string, ts: number) => ({
  id: anchor, role: 'event', content: '已收到用户回答', agent_id: 'system', timestamp: ts,
  persistedMsgId: anchor, source: { kind: 'durable-interaction' },
} as never);

describe('mergeTimeOrdered：首屏合并按时间序（直播注入行不再被顶到末尾）', () => {
  it('直播尾里的注入行（ts 居中）仍落在历史块中间——不在尾部', () => {
    // 历史块：注入发生前的两步（后端 ts）
    const history = [step('h1', 1000), step('h2', 2000)] as never[];
    // 直播尾：注入行（到达时刻 2500）+ 续跑占位（3500）
    const live = [liveInject('inj-1', 2500), step('s3', 3500)] as never[];
    const merged = mergeTimeOrdered(history, live);
    expect(merged.map((m) => m.id)).toEqual(['h1', 'h2', 'inj-1', 's3']);
    // 注入卡现挂在注入时刻的步界（2 步之后），而非倒数第一/第二
    const turns = buildTurns(merged);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.injects?.[0]).toMatchObject({ afterStep: 2 });
  });

  it('同 ts 保持「历史在前、直播在后」；任一侧为空直通', () => {
    const a = [step('h1', 1000)] as never[];
    const b = [step('l1', 1000)] as never[];
    expect(mergeTimeOrdered(a, b).map((m) => m.id)).toEqual(['h1', 'l1']);
    expect(mergeTimeOrdered(a, [])).toBe(a);
  });
});

describe('刷新回放：context 行 → 注入卡（真序位 + label 直出）', () => {
  const rows = [
    {
      role: 'assistant', content: '', agent_id: 'a', message_id: 'reply-1', run: 'run-1',
      timestamp: new Date(5000).toISOString(),
      steps: [
        { content: '', reasoning: '思考', ts: 1000 },
        { content: '', reasoning: '思考', ts: 2000 },
        { content: '', reasoning: '思考', ts: 4000 },
      ],
    },
    {
      role: 'context', content: '[系统通知] 你此前发起的提问已收到用户回答：…', label: '已收到用户回答',
      source: 'durable-interaction', agent_id: 'a', message_id: 'inj-1',
      timestamp: new Date(3000).toISOString(),
    },
  ];

  it('按 ts 落回段行之间（afterStep=注入前步数），标题 = label、展开体 = 正文', () => {
    const msgs = toHistoryMessages(rows as never, 'a~user');
    const turns = buildTurns(msgs as never);
    const card = turns.flatMap((t) => t.injects ?? [])[0]!;
    expect(card).toMatchObject({ label: '已收到用户回答', afterStep: 2 });
    expect(card.content).toContain('已收到用户回答');
  });

  it('直播行与刷新行同锚（injectionId）→ 双键去重只留一份', () => {
    const hist = toHistoryMessages(rows as never, 'a~user')
      .filter((m) => m.role === 'event')
      .map((m) => ({ ...m, id: 'inj-1', persistedMsgId: 'inj-1' })) as never[];
    const live = [liveInject('inj-1', 3000)] as never[];
    const { merged } = mergeHistoryPage(hist, live, false);
    expect(merged.filter((m) => m.role === 'event')).toHaveLength(1);
  });
});
