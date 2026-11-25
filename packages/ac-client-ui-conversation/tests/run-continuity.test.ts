// ============================================================
// run-continuity.test.ts —— 键缺席域退化行为锁（cr-1321 判据退役后）
//
// sameRun / solo / plainAfterComplete / gapTooLong 判据族已物理删除（冗余
// 性证明：cr-1320 全数据根对拍 + 直播窗归零）。键缺席域（v0 旧写面存量）
// 退化语义：同 sender 恒并轮、跨 sender 照拆——run 连续性与插行保位由键
// 控域承担（行行带键，见 turn-keyed-grouping / local-turn-key）。
// 历史背景：中断-续跑的长程 run：中途收束总结步（纯正文：无思考无工具、同 sender
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

  it('无 run 键：同 sender 恒并轮（键缺席域退化——插行并进链，无独立卡）', () => {
    const msgs: ChatMessage[] = [
      agentMsg({ content: '任务', agent_id: 'user' }),
      agentMsg({ content: '', thinking: '步', toolCalls: [{ id: 'c3', arguments: '{}', result: '' } as never] }),
      agentMsg({ content: '平文插行' }),
      agentMsg({ content: '', thinking: '后续步', toolCalls: [{ id: 'c4', arguments: '{}', result: '' } as never] }),
    ];
    const turns = buildTurns(msgs, false);
    // viewer 轮 + agent 单链（判据退役：同 sender 并轮，插行留链内）
    expect(turns).toHaveLength(2);
    expect(turns[1].steps).toHaveLength(3);

    const cross: ChatMessage[] = [
      agentMsg({ content: '任务', agent_id: 'user' }),
      agentMsg({ content: 'run1 总结', runId: 'run-1' }),
      agentMsg({ content: 'run2 回复', runId: 'run-2' }), // 跨 run：键缺席域不拆（带键则 keyedDiff 拆——见 turn-keyed-grouping）
    ];
    const t2 = buildTurns(cross, false);
    expect(t2).toHaveLength(2); // viewer + 并轮（键缺席退化形态）
  });

  it('同 run 步间长间隔（40 分钟）不拆链（间隔判据已删——恒并轮）', () => {
    const run = 'run-long';
    const t0 = Date.parse('2026-10-25T14:00:00Z');
    const msgs: ChatMessage[] = [
      agentMsg({ content: '任务', agent_id: 'user', timestamp: t0 }),
      agentMsg({ content: '', thinking: '快步', toolCalls: [{ id: 'c5', arguments: '{}', result: '' } as never], runId: run, timestamp: t0 }),
      agentMsg({ content: '', thinking: '慢工具后的步', toolCalls: [{ id: 'c6', arguments: '{}', result: '' } as never], runId: run, timestamp: t0 + 40 * 60_000 }),
    ];
    const turns = buildTurns(msgs, false);
    expect(turns).toHaveLength(2); // viewer + 单链
    expect(turns[1].steps).toHaveLength(2);
  });
});
