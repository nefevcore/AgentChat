// ============================================================
// inject-run-anchoring.test.ts —— P3-4 直播挂靠并轨（cr-1285）
//
// 验证目标（§四 P3-4）：注入卡挂靠三路径（刷新 / 直播 / 上翻）恒同。
// 双拍同形断言：同一注入事实——直播帧行（带 run 键）与刷新投影行
//（journal-inject 落账带 run）——经 buildTurns 产出恒同挂靠（轮 +
// afterStep）。旧后端帧（无 run 键）回落位置启发不回归。
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildTurns, historyRowToChatMessage } from 'ac-client-ui-conversation/client/feed.ts';
import { toHistoryMessages } from 'ac-client-ui-conversation/client/historyApi.ts';
import { readFallbackProbes, resetFallbackProbes } from 'ac-client-ui-conversation/client/fallback-probes.ts';

/** 直播注入行（showEventNotice 产物同形——cr-1285 起带 runId） */
const liveInj = (id: string, ts: number, runId?: string) => ({
  id, role: 'event', content: '已加载技能 demo', agent_id: 'system', timestamp: ts,
  source: { kind: 'skill' }, contextContent: '<system-reminder>技能正文</system-reminder>',
  ...(runId !== undefined ? { runId } : {}),
} as never);

/** agent 步行（历史展开形——带 runId/stepId） */
const step = (id: string, ts: number, runId: string, persistedMsgId: string) => ({
  id, role: 'agent', content: '', thinking: '想', agent_id: 'a', timestamp: ts,
  toolCalls: [], runId, stepId: runId + ':0', persistedMsgId,
} as never);

describe('P3-4 run 键挂靠：直播卡挂到归属 run 的轮（按键不猜）', () => {
  it('run 中途注入（帧行 run 键在场，卡在步1 与步2 之间）→ afterStep=1', () => {
    resetFallbackProbes();
    const turns = buildTurns([
      step('s1', 1000, 'run1', 'a1'),
      liveInj('c1', 1500, 'run1'),
      step('s2', 2000, 'run1', 'a1'),
    ]);
    expect(turns.length).toBe(1); // 不拆轮
    expect(turns[0].injects?.length).toBe(1);
    expect(turns[0].injects?.[0].afterStep).toBe(1); // 步1 后
    expect(turns[0].injects?.[0].runId).toBe('run1');
    expect(readFallbackProbes()['inject-run-miss']).toBeUndefined(); // 键命中不走兜底
  });

  it('注入先于 run 首步（卡到窗早于步）→ 延迟挂该 run 轮头（afterStep=0）', () => {
    const turns = buildTurns([
      { id: 'u1', role: 'user', content: '问', agent_id: 'user', timestamp: 500 } as never,
      liveInj('c1', 600, 'run1'),
      step('s1', 1000, 'run1', 'a1'),
      step('s2', 2000, 'run1', 'a1'),
    ]);
    const owner = turns.find(t => t.agent_id === 'a');
    expect(owner?.injects?.length).toBe(1);
    expect(owner?.injects?.[0].afterStep).toBe(0); // 轮头
  });

  it('归属 run 不在窗口（窗口边界态）→ 剥键走兜底 + 探针计数', () => {
    resetFallbackProbes();
    const turns = buildTurns([
      liveInj('c1', 1100, 'run-gone'), // 无同 run 步在窗
      step('s1', 2000, 'run9', 'a9'),
    ]);
    // 剥键后走位置启发：挂窗口内 agent 轮头
    const owner = turns.find(t => t.agent_id === 'a');
    expect(owner?.injects?.length).toBe(1);
    expect(owner?.injects?.[0].runId).toBeUndefined();
    expect(readFallbackProbes()['inject-run-miss']).toEqual({ hits: 1, rows: 1 });
  });

  it('旧后端帧（无 run 键）回落位置启发——行为不回归', () => {
    resetFallbackProbes();
    const turns = buildTurns([
      step('s1', 1000, 'run1', 'a1'),
      liveInj('c1', 1500), // 无 run 键
      step('s2', 2000, 'run1', 'a1'),
    ]);
    expect(turns[0].injects?.[0].afterStep).toBe(1); // 位置启发原位
    expect(readFallbackProbes()['inject-run-miss']).toBeUndefined();
  });
});

describe('P3-4 双拍同形：直播行与刷新投影行恒同挂靠', () => {
  // 同一注入事实两形态：
  //   直播 = session/context-injected 帧行（run 键 + agent_id=system）
  //   刷新 = journal-inject 投影行（run 归口 + ts 恢复落盘位）
  it('run 中途注入：直播 afterStep == 刷新 afterStep', () => {
    // 直播拍：帧行插在步1 与步2 之间（append 序 = 落盘序）
    const liveTurns = buildTurns([
      step('s1', 1000, 'run1', 'a1'),
      liveInj('c1', 1500, 'run1'),
      step('s2', 2000, 'run1', 'a1'),
    ]);
    // 刷新拍：投影行（fold projectInject 产物形——run 键 + 时间全序落位）。
    // steps[].ts = epoch ms，与行 timestamp 同基准（Date.UTC(2026,0,1) 起）——
    // 卡 ts 落在步1 与步2 之间（还原落盘位，与直播拍同事实）
    const T0 = Date.UTC(2026, 0, 1);
    const rows = [
      { role: 'user', content: '问', agent_id: 'user', message_id: 'u1', timestamp: '2026-01-01T00:00:00.500Z' },
      {
        role: 'agent', content: '', agent_id: 'a', message_id: 'm1', run: 'run1', timestamp: '2026-01-01T00:00:02Z',
        steps: [
          { content: '', reasoning: '想', stepId: 'run1:0', ts: T0 + 1000 },
          { content: '终', stepId: 'run1:1', ts: T0 + 2000 },
        ],
      },
      { role: 'context', content: '<system-reminder>技能正文</system-reminder>', source: 'skill', label: '已加载技能 demo', agent_id: 'a', message_id: 'inj-1', timestamp: '2026-01-01T00:00:01.500Z', run: 'run1' },
    ];
    const histTurns = buildTurns(toHistoryMessages(rows as never, 'a~user').map(r => historyRowToChatMessage(r)));
    // 双拍挂靠恒同：同轮 + 同 afterStep
    const liveOwner = liveTurns.find(t => t.agent_id === 'a');
    const histOwner = histTurns.find(t => t.agent_id === 'a');
    expect(liveOwner?.injects?.length).toBe(1);
    expect(histOwner?.injects?.length).toBe(1);
    expect(liveOwner?.injects?.[0].afterStep).toBe(histOwner?.injects?.[0].afterStep);
  });
});
