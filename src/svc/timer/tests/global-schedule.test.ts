// ============================================================
// 全局定时模块（chime.tasks → 统一 timer 调度）单元测试
//
// v0.4.x 重构：全局定时从独立 chime 机制合并进统一 scheduleEntry：
//   · globalTimer 注入 → 虚拟 agentId=__global__
//   · target='*' → 全部 Agent；指定 targets 数组 → 按目标
//   · 旧格式 times 自动迁移为 tasks
//
// 新架构（5 层重构后）：TimerManager 构造注入 TimerOptions.globalTimer，
//   全局条目在构造时注册进 entries（__global__）。reloadAll 会清空重载，
//   因此本测试直接验证构造注入的结果。
// ============================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { TimerManager } from '../src/timer';

type AnyTimer = any;

function makeMgr(globalTimer: any): AnyTimer {
  return new TimerManager({
    agentsDir: 'C:/tmp/agents',
    workspaceDir: 'C:/tmp',
    timezone: 'Asia/Shanghai',
    globalTimer,
  }) as AnyTimer;
}

describe('TimerManager 全局定时（统一调度）', () => {
  it('旧格式（仅 times）：迁移为 tasks，默认报时文本发给所有 Agent', () => {
    const mgr = makeMgr({ enabled: true, times: ['09:00'] });
    const entries = mgr.getEntries('__global__');
    expect(entries.length).toBe(1);
    expect(entries[0].time).toBe('09:00');
    expect(entries[0].target).toBe('*'); // 全部 Agent
  });

  it('新格式（tasks）：自定义 hint 发给指定 targets', () => {
    const mgr = makeMgr({
      enabled: true,
      times: [],
      tasks: [
        { time: '10:00', hint: '提醒：该巡检了', targets: ['agent1'] },
      ],
    });
    const entries = mgr.getEntries('__global__');
    expect(entries.length).toBe(1);
    expect(entries[0].target).toBe('agent1');
  });

  it('同一时间点多个任务分别注册', () => {
    const mgr = makeMgr({
      enabled: true,
      times: [],
      tasks: [
        { time: '12:00', hint: '任务A', targets: ['agent1'] },
        { time: '12:00', hint: '任务B', targets: ['agent2'] },
      ],
    });
    const entries = mgr.getEntries('__global__');
    expect(entries.length).toBe(2);
    expect(entries.map((e: any) => e.hint)).toEqual(['任务A', '任务B']);
  });

  it('times 与 tasks 同时存在时优先 tasks', () => {
    const mgr = makeMgr({
      enabled: true,
      times: ['09:00'],
      tasks: [{ time: '10:00', hint: '新任务' }],
    });
    const entries = mgr.getEntries('__global__');
    expect(entries.length).toBe(1);
    expect(entries[0].time).toBe('10:00');
  });

  it('无 globalTimer 时无全局条目', () => {
    const mgr = makeMgr(undefined);
    expect(mgr.getEntries('__global__').length).toBe(0);
  });

  it('reloadAll 重载 Agent 配置后保留全局条目（不再被清空）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-timer-global-'));
    try {
      const mgr = new TimerManager({
        agentsDir: path.join(tmp, 'agents'),
        workspaceDir: tmp,
        timezone: 'Asia/Shanghai',
        globalTimer: { enabled: true, times: ['09:00'] },
      }) as AnyTimer;
      mgr.reloadAll();
      expect(mgr.getEntries('__global__').length).toBe(1);
      expect(mgr.getEntries('__global__')[0].time).toBe('09:00');
      mgr.stopAll();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('陈旧实例锁可接管；存活实例锁会阻止本实例调度', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-timer-lock-'));
    try {
      // 陈旧的锁（PID 已不存在）→ 本实例应接管并把自己的 pid 写回
      fs.writeFileSync(path.join(tmp, 'timer-instance.lock'), JSON.stringify({ pid: 2_147_483_647 }), 'utf-8');
      const mgr = new TimerManager({
        agentsDir: path.join(tmp, 'agents'),
        workspaceDir: tmp,
        timezone: 'Asia/Shanghai',
      }) as AnyTimer;
      mgr.reloadAll();
      const lock = JSON.parse(fs.readFileSync(path.join(tmp, 'timer-instance.lock'), 'utf-8'));
      expect(lock.pid).toBe(process.pid);
      mgr.stopAll();
      expect(fs.existsSync(path.join(tmp, 'timer-instance.lock'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
