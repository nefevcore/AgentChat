// ============================================================
// turn-keyed-grouping.test.ts —— P4-1 投影分组键控拆轮（cr-1286）
//
// 验证目标（§四 P4-1）：直播 / 刷新 / 上翻三路径轮边界跨窗口恒同。
// 键域三态：双方在键域同值恒并轮 / 异值恒拆轮 / 缺席走启发（双写
// 过渡）。键控行与启发行为对拍（键到场的行分组结果 = 启发在该输入
// 上的既有语义或其键化修正——修正点即行为提升面，逐例锁定）
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildTurns, historyRowToChatMessage } from 'ac-client-ui-conversation/client/feed.ts';
import { toHistoryMessages } from 'ac-client-ui-conversation/client/historyApi.ts';
import type { ChatMessage } from 'ac-client-ui-conversation/client/types.ts';
import { readFallbackProbes, resetFallbackProbes } from 'ac-client-ui-conversation/client/fallback-probes.ts';

function agentMsg(p: Partial<ChatMessage> & { content: string }): ChatMessage {
  const { content, ...rest } = p;
  return { id: 'm' + Math.random().toString(36).slice(2, 8), role: 'agent', content, timestamp: Date.now(), agent_id: 'alpha', ...rest } as ChatMessage;
}

describe('P4-1 键控拆轮（buildTurns 键域三态）', () => {
  it('判据退役终态（cr-1321）：键全域夹具上轮边界 = 纯键控（judges 已物理删除的行为锁）', () => {
    // 键全夹具 = 主流域形态（M-C 迁移后存量 + B1a/B1b 直播行出生带键）：
    // 多 run / 用户插话轮 / 大间隔（原 gapTooLong 域）/ runCut / solo 各形态，
    // 冗余性已证（全数据根 1223 会话对拍恒等——cr-1320）后判据族删除。
    const t0 = Date.parse('2026-11-25T12:00:00Z');
    const msgs: ChatMessage[] = [
      agentMsg({ content: '问 1', agent_id: 'user', timestamp: t0, turnId: 'q1' }),
      agentMsg({ content: 'run1 步', runId: 'run-1', timestamp: t0, turnId: 'run-1' }),
      agentMsg({ content: 'run1 终稿', runId: 'run-1', timestamp: t0 + 60_000, turnId: 'run-1' }),
      agentMsg({ content: '问 2（间隔 30 分钟——键控下与间隔无关）', agent_id: 'user', timestamp: t0 + 30 * 60_000, turnId: 'q2' }),
      agentMsg({ content: 'run2 终稿（原 runCut 域——键异值拆）', runId: 'run-2', timestamp: t0 + 31 * 60_000, turnId: 'run-2' }),
      agentMsg({ content: 'run3 平文插行（原 solo 域）', runId: 'run-3', timestamp: t0 + 32 * 60_000, turnId: 'run-3' }),
      agentMsg({ content: 'run3 续', runId: 'run-3', timestamp: t0 + 33 * 60_000, turnId: 'run-3' }),
    ];
    const turns = buildTurns(msgs, false);
    // 结构语义锚：用户轮按 q 键拆、agent 链按 run 键拆（sender 与键控双判据）
    expect(turns.filter(t => t.agent_id === 'user')).toHaveLength(2);
    expect(turns.filter(t => t.agent_id === 'alpha')).toHaveLength(3);
    // 键序断言：轮 turnId 序列 = q1/run-1/q2/run-2/run-3（间隔与形态不参与）
    expect(turns.map(t => t.turnId)).toEqual(['q1', 'run-1', 'q2', 'run-2', 'run-3']);
  });

  it('同值键恒并轮：跨 10 分钟间隔/中途总结步不拆——键域优先于 MERGE_GAP_MS', () => {
    const t0 = Date.parse('2026-10-25T14:00:00Z');
    const run = 'run-long';
    const msgs: ChatMessage[] = [
      agentMsg({ content: '任务', agent_id: 'user', timestamp: t0, turnId: 'q1' }),
      agentMsg({ content: '', thinking: '快步', toolCalls: [{ id: 'c1', arguments: '{}', result: '' } as never], runId: run, timestamp: t0, turnId: run }),
      agentMsg({ content: '中途总结', runId: run, timestamp: t0 + 40 * 60_000, turnId: run }), // 40 分钟间隔
      agentMsg({ content: '最终', runId: run, timestamp: t0 + 80 * 60_000, turnId: run }),
    ];
    const turns = buildTurns(msgs, false);
    expect(turns).toHaveLength(2); // viewer 轮 + 单 agent 链（键同值——间隔不拆）
    expect(turns[1].steps).toHaveLength(3);
    expect(turns[1].turnId).toBe(run);
  });

  it('异值键恒拆轮：run 边界——run1 终稿后 run2 步必拆（键修正 runCut 边界行缺席场景）', () => {
    const msgs: ChatMessage[] = [
      agentMsg({ content: '任务', agent_id: 'user', turnId: 'q1' }),
      agentMsg({ content: 'run1 终稿', runId: 'run-1', turnId: 'run-1' }),
      agentMsg({ content: 'run2 回复', runId: 'run-2', turnId: 'run-2' }), // 键异值必拆——runCut 须双方 runId 在场才拆，此处双键恒拆
    ];
    const turns = buildTurns(msgs, false);
    expect(turns).toHaveLength(3);
    expect(turns[1].turnId).toBe('run-1');
    expect(turns[2].turnId).toBe('run-2');
  });

  it('键缺席（v0 旧写面存量形态）：按 sender 拆轮——无探针（cr-1321 判据退役后行为锁）', () => {
    resetFallbackProbes();
    const msgs: ChatMessage[] = [
      agentMsg({ content: '任务', agent_id: 'user' }), // 无键（sub_* v0 存量形态）
      agentMsg({ content: '答', runId: 'run-1' }), // 无键
      agentMsg({ content: '追问', agent_id: 'user' }), // 无键——sender 切换拆轮
    ];
    const turns = buildTurns(msgs, false);
    // sender 维度拆轮仍在（keyedBreak/cur.agent_id 判据）；键缺席不触发任何探针
    expect(turns.map(t => t.agent_id)).toEqual(['user', 'alpha', 'user']);
    expect(Object.keys(readFallbackProbes())).toEqual([]); // tgf 键已退役——探针面无任何计数
    resetFallbackProbes();
  });

  it('用户行键（message_id）与 run 键异值恒拆：多轮会话轮结构', () => {
    const msgs: ChatMessage[] = [
      agentMsg({ content: '问一', agent_id: 'user', turnId: 'q1' }),
      agentMsg({ content: '答一', runId: 'run-1', turnId: 'run-1' }),
      agentMsg({ content: '问二', agent_id: 'user', turnId: 'q2' }),
      agentMsg({ content: '答二', runId: 'run-2', turnId: 'run-2' }),
    ];
    const turns = buildTurns(msgs, false);
    expect(turns.map((t) => t.turnId)).toEqual(['q1', 'run-1', 'q2', 'run-2']);
  });
});

