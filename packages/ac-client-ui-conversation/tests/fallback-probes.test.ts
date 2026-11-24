// ============================================================
// fallback-probes.test.ts —— 兜底探针：计数器行为锁（命中累计 /
// 行去重双指标 / 读面快照 / 复位；挂接点行为由 feed 族既有测试覆盖，
// 本测试锁探针原语本身）。P3-1 cr-1281：event-quota / content-prefix
// 键随对应兜底链删除退役。cr-1299 双指标：hits = 分支进入次数，
// rows = 去重行数（首见计数——「归零即删」判读口径）。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { probeHit, readFallbackProbes, resetFallbackProbes } from '../client/fallback-probes.ts';

describe('兜底探针（cr-1276 起；cr-1299 双指标）', () => {
  beforeEach(() => resetFallbackProbes());
  it('命中累计 + 行去重（无 rowId 的命中不增 rows）', () => {
    expect(readFallbackProbes()).toEqual({});
    probeHit('inject-heuristic', 'row-a');
    probeHit('inject-heuristic', 'row-a'); // 同行重扫——hits 增、rows 不增
    probeHit('inject-heuristic', 'row-b');
    expect(readFallbackProbes()).toEqual({ 'inject-heuristic': { hits: 3, rows: 2 } });
  });
  it('无行身份命中（rowId 缺席）只计 hits', () => {
    probeHit('inject-heuristic');
    probeHit('inject-heuristic');
    expect(readFallbackProbes()).toEqual({ 'inject-heuristic': { hits: 2, rows: 0 } });
  });
  it('复位清零', () => {
    probeHit('inject-heuristic', 'row-a');
    resetFallbackProbes();
    expect(readFallbackProbes()).toEqual({});
  });
});
