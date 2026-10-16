// ============================================================
// desktop/tests/desktop-kill-tree.test.ts
// desktop killBackendTree 回归（cr-382 孤儿进程复盘建议 1；cr-481 归位壳域）
//
// postmortem §3B：旧实现「backend.kill() 后 3s 内退出即不再补刀」在最
// 常见的优雅退出路径上跳过 taskkill /T——shell 孙进程原地成孤儿。本
// 测试驱动 main.mjs 的树杀路径，断言 win32 下 taskkill /F /T 无条件
// 发出（不被 exitCode 竞态跳过）。spawn 以 no-op 假体替换——绝不能让
// 真实 taskkill 打向任意 pid。
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const fake = { unref: () => {}, on: () => fake, kill: () => {} };
  return { ...actual, spawn: vi.fn(() => fake) as unknown as typeof actual.spawn };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = Record<string, any>;

function findMainMjs(): string {
  let dir = process.env.AGENTCHAT_REPO_ROOT || process.cwd();
  for (let i = 0; i < 12; i++) {
    const cand = nodePath.join(dir, 'desktop', 'main.mjs');
    if (nodeFs.existsSync(cand)) return cand;
    const parent = nodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未定位到 desktop/main.mjs');
}
const MAIN_URL = pathToFileURL(findMainMjs()).href;

describe('desktop killBackendTree（cr-382 树杀回归）', () => {
  it('win32：后端存活即无条件 taskkill /F /T（不被优雅退出竞态跳过）', async () => {
    const mod = (await import(MAIN_URL)) as unknown as AnyRec;
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockClear();
    mod.__testKillBackendTree({ pid: 4321, exitCode: null, kill: vi.fn() });
    if (process.platform === 'win32') {
      const call = spawnMock.mock.calls.find(
        (c) => c[0] === 'taskkill' && (c[1] as string[] | undefined)?.includes('4321'),
      );
      expect(call).toBeTruthy();
      expect(call![1]).toEqual(['/F', '/T', '/PID', '4321']);
    } else {
      // 非 win：SIGTERM → 3s 后 SIGKILL 升级路径——首轮 kill 即被调
      // （SIGKILL 升级在 unref 计时器里，不在此断言）
      expect(spawnMock).not.toHaveBeenCalled();
    }
  });
});
