// ============================================================
// tool-running-visibility.test.ts —— 工具 running 态可见性回归
//
// 背景 bug（2026-12 反馈：「前端似乎不存在工具消息的 running 等待状态，
// 只有工具执行完才出现」）：running 态机制上存在但可见窗口极窄——
//   ① llm/delta 工具分片阶段（模型流式生成参数，通常数秒——step 大头）
//     此前只累积不建卡 → 思考已闭合、正文常空 → 界面纯静默；
//   ② 本地快工具毫秒级完成，建占位与写终态同批提交 → dots 中间态
//     在 paint 层面从未存在。
//
// 修复不变量：
//   A. 首个工具分片（id+name 完整）到达即建 preparing 占位卡，转圈可见；
//     delta-end 升级为真 tool_call_id（prep- 原始 id 由占位行精确配对吸收）；
//   B. 快工具终态延迟关停（TOOL_MIN_SPIN_MS=300ms）：after-execute 即刻
//     落数据（content），视觉延后；after-step / after-run / 中断等边界
//     事件强制 flush——步终值语义（isStreaming 全关）不被悬挂计时器破坏；
//   C. 幻影分片（id/name 空冲洗片）不建卡。
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/api/wire', () => ({
  wireRpc: { call: vi.fn().mockRejectedValue(new Error('no rpc in test')), onWireEvent: vi.fn(() => () => {}), onWireOpen: vi.fn(() => () => {}), onWireClose: vi.fn(() => () => {}), onWireAck: vi.fn(() => {}) },
}));

vi.mock('ac-client-ui-renderer/client/logger.ts', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createSessionCores, type SessionCores } from './helpers/sessionCores.ts';
import { wireFace } from '../src/runtime/wireFace';
import { directDialog } from '../src/utils/feed';

const A = 'alpha';
const conv = `${A}~user`;
const env = { conversationId: conv, sender: 'user' };
const delta = (chunk: Record<string, unknown>) => [{ model: 'm' }, chunk, { agent: A, conversationId: conv, sender: 'user' }] as unknown[];
const META = [undefined, { agent: A, conversationId: conv, sender: 'user' }] as unknown[];

