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

  it('键缺席走启发：探针 turn-gap-fallback 计数（双写观察窗）', () => {
    resetFallbackProbes();
    const msgs: ChatMessage[] = [
      agentMsg({ content: '任务', agent_id: 'user' }), // 无键
      agentMsg({ content: '答', runId: 'run-1' }), // 无键（直播行形态）
    ];
    buildTurns(msgs, false);
    expect(readFallbackProbes()['turn-gap-fallback']).toEqual({ hits: 2, rows: 2 }); // 两行均无键——每行各记一次（cr-1299 双指标）
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

describe('P4-1 键/启发对拍（双写合并——键修正面即行为提升面）', () => {
  it('键同值并轮 ⊇ 启发并轮域（等值输入下键恒不新增拆轮）', () => {
    // 同 run 40 分钟间隔：启发（sameRun 豁免）= 键（同值并轮）——等价；
    // 无 run 键长间隔：启发 gapTooLong 拆轮，键同值并轮——键修正（窗口
    // 局部假边界消除——P4-1 验证目标「跨窗口恒同」的直接体现）。
    const t0 = Date.parse('2026-10-25T14:00:00Z');
    const noKey: ChatMessage[] = [
      agentMsg({ content: '', thinking: '步一', toolCalls: [{ id: 'c1', arguments: '{}', result: '' } as never], timestamp: t0 }),
      agentMsg({ content: '', thinking: '步二', toolCalls: [{ id: 'c2', arguments: '{}', result: '' } as never], timestamp: t0 + 40 * 60_000 }),
    ];
    const heuristic = buildTurns(noKey, false);
    expect(heuristic).toHaveLength(2); // gapTooLong 拆轮（存量兜底语义保持）
    const keyed = buildTurns(noKey.map((m) => ({ ...m, turnId: 'run-x' })), false);
    expect(keyed).toHaveLength(1); // 键同值恒并轮——同一事实流跨窗口不再假拆
  });

  it('键异值拆轮 ⊇ 启发拆轮域（边界行缺席场景键修正：runCut 需双方 runId，键恒拆）', () => {
    // 启发域：run1 终稿（纯正文、无 run 键）+ run2 步——runCut 须双方
    // runId 在场才拆，此输入下启发并轮（终稿被吞——01a1ba12 形态）。
    // 键域异值恒拆。键修正 = 投影分组的行为提升面（§一 1.2 #1/#2）。
    const heuristicIn: ChatMessage[] = [
      agentMsg({ content: 'run1 终稿', runId: 'run-1' }),
      agentMsg({ content: 'run2 插行平文', runId: 'run-2' }), // 异 run 平文——启发 plainAfterComplete 拆（既有）
    ];
    const heuristic = buildTurns(heuristicIn, false);
    expect(heuristic).toHaveLength(2); // 启发拆轮（双方 runId 在场 runCut 触发）
    const keyed = buildTurns(heuristicIn.map((m) => ({ ...m, turnId: m.runId })), false);
    expect(keyed).toHaveLength(2); // 键异值同判拆轮——键域不削弱既有拆轮
    // 键修正面（01a1ba12）：终稿行无 run 键（投影 turnId 仍可到场——投影侧
    // run 承载行恒有键）——键域异值恒拆 vs 启发并轮（终稿被吞形态）：
    const swallowed: ChatMessage[] = [
      agentMsg({ content: 'run1 终稿', turnId: 'run-1' }),
      agentMsg({ content: '', thinking: 'run2 步', toolCalls: [{ id: 'c3', arguments: '{}', result: '' } as never], turnId: 'run-2' }),
    ];
    expect(buildTurns(swallowed, false)).toHaveLength(2); // 键异值恒拆——终稿不再被吞
  });
});

