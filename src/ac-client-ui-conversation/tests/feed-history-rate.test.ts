// ============================================================
// feed-history-rate.test.ts —— 速率数据持久化链路验证
// 落盘步记录（elapsedMs/usage）→ toHistoryMessages 展开 → buildTurns
// 分组 → TurnDisplayItem chainLabel 消费：切走再切回（历史回放）后
// apiMs/apiCompletion 不丢、速率可算（与直播同源）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { toHistoryMessages } from 'ac-client-ui-conversation/client/historyApi.ts';
import { buildTurns } from 'ac-client-ui-conversation/client/feed.ts';

describe('速率持久化：历史回放链路（切走再切回）', () => {
  it('toHistoryMessages：steps[] 携带 elapsedMs/usage → 展开 agent 气泡带 apiMs/apiCompletion', () => {
    const rows = toHistoryMessages([
      { role: 'user', content: 'q', message_id: 'm1', timestamp: '2026-01-01T00:00:01Z' },
      {
        role: 'agent', content: '', message_id: 'm2', timestamp: '2026-01-01T00:00:02Z', agent_id: 'a',
        steps: [
          {
            content: '', reasoning: '想一下', reasoningMs: 1500,
            elapsedMs: 2000, usage: { prompt: 100, completion: 60, total: 160 },
            toolCalls: [{ id: 't1', name: 'bash', arguments: '{}', result: 'ok' }],
          },
          {
            content: '答', reasoning: '',
            elapsedMs: 3000, usage: { prompt: 200, completion: 90, total: 290 },
          },
        ],
      },
    ], 'a~user');
    const agentSteps = rows.filter((r) => r.role === 'agent');
    expect(agentSteps.length).toBeGreaterThanOrEqual(2);
    // 两步的 api 数据都在场（成对：completion 口径）
    expect(agentSteps.filter((m: any) => m.apiMs === 2000 && m.apiCompletion === 60)).toHaveLength(1);
    expect(agentSteps.filter((m: any) => m.apiMs === 3000 && m.apiCompletion === 90)).toHaveLength(1);
  });

  it('buildTurns：apiMs/apiCompletion 汇入 turn.steps[].assistant——chainLabel 数据源不丢', () => {
    const rows = toHistoryMessages([
      { role: 'user', content: 'q', message_id: 'm1', timestamp: '2026-01-01T00:00:01Z' },
      {
        role: 'agent', content: '', message_id: 'm2', timestamp: '2026-01-01T00:00:02Z', agent_id: 'a',
        steps: [
          {
            content: '', reasoning: '想', reasoningMs: 1500,
            elapsedMs: 2000, usage: { prompt: 100, completion: 60, total: 160 },
            toolCalls: [{ id: 't1', name: 'bash', arguments: '{}', result: 'ok' }],
          },
          { content: '答', elapsedMs: 3000, usage: { prompt: 200, completion: 90, total: 290 } },
        ],
      },
    ], 'a~user');
    const turns = buildTurns(rows as any, false);
    const t = turns.find((x) => x.agent_id === 'a');
    expect(t).toBeTruthy();
    const withRate = (t!.steps as any[]).filter((s) => typeof s.assistant.apiMs === 'number');
    expect(withRate).toHaveLength(2);
    // Σcompletion/Σms = 150/5 = 30 t/s（chainLabel 同款算法）
    const apiMs = withRate.reduce((s, x) => s + x.assistant.apiMs, 0);
    const apiCompletion = withRate.reduce((s, x) => s + x.assistant.apiCompletion, 0);
    expect(apiMs).toBe(5000);
    expect(apiCompletion).toBe(150);
    expect((apiCompletion / (apiMs / 1000)).toFixed(1)).toBe('30.0');
  });

  it('旧数据（无 elapsedMs/usage）→ 字段缺席，速率段省略（不显示）', () => {
    const rows = toHistoryMessages([
      { role: 'user', content: 'q', message_id: 'm1', timestamp: '2026-01-01T00:00:01Z' },
      {
        role: 'agent', content: '旧回复', message_id: 'm2', timestamp: '2026-01-01T00:00:02Z', agent_id: 'a',
        steps: [{ content: '旧回复', reasoning: '' }],
      },
    ], 'a~user');
    const turns = buildTurns(rows as any, false);
    const t = turns.find((x) => x.agent_id === 'a');
    const withRate = (t!.steps as any[]).filter((s) => typeof s.assistant.apiMs === 'number');
    expect(withRate).toHaveLength(0);
  });
});
