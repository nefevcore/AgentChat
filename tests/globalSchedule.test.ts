// ============================================================
// 全局定时模块（chime → tasks 泛化）单元测试
//
// v0.4.0 重构：全局定时从"仅报时" → "任意提示任务"：
//   · tasks[] 支持自定义 hint + targets
//   · 兼容旧格式（仅 times → 默认报时文本）
//   · 同一时间点多个任务分别触发
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock @core/config（vi.hoisted 确保 mock 工厂可访问状态）----
const mockState = vi.hoisted(() => ({ chime: { enabled: true, times: [] } }));
vi.mock('@core/config', () => ({
  getGlobalConfig: () => ({ ...mockState, workspaceDir: 'C:/tmp' }),
}));

import { TimerManager } from '@core/timer-manager';

type AnyTimer = any;

describe('TimerManager 全局定时 tasks 泛化', () => {
  let mgr: AnyTimer;
  let mockRouter: any;
  const triggers: Array<{ agentId: string; hint: string; source: string }> = [];

  beforeEach(() => {
    mockState.chime = { enabled: true, times: [] };
    triggers.length = 0;
    mockRouter = {
      getAgentIds: () => ['agent1', 'agent2'],
      trigger: async (agentId: string, opts: any) => {
        triggers.push({ agentId, hint: opts.hint, source: opts.source });
        return { content: 'ok', interrupted: false };
      },
    };
    mgr = new TimerManager() as AnyTimer;
    mgr.router = mockRouter;
  });

  it('旧格式（仅 times）：默认报时文本发给所有 Agent', () => {
    mockState.chime = { enabled: true, times: ['09:00'] };
    mgr.lastChimeMinute = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 1, 9, 0, 0));
    mgr.checkChime();
    vi.useRealTimers();

    expect(triggers.length).toBe(2);
    expect(triggers[0].hint).toContain('09:00');
    expect(triggers[0].source).toBe('chime-09:00');
  });

  it('新格式（tasks）：自定义 hint 发给指定 targets', () => {
    mockState.chime = {
      enabled: true,
      times: [],
      tasks: [
        { time: '10:00', hint: '提醒：该巡检了', targets: ['agent1'] },
      ],
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 1, 10, 0, 0));
    mgr.checkChime();
    vi.useRealTimers();

    expect(triggers.length).toBe(1);
    expect(triggers[0].agentId).toBe('agent1');
    expect(triggers[0].hint).toBe('提醒：该巡检了');
  });

  it('同一时间点多个任务分别触发', () => {
    mockState.chime = {
      enabled: true,
      times: [],
      tasks: [
        { time: '12:00', hint: '任务A', targets: ['agent1'] },
        { time: '12:00', hint: '任务B', targets: ['agent2'] },
      ],
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 1, 12, 0, 0));
    mgr.checkChime();
    vi.useRealTimers();

    expect(triggers.length).toBe(2);
    expect(triggers.map(t => t.hint)).toEqual(['任务A', '任务B']);
  });

  it('defaultHint 模板替换 {time}', () => {
    mockState.chime = {
      enabled: true,
      times: ['15:30'],
      defaultHint: '现在是 {time}',
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 1, 15, 30, 0));
    mgr.checkChime();
    vi.useRealTimers();

    expect(triggers[0].hint).toBe('现在是 15:30');
  });

  it('disabled 时不触发', () => {
    mockState.chime = { enabled: false, times: ['09:00'] };
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 1, 9, 0, 0));
    mgr.checkChime();
    vi.useRealTimers();
    expect(triggers.length).toBe(0);
  });
});
