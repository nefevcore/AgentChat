// ============================================================
// feed-elapsed-calib.test.ts —— 链栏耗时校准链路验证（2026-12 计时反馈）
// 前端计时 + 后端耗时覆盖续计：after-step 写入 runCalibMs/runCalibAt 驻留
// 消息 → buildTurns 汇入 turn.steps[].assistant → chainLabel 消费。
// 覆盖纯函数面（透传不丢）；帧驱动写入面由 after-step 处理逻辑保障。
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildTurns } from 'ac-client-ui-conversation/client/feed.ts';

describe('链栏耗时校准：消息 → turn.steps[].assistant 透传', () => {
  it('runCalibMs/runCalibAt 在场 → 透传到 assistant（chainLabel 数据源）', () => {
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const turns = buildTurns([
      { id: 'u1', role: 'user', content: 'q', timestamp: t0, agent_id: 'user' },
      {
        id: 'a1', role: 'agent', content: '', thinking: '想', timestamp: t0 + 1000, agent_id: 'a',
        isStreaming: true,
        runCalibMs: 12_000, runCalibAt: t0 + 13_000,
      },
    ] as any, true);
    const t = turns.find((x) => x.agent_id === 'a');
    expect(t).toBeTruthy();
    const asst = (t!.steps[0] as any).assistant;
    expect(asst.runCalibMs).toBe(12_000);
    expect(asst.runCalibAt).toBe(t0 + 13_000);
  });

  it('校准缺席（历史回放/首步未收束）→ 字段不出现，chainLabel 回落时间戳推导', () => {
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const turns = buildTurns([
      { id: 'u1', role: 'user', content: 'q', timestamp: t0, agent_id: 'user' },
      {
        id: 'a1', role: 'agent', content: '答', thinking: '想', timestamp: t0 + 1000, agent_id: 'a',
      },
    ] as any, false);
    const t = turns.find((x) => x.agent_id === 'a');
    const asst = (t!.steps[0] as any).assistant;
    expect(asst.runCalibMs).toBeUndefined();
    expect(asst.runCalibAt).toBeUndefined();
  });

  it('reasoningStartAt 驻留（思考中实时计时的同源起点）→ 透传不丢', () => {
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const turns = buildTurns([
      { id: 'u1', role: 'user', content: 'q', timestamp: t0, agent_id: 'user' },
      {
        id: 'a1', role: 'agent', content: '', thinking: '想', timestamp: t0 + 1000, agent_id: 'a',
        isStreaming: true, reasoningStartAt: t0 + 1200,
      },
    ] as any, true);
    const t = turns.find((x) => x.agent_id === 'a');
    const asst = (t!.steps[0] as any).assistant;
    expect(asst.reasoningStartAt).toBe(t0 + 1200);
  });
});

describe('run 起点独立（每轮 run 独立计时——多轮会话不串轮）', () => {
  it('runStartAt（run-started 驻留）→ 透传到 turn.steps[].assistant——过渡期计时源', () => {
    const t0 = Date.parse('2026-01-01T00:10:00Z');
    const turns = buildTurns([
      { id: 'u1', role: 'user', content: '第一轮', timestamp: t0 - 600_000, agent_id: 'user' },
      { id: 'a0', role: 'agent', content: '第一轮答', timestamp: t0 - 590_000, agent_id: 'a' },
      { id: 'u2', role: 'user', content: '第二轮', timestamp: t0, agent_id: 'user' },
      {
        id: 'a1', role: 'agent', content: '', thinking: '想', timestamp: t0 + 1000, agent_id: 'a',
        isStreaming: true, runStartAt: t0 + 500,
      },
    ] as any, true);
    const t = turns.find((x) => x.agent_id === 'a' && (x.steps[0] as any)?.assistant?.runStartAt !== undefined);
    expect(t).toBeTruthy();
    // runStartAt = 本轮 run 起点（t0+500），而非会话首条 agent 消息（t0-590_000）
    expect((t!.steps[0] as any).assistant.runStartAt).toBe(t0 + 500);
  });

  it('校准锚是 run 级差分——与早前轮次消息的时间戳无关', () => {
    // 场景：第二轮 run 的首步校准。分区 run 状态（runStartAt = 本轮起点）
    // 由 feed-core after-step 处理器维护：calibMs = Date.now() - runStartAt，
    // 后续步 = 前锚 + (step.ts - prevStep.ts)。此处验证派生面：带锚消息不
    // 论会话内有多少早前轮次，锚值原样透传（不被时间戳推导污染）。
    const t0 = Date.parse('2026-01-01T00:10:00Z');
    const turns = buildTurns([
      { id: 'u1', role: 'user', content: 'q1', timestamp: t0 - 3_600_000, agent_id: 'user' },
      { id: 'a0', role: 'agent', content: '早一小时的第一轮', timestamp: t0 - 3_500_000, agent_id: 'a' },
      { id: 'u2', role: 'user', content: 'q2', timestamp: t0, agent_id: 'user' },
      {
        id: 'a1', role: 'agent', content: '', thinking: '想', timestamp: t0 + 1000, agent_id: 'a',
        isStreaming: true,
        runCalibMs: 8_000, runCalibAt: t0 + 8_500, // ← 后端锚：8s（与早前轮无关）
      },
    ] as any, true);
    const t = turns.find((x) => x.agent_id === 'a' && (x.steps[0] as any)?.assistant?.runCalibMs !== undefined);
    expect((t!.steps[0] as any).assistant.runCalibMs).toBe(8_000);
  });
});