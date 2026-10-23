// ============================================================
// orchestrate-deadline.test.ts —— adoptShell stdout 消费循环常驻性
//（cr-580 根因回归锁：adopt deadline 只辖拉起窗——adopted 后循环退出
// 会使 ctrl.done/心跳行永无人分发：控制帧恒 60s 超时 + 监护失流。）
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { adoptShell } from '../orchestrate.ts';
import { ReachabilityTable } from 'ac-post-office';
import type { SpawnFn } from '../orchestrate.ts';

describe('adoptShell stdout 循环常驻性（cr-580）', () => {
  it('adopted 后超过 adopt deadline 的 ctrl.done 仍被分发（控制帧不超时）', async () => {
    const written: string[] = [];
    const lines: string[] = [
      'boot.lock.acquired\tb-1',
      'boot.rows.ready\tb-1\t31',
      'boot.ready\tb-1\\tpipe-x'.replace('\\t', '\t'),
    ];
    const waiters: Array<(l: string) => void> = [];
    const push = (l: string) => { const w = waiters.shift(); if (w) w(l); else lines.push(l); };
    const spawnFn: SpawnFn = () => ({
      pid: 4321,
      stdout: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const queued = lines.shift();
            if (queued !== undefined) { yield queued; continue; }
            yield await new Promise<string>((resolve) => { waiters.push(resolve); });
          }
        },
      },
      write: (line: string) => {
        written.push(line);
        // 壳侧回执：等 adopt deadline（60ms）过后再吐行——修复前该行
        // 到达即循环退出、控制帧永挂
        setTimeout(() => push('ctrl.done\t{}'), 150);
      },
      on: (event: string, cb: (code: number | null) => void) => { void event; void cb; },
      kill: () => { /* 测试替身无进程 */ },
    });
    // 数据根用 tmpdir（adoptShell 会物化 agents/a1/config.json——相对路径
    // 会把残留写进仓库根，cr-621 实锤过 X/ 泄漏）
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-deadline-'));
    const adopted = await adoptShell({
      agentId: 'a1',
      dataRoot,
      catalogFile: 'C',
      bootFile: 'B',
      reach: new ReachabilityTable(),
      spawnFn,
      timeoutMs: 60, // deadline 60ms——回执在 150ms（>deadline）
    });
    expect(adopted.transportHint).toBe('pipe-x');
    const out = await adopted.control({ ctrl: 'admin', op: 'run-state', agentId: 'a1' });
    expect(out).toEqual({});
    expect(written).toHaveLength(1);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }, 20_000);
});