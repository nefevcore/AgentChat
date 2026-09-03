// ============================================================
// history-order.test.ts —— 历史渲染序回归（2026-09-02 反馈 #2）
//
// 背景 bug：收束行把整轮 run 折叠为单行 steps[]——run 中途的插行
// （send_agent 投递、机制通知）在磁盘上按事件序与步交错，但整块展开
// 后全部排到插行之后（渲染序 ≠ 落盘序：插行与整个 run 块错位）。
//
// 修复后不变量：
//   · toHistoryMessages：steps[].ts 在场时按步自身时刻展开 + 全列表
//     稳定时间排序——插行回到真实位置；
//   · buildTurns：平文消息落在同 sender 步骤之间（后续还有同 sender
//     消息）时拆轮保位——不被"思考过程"折叠链吞掉。
// ============================================================

import { describe, it, expect } from 'vitest';
import { toHistoryMessages } from '../src/api/runs.ts';
import { buildTurns } from '../src/utils/feed.ts';
import type { ChatMessage } from '../src/types';

const T0 = Date.parse('2026-09-02T01:06:27Z');

describe('toHistoryMessages 步级时序（收束行展开与中途插行同序）', () => {
  it('steps[].ts 在场：中途插行（投递消息/事件通知）按真实时刻回到步与步之间', () => {
    // 落盘形态（dedup 后）：user → [收束行 steps(ts 交错)]——中途插行在行间
    const rows = [
      { role: 'user', content: '测下工具', agent_id: 'user', message_id: 'm1', timestamp: new Date(T0).toISOString() },
      {
        role: 'agent', content: '最终汇报', agent_id: 'admin', message_id: 'm2',
        timestamp: new Date(T0 + 60_000).toISOString(),
        steps: [
          { content: '第一步', reasoning: '想想', ts: T0 + 2_000, toolCalls: [{ id: 'c1', name: 'list_tools', arguments: '{}', result: { ok: true } }] },
          { content: '第二步', reasoning: '再想', ts: T0 + 30_000, toolCalls: [] },
          { content: '最终汇报', reasoning: '', ts: T0 + 59_000, toolCalls: [] },
        ],
      },
      { role: 'agent', content: '【工具自测】send_agent 投递正常', agent_id: 'admin', message_id: 'm3', timestamp: new Date(T0 + 10_000).toISOString() },
      { role: 'event', content: '[系统通知] 后台任务 bash-1 完成', agent_id: 'admin', message_id: 'm4', timestamp: new Date(T0 + 40_000).toISOString() },
    ] as never;
    const out = toHistoryMessages(rows, 'admin~user');
    // 期望时间序：user → step1 → [插行 send_agent] → step2 → [事件] → step3
    const heads = out.map((m) => String(m.role === 'tool' ? m.name : (m.content ?? '')).slice(0, 12).trimEnd());
    expect(heads).toEqual([
      '测下工具',
      '第一步', 'list_tools',
      '【工具自测】send_a',
      '第二步',
      '[系统通知] 后台任务',
      '最终汇报',
    ]);
  });

  it('无 steps[].ts 的旧行：整块按行时刻排序（行为与此前一致，不炸）', () => {
    const rows = [
      { role: 'user', content: '问', agent_id: 'user', message_id: 'm1', timestamp: new Date(T0).toISOString() },
      {
        role: 'agent', content: '答', agent_id: 'admin', message_id: 'm2',
        timestamp: new Date(T0 + 5_000).toISOString(),
        steps: [
          { content: '步一', reasoning: '', toolCalls: [] },
          { content: '答', reasoning: '', toolCalls: [] },
        ],
      },
    ] as never;
    const out = toHistoryMessages(rows, 'admin~user');
    expect(out.map((m) => m.role)).toEqual(['agent', 'agent', 'agent']);
    expect(out[1]).toMatchObject({ content: '步一' });
  });
});

describe('buildTurns 平文中段拆轮（插行不被折叠链吞掉）', () => {
  const A = 'admin';
  const mk = (over: Partial<ChatMessage>): ChatMessage =>
    ({ id: Math.random().toString(36).slice(2), role: 'agent', content: '', timestamp: T0, agent_id: A, ...over } as ChatMessage);

  it('平文落在同 sender 工具步之间（后续还有步）→ 拆轮：插行独立气泡、后续步骤另起一轮', () => {
    const msgs = [
      mk({ role: 'agent', agent_id: 'user', content: '测下工具' }),
      mk({ content: '第一步', reasoning: '想想', toolCalls: [{ id: 'c1', name: 'list_tools', arguments: '{}' } as never] }),
      mk({ content: '【工具自测】投递正常' }), // 平文插行（无 thinking/工具）
      mk({ content: '第二步', reasoning: '再想', toolCalls: [{ id: 'c2', name: 'bash', arguments: '{}' } as never] }),
      mk({ content: '最终汇报' }), // 组尾平文 → final，不拆
    ];
    const turns = buildTurns(msgs);
    // user 轮 + [admin 步1] + [admin 插行] + [admin 步2 + final] = 4 轮
    expect(turns).toHaveLength(4);
    expect(turns[1]!.steps).toHaveLength(1);
    expect(turns[2]!.final?.content).toBe('【工具自测】投递正常');
    expect(turns[3]!.steps).toHaveLength(2); // 步2 + 终稿（final = 末条）
    expect(turns[3]!.final?.content).toBe('最终汇报');
  });

  it('组尾平文（后续无同 sender 消息）不拆轮——仍作该轮 final', () => {
    const msgs = [
      mk({ role: 'agent', agent_id: 'user', content: '问' }),
      mk({ content: '', reasoning: '思考', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' } as never] }),
      mk({ content: '最终回复' }),
    ];
    const turns = buildTurns(msgs);
    expect(turns).toHaveLength(2); // user 轮 + admin 单轮
    expect(turns[1]!.steps).toHaveLength(2);
    expect(turns[1]!.final?.content).toBe('最终回复');
  });
});