describe('P4-1 双拍同构（§四验证目标：刷新 vs 直播轮边界恒同）', () => {
  // 同一事实流：刷新路径 = 投影行（records 携带 turnId）经 toHistoryMessages
  // → historyRowToChatMessage → buildTurns；直播路径 = 等价无键行（帧不带
  // 投影词——双写期直播行 turnId 缺席）走启发。键到场 = 分组升级；
  // 启发域行为不回归（既有测试族全绿即证——此处锁定键路径轮边界）。 
  const records = [
    { role: 'user', content: '问', agent_id: 'user', message_id: 'u1', timestamp: '2026-01-01T00:00:01Z', seq: 1, turnId: 'u1' },
    {
      role: 'agent', content: '', message_id: 'm1', timestamp: '2026-01-01T00:00:02Z', agent_id: 'a', run: 'run1', seq: 2, turnId: 'run1',
      steps: [{
        content: '答', stepId: 'run1:0', reasoning: '想', textBeforeTools: true, ts: 1767225602000,
        toolCalls: [{ id: 't1', name: 'bash', arguments: '{}', result: 'ok' }],
      }],
    },
    { role: 'context', content: '<system-reminder>体</system-reminder>', source: 'skill', label: '已加载技能', agent_id: 'a', message_id: 'ctx-1', timestamp: '2026-01-01T00:00:03Z', seq: 3, anchor: 'm1' },
  ];

  it('刷新路径：投影行 turnId 贯通至 Turn（步行/终稿行/用户行同键并轮）', () => {
    const cm = toHistoryMessages(records as never, 'a~user').map((r) => historyRowToChatMessage(r));
    const turns = buildTurns(cm, false);
    expect(turns.map((t) => t.turnId)).toEqual(['u1', 'run1']);
    const owner = turns.find((t) => t.agent_id === 'a')!;
    expect(owner.steps).toHaveLength(1);
    expect(owner.injects?.[0].label).toBe('已加载技能'); // 键域不扰动注入挂靠（anchor 路径恒同）
  });

  it('上翻窗口截断：跨页同轮同键——键判据不依赖窗口内前邻（跨窗口恒同）', () => {
    // run1 两步行（分页边界从中间切）：尾窗 [step2, final]，前邻缺席
    const tailRecords = [
      {
        role: 'agent', content: '', message_id: 'm1', timestamp: '2026-01-01T00:00:03Z', agent_id: 'a', run: 'run1', seq: 2, turnId: 'run1',
        steps: [{
          content: '步二', stepId: 'run1:1', ts: 1767225603000,
        }],
      },
      { role: 'agent', content: '终稿', message_id: 'm1', timestamp: '2026-01-01T00:00:04Z', agent_id: 'a', run: 'run1', seq: 2, turnId: 'run1' },
    ];
    const cm = toHistoryMessages(tailRecords as never, 'a~user').map((r) => historyRowToChatMessage(r));
    const turns = buildTurns(cm, false);
    // 窗口内步行 + 终稿行同键并轮（启发域同样并轮——单 sender 连续；键域显式恒同）
    expect(turns).toHaveLength(1);
    expect(turns[0].turnId).toBe('run1');
    expect(turns[0].final?.content).toBe('终稿');
  });
});

