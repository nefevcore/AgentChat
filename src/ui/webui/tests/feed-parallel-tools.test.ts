// ============================================================
// feed-parallel-tools.test.ts —— 并行工具调用结果归属回归
//
// 背景 bug：onToolEnd/onToolUpdate 此前按「最后一条流式 tool 占位」（位置）
// 匹配目标——模型并行发出多个工具调用时，X 的 toolExecutionEnd 会把
// 最后一条占位（可能是 Y）关闭并写入 X 的 result：Y 永远 running、
// 结果归属错乱。单工具时一切正常，故线上偶发、难以复现。
//
// 修复后不变量：占位的开启/更新/关闭一律按 tool_call_id 精确匹配。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/stores/websocket', () => ({
  useWebSocketStore: () => ({
    init: vi.fn(),
    send: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    onConnect: vi.fn(() => () => {}),
  }),
}));

vi.mock('../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setActivePinia, createPinia } from 'pinia';
import { useFeedStore } from '../src/stores/feed';
import { useAgentStore } from '../src/stores/agents';
import { directDialog } from '../src/utils/feed';

const A = 'alpha';
const TC1 = 'call_tool_one_111';
const TC2 = 'call_tool_two_222';

describe('并行工具调用：结果按 tool_call_id 归属', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    useAgentStore().activeAgentId = A;
  });

  it('X 先结束不吞 Y 的占位：Y 保持流式并收到自己的增量与结果', () => {
    const feed = useFeedStore();
    const id = directDialog(A);

    // 会话轮开始（assistant 占位）+ 两个并行工具开始（乱序：2 先注册占位）
    feed.ingest('chat.step.start', { agentId: A });
    feed.ingest('chat.tool_execution.start', { agentId: A, tool_call_id: TC2, tool_name: 'bash', label: '长任务' });
    feed.ingest('chat.tool_execution.start', { agentId: A, tool_call_id: TC1, tool_name: 'read', label: '快任务' });

    const tools1 = feed.getRaw(id).filter(m => m.role === 'tool');
    expect(tools1).toHaveLength(2);

    // Y（TC2）继续产出增量 → 只进 Y 的占位
    feed.ingest('chat.tool_execution.update', { agentId: A, tool_call_id: TC2, delta: 'Y的输出' });
    const yMsg = feed.getRaw(id).find(m => m.tool_call_id === TC2)!;
    expect(yMsg.content).toBe('Y的输出');

    // X（TC1）先结束 → 关闭 X 的占位并写 result；Y 必须仍在流式
    feed.ingest('chat.tool_execution.end', { agentId: A, tool_call_id: TC1, result: 'X的结果' });
    const xAfter = feed.getRaw(id).find(m => m.tool_call_id === TC1)!;
    const yAfter = feed.getRaw(id).find(m => m.tool_call_id === TC2)!;
    expect(xAfter.isStreaming).toBe(false);
    expect(xAfter.content).toBe('X的结果');
    expect(yAfter.isStreaming).toBe(true); // ← 旧实现会把 Y 关掉并写入 X 的结果
    expect(yAfter.content).toBe('Y的输出'); // ← 旧实现这里是 'X的结果'

    // Y 随后结束 → 拿到自己的 result
    feed.ingest('chat.tool_execution.end', { agentId: A, tool_call_id: TC2, result: 'Y的结果' });
    const yDone = feed.getRaw(id).find(m => m.tool_call_id === TC2)!;
    expect(yDone.isStreaming).toBe(false);
    expect(yDone.content).toBe('Y的结果');
  });

  it('assistant.toolCalls 的 running/result 同样按 id 归属', () => {
    const feed = useFeedStore();
    const id = directDialog(A);

    feed.ingest('chat.step.start', { agentId: A });
    feed.ingest('chat.tool_execution.start', { agentId: A, tool_call_id: TC1, tool_name: 'bash', label: 'X' });
    feed.ingest('chat.tool_execution.start', { agentId: A, tool_call_id: TC2, tool_name: 'bash', label: 'Y' });

    // X 结束：只有 X 的 toolCall 停转
    feed.ingest('chat.tool_execution.end', { agentId: A, tool_call_id: TC1, result: 'X结果' });
    const asst = feed.getRaw(id).find(m => m.role === 'agent')!;
    const tcs = asst.toolCalls as any[];
    expect(tcs).toHaveLength(2);
    const tcX = tcs.find(t => t.id === TC1)!;
    const tcY = tcs.find(t => t.id === TC2)!;
    expect(tcX.running).toBe(false);
    expect(tcX.result).toBe('X结果');
    expect(tcY.running).toBe(true); // ← 旧实现：running 标志因位置关闭而错乱
  });
});
