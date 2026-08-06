// ============================================================
// 全局定时模块（chime.tasks → 统一 timer 调度）单元测试
//
// v0.4.x 重构：全局定时从独立 chime 机制合并进统一 scheduleEntry：
//   · reloadAll 加载 chime.tasks → 虚拟 agentId=__global__
//   · target='*' → 全部 Agent；指定 targets 数组 → 按目标
//   · 旧格式 times 自动迁移为 tasks
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock @core/config（vi.hoisted 确保 mock 工厂可访问状态）----
const mockState = vi.hoisted(() => ({
  chime: { enabled: true, times: [] },
  agentsDir: 'C:/tmp/agents',
  workspaceDir: 'C:/tmp',
}));
vi.mock('@core/config', () => ({
  getGlobalConfig: () => ({ ...mockState, workspaceDir: 'C:/tmp' }),
}));

import { TimerManager } from '@plugins/builtin/src/timer';

type AnyTimer = any;

describe('TimerManager 全局定时（统一调度）', () => {
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

  it('旧格式（仅 times）：迁移为 tasks，默认报时文本发给所有 Agent', () => {
    mockState.chime = { enabled: true, times: ['09:00'] };
    mgr.reloadAll();

    // __global__ 条目已注册
    const entries = mgr.getEntries('__global__');
    expect(entries.length).toBe(1);
    expect(entries[0].time).toBe('09:00');
    expect(entries[0].target).toBe('*'); // 全部 Agent
  });

  it('新格式（tasks）：自定义 hint 发给指定 targets', () => {
    mockState.chime = {
      enabled: true,
      times: [],
      tasks: [
        { time: '10:00', hint: '提醒：该巡检了', targets: ['agent1'] },
      ],
    };
    mgr.reloadAll();

    const entries = mgr.getEntries('__global__');
    expect(entries.length).toBe(1);
    expect(entries[0].target).toBe('agent1');
  });

  it('同一时间点多个任务分别注册', () => {
    mockState.chime = {
      enabled: true,
      times: [],
      tasks: [
        { time: '12:00', hint: '任务A', targets: ['agent1'] },
        { time: '12:00', hint: '任务B', targets: ['agent2'] },
      ],
    };
    mgr.reloadAll();

    const entries = mgr.getEntries('__global__');
    expect(entries.length).toBe(2);
    expect(entries.map(e => e.hint)).toEqual(['任务A', '任务B']);
  });

  it('times 与 tasks 同时存在时优先 tasks', () => {
    mockState.chime = {
      enabled: true,
      times: ['09:00'],
      tasks: [{ time: '10:00', hint: '新任务' }],
    };
    mgr.reloadAll();

    const entries = mgr.getEntries('__global__');
    expect(entries.length).toBe(1);
    expect(entries[0].time).toBe('10:00');
  });

  it('chime 为空时无全局条目', () => {
    mockState.chime = undefined;
    mgr.reloadAll();
    expect(mgr.getEntries('__global__').length).toBe(0);
  });
});