describe('P4-1 键控终态（cr-1321 判据退役——键域行为锁）', () => {
  it('键同值恒并轮：无键域退化同 sender 并轮——键域显式跨窗口恒同', () => {
    // 同 run 40 分钟间隔（原 sameRun/gapTooLong 域）：键同值并轮。
    const t0 = Date.parse('2026-10-25T14:00:00Z');
    const noKey: ChatMessage[] = [
      agentMsg({ content: '', thinking: '步一', toolCalls: [{ id: 'c1', arguments: '{}', result: '' } as never], timestamp: t0 }),
      agentMsg({ content: '', thinking: '步二', toolCalls: [{ id: 'c2', arguments: '{}', result: '' } as never], timestamp: t0 + 40 * 60_000 }),
    ];
    const unkeyed = buildTurns(noKey, false);
    expect(unkeyed).toHaveLength(1); // 键缺席域退化：同 sender 并轮（间隔判据已删）
    const keyed = buildTurns(noKey.map((m) => ({ ...m, turnId: 'run-x' })), false);
    expect(keyed).toHaveLength(1); // 键同值恒并轮——同一事实流跨窗口不再假拆
  });

  it('键异值恒拆轮（原 runCut 域）：终稿行后异 run 步必拆——键域不削弱 run 边界', () => {
    const keyedIn: ChatMessage[] = [
      agentMsg({ content: 'run1 终稿', runId: 'run-1', turnId: 'run-1' }),
      agentMsg({ content: 'run2 插行平文', runId: 'run-2', turnId: 'run-2' }),
    ];
    const keyed = buildTurns(keyedIn, false);
    expect(keyed).toHaveLength(2); // 键异值拆轮——run 边界（原 runCut 语义由键承接）
    // 键修正面（01a1ba12 历史形态）：终稿行带键 + 异 run 步带键——恒拆不吞：
    const swallowed: ChatMessage[] = [
      agentMsg({ content: 'run1 终稿', turnId: 'run-1' }),
      agentMsg({ content: '', thinking: 'run2 步', toolCalls: [{ id: 'c3', arguments: '{}', result: '' } as never], turnId: 'run-2' }),
    ];
    expect(buildTurns(swallowed, false)).toHaveLength(2); // 键异值恒拆——终稿不再被吞
  });
});

