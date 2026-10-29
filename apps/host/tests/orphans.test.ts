// ============================================================
// orphans.test.ts：指纹 + 双护栏孤儿判定纯函数（cr-382；cr-800 回迁）
// ============================================================
import { describe, it, expect } from 'vitest';
import { isOrphanCandidate } from '../orphans.ts';

const FP = '-NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;';
const NOW = Date.now();
const DEAD = 0; // 父 pid 0 = 内核/已死——isAlive(0) 恒 false

describe('孤儿判定（指纹 + 双护栏）', () => {
  it('指纹命中 + 父已死 + 早于 boot → 孤儿', () => {
    expect(
      isOrphanCandidate(
        { ppid: DEAD, startedAt: NOW - 3600_000, cmdline: `pwsh ${FP} Get-ChildItem -Recurse src` },
        NOW,
      ),
    ).toBe(true);
  });

  it('指纹不命中（其他 harness 的变体前缀）→ 非孤儿', () => {
    expect(
      isOrphanCandidate(
        { ppid: DEAD, startedAt: NOW - 3600_000, cmdline: 'pwsh -NoLogo -NoProfile -NonInteractive -Command "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); …"' },
        NOW,
      ),
    ).toBe(false);
  });

  it('护栏①父进程存活（并行实例的活子进程）→ 非孤儿', () => {
    expect(
      isOrphanCandidate(
        { ppid: process.pid, startedAt: NOW - 3600_000, cmdline: `pwsh ${FP} echo hi` },
        NOW,
      ),
    ).toBe(false);
  });

  it('护栏②启动晚于 boot（本实例刚 spawn）→ 非孤儿', () => {
    expect(
      isOrphanCandidate(
        { ppid: DEAD, startedAt: NOW + 1000, cmdline: `pwsh ${FP} echo hi` },
        NOW,
      ),
    ).toBe(false);
  });

  it('启动时间缺失（解析失败）→ 保守非孤儿', () => {
    expect(
      isOrphanCandidate({ ppid: DEAD, startedAt: 0, cmdline: `pwsh ${FP} echo hi` }, NOW),
    ).toBe(false);
  });
});
