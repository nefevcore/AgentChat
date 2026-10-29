// ============================================================
// run-status-dock.test.ts —— 会话状态推导纯函数（cr-744）
// 覆盖：七态全分支 + 组合判据（边界帧丢失窗口不漏判）+ 整体耗时
// 起点（末条 viewer ts）+ 中文耗时格式 + 错误优先级。
// ============================================================
import { describe, it, expect } from 'vitest';
import { deriveRunStatus, formatDurationCn, lastViewerTs, type RunStatusDialog } from '../client/runStatus.ts';

function dialog(partial: Partial<RunStatusDialog>): RunStatusDialog {
  return { streaming: false, rawMessages: [], ...partial };
}

describe('deriveRunStatus（七态推导）', () => {
  it('空闲（无分区/无在途迹象）→ hidden', () => {
    expect(deriveRunStatus(null, '', 'info')).toEqual({ kind: 'hidden' });
    expect(deriveRunStatus(dialog({}), '', 'info')).toEqual({ kind: 'hidden' });
  });

  it('busyFeedback error → error 态优先（投递失败/看门狗超时并入）', () => {
    expect(deriveRunStatus(null, '发送失败：超时', 'error')).toEqual({ kind: 'error', text: '发送失败：超时' });
    expect(deriveRunStatus(dialog({ streaming: true }), '已排队，本轮结束后投递', 'info')).toMatchObject({ kind: 'waking' });
  });

  it('streaming 且无任何 run 迹象 → waking（投递/冷启动窗口）', () => {
    const d = dialog({
      streaming: true,
      rawMessages: [
        { role: 'agent', agent_id: 'user', timestamp: 42 },
      ],
    });
    expect(deriveRunStatus(d, '', 'info')).toEqual({ kind: 'waking', sinceMs: 42 });
  });

  it('runStartAt 已设但无占位 → calling（run 已启动、step 未到）', () => {
    const d = dialog({
      streaming: true,
      runStartAt: 100,
      rawMessages: [{ role: 'agent', agent_id: 'user', timestamp: 42 }],
    });
    expect(deriveRunStatus(d, '', 'info')).toEqual({ kind: 'calling', sinceMs: 42 });
  });

  it('占位已建但全空 → calling（API 往返窗口）', () => {
    const d = dialog({
      streaming: true,
      rawMessages: [
        { role: 'agent', agent_id: 'user', timestamp: 42 },
        { role: 'agent', agent_id: 'alpha', timestamp: 43, isStreaming: true },
      ],
    });
    expect(deriveRunStatus(d, '', 'info')).toEqual({ kind: 'calling', sinceMs: 42 });
  });

  it('占位有思考 → thinking', () => {
    const d = dialog({
      streaming: true,
      rawMessages: [
        { role: 'agent', agent_id: 'user', timestamp: 42 },
        { role: 'agent', agent_id: 'alpha', timestamp: 43, isStreaming: true, thinking: '推理' },
      ],
    });
    expect(deriveRunStatus(d, '', 'info')).toEqual({ kind: 'thinking', sinceMs: 42 });
  });

  it('占位有正文 → replying', () => {
    const d = dialog({
      streaming: true,
      rawMessages: [
        { role: 'agent', agent_id: 'user', timestamp: 42 },
        { role: 'agent', agent_id: 'alpha', timestamp: 43, isStreaming: true, content: '你' },
      ],
    });
    expect(deriveRunStatus(d, '', 'info')).toEqual({ kind: 'replying', sinceMs: 42 });
  });

  it('载体活跃时的相位序：正文流式优先于工具残留标记（流式输出不误显 tooling）', () => {
    // 载体 content 有值 = 流式输出中——即使 toolCalls 有 running 残留（如
    // 参数流式分片）也显示 replying（上一步工具卡的延迟关停窗不吞新相位）
    const d = dialog({
      streaming: true,
      rawMessages: [
        { role: 'agent', agent_id: 'user', timestamp: 42 },
        { role: 'agent', agent_id: 'alpha', timestamp: 43, isStreaming: true, content: '回复正文', toolCalls: [{ running: true }] },
      ],
    });
    expect(deriveRunStatus(d, '', 'info')).toEqual({ kind: 'replying', sinceMs: 42 });
  });

  it('载体自带 running 工具分片且无内容 → tooling（参数流式/preparing）', () => {
    const d = dialog({
      streaming: true,
      rawMessages: [
        { role: 'agent', agent_id: 'user', timestamp: 42 },
        { role: 'agent', agent_id: 'alpha', timestamp: 43, isStreaming: true, toolCalls: [{ running: true }] },
      ],
    });
    expect(deriveRunStatus(d, '', 'info')).toEqual({ kind: 'tooling', sinceMs: 42 });
  });

  it('直播 tool 占位（isStreaming）→ tooling', () => {
    const d = dialog({
      streaming: true,
      rawMessages: [
        { role: 'agent', agent_id: 'user', timestamp: 42 },
        { role: 'tool', timestamp: 43, content: '', isStreaming: true },
      ],
    });
    expect(deriveRunStatus(d, '', 'info')).toEqual({ kind: 'tooling', sinceMs: 42 });
  });

  it('【死 partial 行不误判】content 空的 tool 行（无 isStreaming、后端已重启）→ 不在途不卡 tooling', () => {
    // run 进行中刷新带回的 partial 检查点行与直播工具行同形——靠 isStreaming 区分：
    // 死行无标记且 streaming=false → hidden（状态卡收束，不恒 tooling）
    const d = dialog({
      streaming: false,
      rawMessages: [
        { role: 'agent', agent_id: 'user', timestamp: 42 },
        { role: 'tool', timestamp: 43, content: '' },
      ],
    });
    expect(deriveRunStatus(d, '', 'info')).toEqual({ kind: 'hidden' });
  });

  it('【边界帧丢失窗口】streaming=false 但流式占位在场 → 仍推导（不 hidden）', () => {
    // 后端重启/刷新撞上 run-started 广播：onOpen 强制关闭 streaming 标志，
    // 后续 delta 只写占位不置 streaming——组合判据兜住
    const d = dialog({
      streaming: false,
      rawMessages: [
        { role: 'agent', agent_id: 'user', timestamp: 42 },
        { role: 'agent', agent_id: 'alpha', timestamp: 43, isStreaming: true, content: '流式中' },
      ],
    });
    expect(deriveRunStatus(d, '', 'info')).toEqual({ kind: 'replying', sinceMs: 42 });
  });

  it('【权威判死】authoritativeActive=false + 本地在途 + 静默超 20s → hidden（死行收束）', () => {
    // shell stats 说不在跑 + 本地 20s 无新帧 = 死行（后端重启/刷新窗口）——
    // 权威对账替代启发式死行判别（cr-756）
    const d = dialog({
      streaming: true,
      rawMessages: [
        { role: 'agent', agent_id: 'user', timestamp: 42 },
        { role: 'agent', agent_id: 'alpha', timestamp: 43, isStreaming: true, content: '流式中' },
      ],
    });
    expect(deriveRunStatus({ ...d, lastStreamAt: 1000 }, '', 'info', false, 30_000)).toEqual({ kind: 'hidden' });
    // 豁免窗内（最近有帧）不判死——后端可能只是还没广播下一帧
    expect(deriveRunStatus({ ...d, lastStreamAt: 29_000 }, '', 'info', false, 30_000)).toEqual({ kind: 'replying', sinceMs: 42 });
    // 权威说在跑 → 本地帧自治照常
    expect(deriveRunStatus({ ...d, lastStreamAt: 1000 }, '', 'info', true, 30_000)).toEqual({ kind: 'replying', sinceMs: 42 });
  });

  it('收束后（无流式占位、streaming=false）→ hidden', () => {
    const d = dialog({
      streaming: false,
      rawMessages: [
        { role: 'agent', agent_id: 'user', timestamp: 42 },
        { role: 'agent', agent_id: 'alpha', timestamp: 43, content: '完整回复' },
      ],
    });
    expect(deriveRunStatus(d, '', 'info')).toEqual({ kind: 'hidden' });
  });
});

describe('辅助函数', () => {
  it('lastViewerTs：末条 viewer 消息 ts；viewer 缺席 = 0', () => {
    expect(lastViewerTs(dialog({ rawMessages: [{ role: 'agent', agent_id: 'user', timestamp: 5 }, { role: 'agent', agent_id: 'user', timestamp: 9 }] }))).toBe(9);
    expect(lastViewerTs(dialog({ rawMessages: [{ role: 'agent', agent_id: 'alpha', timestamp: 5 }] }))).toBe(0);
  });

  it('formatDurationCn：中文完整耗时（不压缩）', () => {
    expect(formatDurationCn(47)).toBe('47 秒');
    expect(formatDurationCn(83)).toBe('1 分 23 秒');
    expect(formatDurationCn(3725)).toBe('1 小时 2 分 5 秒');
  });
});