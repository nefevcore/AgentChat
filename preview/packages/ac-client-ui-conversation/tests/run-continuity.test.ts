// ============================================================
// run-continuity.test.ts —— cr-699 run 内连续性拆轮豁免
//
// 中断-续跑的长程 run：中途收束总结步（纯正文：无思考无工具、同 sender
// 后续还有步）此前被 solo 规则拆成独立卡——链断三段。同 run 相邻消息
// （runId 相等）豁免 solo / plainAfterComplete / gapTooLong 拆轮，run
// 恒为一条思考链；跨 run / 无 run 键（直播/旧数据）维持原规则。
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildTurns } from 'ac-client-ui-conversation/client/feed.ts';
import type { ChatMessage } from 'ac-client-ui-conversation/client/types.ts';

function agentMsg(partial: Partial<ChatMessage> & { content: string }): ChatMessage {
  const { content, ...rest } = partial;
  return { id: 'm' + Math.random().toString(36).slice(2, 8), role: 'agent', content, timestamp: Date.now(), agent_id: 'alpha', ...rest } as ChatMessage;
}

describe('cr-699 run 内连续性豁免', () => {
  it('同 run 中途总结步不拆轮：一条思考链', () => {
    const run = 'run-send-1';
    const msgs: ChatMessage[] = [
      agentMsg({ content: '任务', agent_id: 'user' }),
      agentMsg({ content: '', thinking: '第一步推理', toolCalls: [{ id: 'c1', arguments: '{}', result: '' } as never], runId: run }),
      agentMsg({ content: '## 本轮收束' + String.fromCharCode(10) + '等你回答', runId: run }), // 中断总结步（纯正文 + 后续同 sender）
      agentMsg({ content: '', thinking: '续跑推理', toolCalls: [{ id: 'c2', arguments: '{}', result: '' } as never], runId: run }),
      agentMsg({ content: '最终正文', runId: run }), // 组尾平文（本就不 solo → final）
    ];
    const turns = buildTurns(msgs, false);
    // viewer 轮 + agent 单链（总结步留在链内，不独立成卡）
    expect(turns).toHaveLength(2);
    expect(turns[1].steps).toHaveLength(4); // 链含全部四条 agent 消息（展示层对与 final 同正文的步去重）
    expect(turns[1].final?.content).toBe('最终正文');
  });

  it('无 run 键（直播/旧数据）维持 solo 拆轮；跨 run 边界照拆', () => {
    const msgs: ChatMessage[] = [
      agentMsg({ content: '任务', agent_id: 'user' }),
      agentMsg({ content: '', thinking: '步', toolCalls: [{ id: 'c3', arguments: '{}', result: '' } as never] }),
      agentMsg({ content: '平文插行' }), // 无 runId → solo 独立成轮（保位渲染）
      agentMsg({ content: '', thinking: '后续步', toolCalls: [{ id: 'c4', arguments: '{}', result: '' } as never] }),
    ];
    const turns = buildTurns(msgs, false);
    expect(turns.length).toBeGreaterThanOrEqual(3); // 链 + 插行独立轮 + 后续步另起轮

    const cross: ChatMessage[] = [
      agentMsg({ content: '任务', agent_id: 'user' }),
      agentMsg({ content: 'run1 总结', runId: 'run-1' }),
      agentMsg({ content: 'run2 回复', runId: 'run-2' }), // 跨 run：sameRun 不适用
    ];
    const t2 = buildTurns(cross, false);
    expect(t2).toHaveLength(3); // viewer + run1 行 + run2 行（plainAfterComplete 拆）
  });

  it('同 run 步间长间隔（> MERGE_GAP_MS 10min）不拆链', () => {
    const run = 'run-long';
    const t0 = Date.parse('2026-10-25T14:00:00Z');
    const msgs: ChatMessage[] = [
      agentMsg({ content: '任务', agent_id: 'user', timestamp: t0 }),
      agentMsg({ content: '', thinking: '快步', toolCalls: [{ id: 'c5', arguments: '{}', result: '' } as never], runId: run, timestamp: t0 }),
      agentMsg({ content: '', thinking: '慢工具后的步', toolCalls: [{ id: 'c6', arguments: '{}', result: '' } as never], runId: run, timestamp: t0 + 40 * 60_000 }),
    ];
    const turns = buildTurns(msgs, false);
    expect(turns).toHaveLength(2); // viewer + 单链（40 分钟间隔不拆）
    expect(turns[1].steps).toHaveLength(2);
  });
});
