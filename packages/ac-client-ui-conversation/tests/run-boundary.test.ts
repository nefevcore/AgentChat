// ============================================================
// run-boundary.test.ts —— cr-946：轮边界与链体承载（会话投影顺序回归锁）
//
// 现场（会话 01a1ba12）：壳重启「已重启」通知按入站 user 行落账 → viewer
// 投影对它恒盲 → 相邻两个 run 之间没有边界行 → buildTurns 把两段 run 并成
// 同一「轮」：前一段 run 的终稿降级成链内中间步，被「中间口述不进链」的
// 呈现规则整段吞掉（截图里「你说得对——复盘…」凭空消失）。
//
// 本文件锁三件事：
//   ① 已出终稿（末尾纯正文、无工具）且 run 切换 → 必拆轮（各自有 final）；
//   ② 同 run 内不拆（cr-699 豁免不退）；
//   ③ 链体承载 = 活动步 + 纯正文中间步（chainSteps），纯正文轮不建链；
//   ④ textBeforeTools 随历史行透传（步内「正文 / 工具卡」相对序）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { toHistoryMessages } from '../client/historyApi.ts';
import { buildTurns, chainSteps, historyRowToChatMessage, type HistoryRow } from '../client/feed.ts';

/** 历史行（toHistoryMessages 输出）→ buildTurns 消费的 ChatMessage 形。
 *  cr-1283 转换器并轨：本地小转换器退役，走 historyRowToChatMessage 单源。 */
function toChat(rows: HistoryRow[]) {
  return rows.map((m) => historyRowToChatMessage(m));
}

const t = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

describe('cr-946 ① run 切换即轮边界（已出终稿的纯正文步之后）', () => {
  it('两段 run 无边界行：前一段终稿仍是独立轮的 final（不被并链吞掉）', () => {
    const rows = toHistoryMessages([
      { role: 'user', content: '问', message_id: 'u1', timestamp: t(0) },
      {
        role: 'agent', content: '', message_id: 'r1', run: 'run-a', turnId: 'run-a', timestamp: t(1), agent_id: 'a',
        steps: [
          { content: '先说明一下：', reasoning: '想', reasoningMs: 3000, ts: Date.parse(t(2)), toolCalls: [{ id: 'c1', name: 'run_code', arguments: '{}', result: 'ok' }] },
          { content: '你说得对——复盘一下这个失误', ts: Date.parse(t(3)) },
        ],
      },
      {
        role: 'agent', content: '', message_id: 'r2', run: 'run-b', turnId: 'run-b', timestamp: t(4), agent_id: 'a',
        steps: [
          { content: '继续验证：', reasoning: '又想', reasoningMs: 4000, ts: Date.parse(t(5)), toolCalls: [{ id: 'c2', name: 'grep', arguments: '{}', result: 'ok' }] },
          { content: '验证完成', ts: Date.parse(t(6)) },
        ],
      },
    ], 'a~user');
    const turns = buildTurns(toChat(rows) as never);
    // user 轮 + 两段 agent 轮（此前两段 agent 轮并成一轮）
    expect(turns).toHaveLength(3);
    expect(turns[1].final?.content).toBe('你说得对——复盘一下这个失误');
    expect(turns[2].final?.content).toBe('验证完成');
  });

  it('同 run 连续步不拆（cr-699 豁免）：run 键相同 → 仍是一轮一链', () => {
    const rows = toHistoryMessages([
      { role: 'user', content: '问', message_id: 'u1', timestamp: t(0) },
      {
        role: 'agent', content: '', message_id: 'r1', run: 'run-a', timestamp: t(1), agent_id: 'a',
        steps: [
          { content: '中间总结', reasoning: '想', reasoningMs: 2000, ts: Date.parse(t(2)), toolCalls: [{ id: 'c0', name: 'grep', arguments: '{}', result: 'ok' }] },
          { content: '再干一步', reasoning: '想', reasoningMs: 3000, ts: Date.parse(t(3)), toolCalls: [{ id: 'c1', name: 'read', arguments: '{}', result: 'ok' }] },
          { content: '终稿', ts: Date.parse(t(4)) },
        ],
      },
    ], 'a~user');
    const turns = buildTurns(toChat(rows) as never);
    expect(turns).toHaveLength(2);
    expect(turns[1].steps.length).toBe(3);
    expect(turns[1].final?.content).toBe('终稿');
  });
});

describe('cr-946 ② 链体承载纯正文中间步', () => {
  /** 直接构造 TurnStep（buildTurns 的拆轮判据与本节无关——只验承载规则） */
  const step = (content: string, opts: { id?: string; thinking?: string; tools?: number } = {}) => ({
    assistant: {
      id: opts.id ?? 'step', role: 'agent' as const, content,
      thinking: opts.thinking ?? '', reasoning_content: opts.thinking ?? '', timestamp: 1,
    },
    tools: Array.from({ length: opts.tools ?? 0 }, (_, i) => ({ id: 'tool-' + i, role: 'tool' as const, content: '', timestamp: 1 })),
    isStreaming: false,
  });

  it('本轮有活动 → 纯正文中间步入链（此前被整段吞掉）', () => {
    const chain = chainSteps([
      step('', { id: 's0', tools: 1 }),
      step('前一段终稿', { id: 's1' }),
      step('', { id: 's2', tools: 1 }),
    ] as never);
    expect(chain.map((s) => s.assistant.id)).toEqual(['s0', 's1', 's2']);
  });

  it('纯正文轮 → 不建链（走 final 气泡，旧路径不变）', () => {
    const turns = buildTurns([{ id: 'a1', role: 'agent', agent_id: 'a', content: '一句回答', timestamp: 1 } as never]);
    expect(turns).toHaveLength(1);
    expect(chainSteps(turns[0].steps)).toEqual([]);
    expect(turns[0].final?.content).toBe('一句回答');
  });

  it('只有活动步 → 链体与旧行为一致', () => {
    const st = step('', { id: 'act', thinking: '思考' });
    expect(chainSteps([st as never]).map((s) => s.assistant.id)).toEqual(['act']);
  });
});

describe('cr-946 ③ textBeforeTools 历史透传（步内正文/工具卡相对序）', () => {
  it('落盘步带 textBeforeTools → 历史行 → buildTurns 步上仍在（缺省则丢序）', () => {
    const rows = toHistoryMessages([
      {
        role: 'agent', content: '', message_id: 'r1', run: 'run-a', timestamp: t(1), agent_id: 'a',
        steps: [
          { content: '先口述再调工具：', textBeforeTools: true, ts: Date.parse(t(2)), toolCalls: [{ id: 'c1', name: 'run_code', arguments: '{}', result: 'ok' }] },
          { content: '工具先行', textBeforeTools: false, ts: Date.parse(t(3)), toolCalls: [{ id: 'c2', name: 'grep', arguments: '{}', result: 'ok' }] },
        ],
      },
    ], 'a~user');
    const turns = buildTurns(toChat(rows) as never);
    expect(turns[0].steps[0].assistant.textBeforeTools).toBe(true);
    expect(turns[0].steps[1].assistant.textBeforeTools).toBe(false);
  });
});