describe('工具 running 态可见性（参数阶段占位 + 最短转圈）', () => {
  let cores: SessionCores;

  beforeEach(() => {
    vi.useFakeTimers();
    cores = createSessionCores(wireFace);
    cores.feed.init();
    cores.roster.activeAgentId.value = A;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('A. 首个工具分片到达即建 preparing 占位卡（参数流式阶段转圈可见）', () => {
    const feed = cores.feed;
    const id = directDialog(A);

    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    feed.ingestFrame('loop/step-started', [A, 0, [], env]);
    feed.ingestFrame('llm/delta', delta({ reasoning: '想想' }));
    // 首个工具分片：id+name 完整 → 占位卡即刻出现（不等 delta-end）
    feed.ingestFrame('llm/delta', delta({ toolCalls: [{ index: 0, id: 'tc_r', name: 'read' }] }));

    const rows = feed.getRaw(id).filter(m => m.role === 'tool');
    expect(rows).toHaveLength(1);
    expect(rows[0].isStreaming).toBe(true); // ← 修复前：此阶段无任何工具行
    expect(rows[0].label).toContain('正在调用工具');

    // 参数增量分片：不建第二张卡（index 去重）
    feed.ingestFrame('llm/delta', delta({ toolCalls: [{ index: 0, argumentsDelta: '{"file_path":"a.ts"}' }] }));
    expect(feed.getRaw(id).filter(m => m.role === 'tool')).toHaveLength(1);

    // delta-end：占位升级为真 id（原始 prep- id 不残留）
    feed.ingestFrame('llm/delta-end', META);
    const upgraded = feed.getRaw(id).filter(m => m.role === 'tool');
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0].tool_call_id).toBe('tc_r');
    expect((upgraded[0].arguments as any)?.file_path).toBe('a.ts');
  });

  it('A-2. 并行占位：同名两调用各自成卡、升级不串位（修复位置匹配漏洞）', () => {
    const feed = cores.feed;
    const id = directDialog(A);

    feed.ingestFrame('loop/step-started', [A, 0, [], env]);
    // 同名并行：Y（index 0）先声明、X（index 1）后声明——delta-end 按 index 序升级
    feed.ingestFrame('llm/delta', delta({ toolCalls: [{ index: 0, id: 'tc_Y', name: 'bash' }] }));
    feed.ingestFrame('llm/delta', delta({ toolCalls: [{ index: 1, id: 'tc_X', name: 'bash' }] }));
    const preps = feed.getRaw(id).filter(m => m.role === 'tool');
    expect(preps).toHaveLength(2);
    expect(preps.every(m => m.isStreaming)).toBe(true);

    feed.ingestFrame('llm/delta-end', META);
    const rows = feed.getRaw(id).filter(m => m.role === 'tool');
    expect(rows.map(r => r.tool_call_id).sort()).toEqual(['tc_X', 'tc_Y']); // 各自成卡升级
    expect(rows.every(r => r.isStreaming)).toBe(true); // 均未漏升级（修复前 lastStreaming 位置匹配会漏一个）

    // 结果按 id 归属（既有回归）：X 完成 Y 仍转
    feed.ingestFrame('tool/after-execute', [{ toolCallId: 'tc_X', agentId: A, conversationId: conv }, { ok: true, output: 'X结果' }, undefined]);
    const x = feed.getRaw(id).find(m => m.tool_call_id === 'tc_X')!;
    const y = feed.getRaw(id).find(m => m.tool_call_id === 'tc_Y')!;
    expect(x.content).toBe('X结果');
    expect(y.isStreaming).toBe(true);
  });

  it('B. 快工具终态延迟关停：数据即落、dots 保留至满 300ms 后关停', () => {
    const feed = cores.feed;
    const id = directDialog(A);

    feed.ingestFrame('loop/step-started', [A, 0, [], env]);
    feed.ingestFrame('llm/delta', delta({ toolCalls: [{ index: 0, id: 'tc_fast', name: 'math' }] }));
    feed.ingestFrame('llm/delta-end', META);
    // 快工具：after-execute 与占位建立几乎同时（毫秒级完成）
    feed.ingestFrame('tool/after-execute', [{ toolCallId: 'tc_fast', agentId: A, conversationId: conv }, { ok: true, output: '42' }, undefined]);

    const row = feed.getRaw(id).find(m => m.tool_call_id === 'tc_fast')!;
    expect(row.content).toBe('42'); // 数据已落
    expect(row.isStreaming).toBe(true); // ← 修复前：dots 同帧即灭（paint 不可见）

    vi.advanceTimersByTime(299);
    expect(feed.getRaw(id).find(m => m.tool_call_id === 'tc_fast')!.isStreaming).toBe(true); // 未满不关
    vi.advanceTimersByTime(2);
    expect(feed.getRaw(id).find(m => m.tool_call_id === 'tc_fast')!.isStreaming).toBe(false); // 到点关停
  });

  it('B-2. 慢工具（>300ms）终态即关、无延迟', () => {
    const feed = cores.feed;
    const id = directDialog(A);

    feed.ingestFrame('loop/step-started', [A, 0, [], env]);
    feed.ingestFrame('llm/delta', delta({ toolCalls: [{ index: 0, id: 'tc_slow', name: 'bash' }] }));
    feed.ingestFrame('llm/delta-end', META);
    feed.ingestFrame('loop/after-step', [A, { text: '', toolCalls: [{ id: 'tc_slow', name: 'bash', arguments: '{}' }] }, env]);
    vi.advanceTimersByTime(5_000); // 工具执行 5s（占位已被 after-step flush 关闭——既有语义）
    feed.ingestFrame('tool/after-execute', [{ toolCallId: 'tc_slow', agentId: A, conversationId: conv }, { ok: true, output: 'done' }, undefined]);

    const row = feed.getRaw(id).find(m => m.tool_call_id === 'tc_slow')!;
    expect(row.content).toBe('done');
    expect(row.isStreaming).toBe(false); // 占位早已关，终值即刻生效
  });

  it('B-3. 边界事件强制 flush：after-run 到达时悬挂的延迟关闭立即收口', () => {
    const feed = cores.feed;
    const id = directDialog(A);

    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    feed.ingestFrame('loop/step-started', [A, 0, [], env]);
    feed.ingestFrame('llm/delta', delta({ toolCalls: [{ index: 0, id: 'tc_end', name: 'read' }] }));
    feed.ingestFrame('llm/delta-end', META);
    feed.ingestFrame('tool/after-execute', [{ toolCallId: 'tc_end', agentId: A, conversationId: conv }, { ok: true, output: 'x' }, undefined]);
    expect(feed.getRaw(id).find(m => m.tool_call_id === 'tc_end')!.isStreaming).toBe(true); // 延迟关停中

    // run 收束先于 300ms 到达：立即收口（不破坏收束重拉时序）
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: conv, sender: 'user' }, { finish: 'stop', text: '完' }]);
    expect(feed.getRaw(id).find(m => m.tool_call_id === 'tc_end')!.isStreaming).toBe(false);
  });

  it('C. 幻影分片（id/name 空）不建卡', () => {
    const feed = cores.feed;
    const id = directDialog(A);

    feed.ingestFrame('loop/step-started', [A, 0, [], env]);
    feed.ingestFrame('llm/delta', delta({ toolCalls: [{ index: 0, id: '', name: '' }] }));
    expect(feed.getRaw(id).filter(m => m.role === 'tool')).toHaveLength(0);
  });
});
