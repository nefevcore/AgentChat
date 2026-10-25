// ============================================================
// tests/kv-downsample.test.ts —— KV 走势 min-max 降采样（cr-311）验收
//
// 纯函数（tokens.ts downsampleKvSteps）：
//   · ≤ maxSamples 原样直通（形状分毫不变——绝不过降采样改形状）
//   · 超限按桶取命中率极值代表点：桶内深谷（骤降）保留
//   · 全桶无计量 → empty 占位（断线语义）；有计量样本 empty=false
//   · 代表点数 ≤ maxSamples；i 升序；hover 用的原始步号真实
// ============================================================
import { describe, it, expect } from 'vitest';
import { downsampleKvSteps, type KvTimelinePoint } from '../client/tokens.ts';

const pt = (hit: number, miss: number, ts = 0): KvTimelinePoint => ({ ts, hit, miss });

describe('cr-311 · downsampleKvSteps（min-max 降采样）', () => {
  it('步数 ≤ maxSamples：原样直通', () => {
    const pts = [pt(80, 20), pt(0, 0), pt(95, 5)];
    const out = downsampleKvSteps(pts, 440);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ i: 0, hit: 80, miss: 20, empty: false });
    expect(out[1]).toMatchObject({ i: 1, empty: true });
    expect(out[2]).toMatchObject({ i: 2, hit: 95, empty: false });
  });

  it('超限降采样：桶内深谷保留为代表点', () => {
    // 1000 步全 95%，第 777 步骤降到 5%——桶均值法会抹掉，min-max 必须留住
    const pts = Array.from({ length: 1000 }, (_, i) =>
      i === 777 ? pt(5, 95, i) : pt(95, 5, i));
    const out = downsampleKvSteps(pts, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    const dip = out.find((s) => s.i === 777);
    expect(dip).toBeDefined();
    expect(dip!.hit / (dip!.hit + dip!.miss)).toBeCloseTo(0.05);
  });

  it('代表点按原始步号升序、极值点成对出现（顺序保持）', () => {
    const pts = Array.from({ length: 500 }, (_, i) =>
      pt(50 + 40 * Math.sin(i / 30), 100 - 50 - 40 * Math.sin(i / 30), i));
    const out = downsampleKvSteps(pts, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    for (let k = 1; k < out.length; k++) expect(out[k].i).toBeGreaterThan(out[k - 1].i);
  });

  it('全桶无计量 → empty 占位（断线语义）；空序列/单点边界', () => {
    const pts = Array.from({ length: 500 }, () => pt(0, 0));
    const out = downsampleKvSteps(pts, 60);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => s.empty)).toBe(true);
    expect(downsampleKvSteps([], 440)).toEqual([]);
    const one = downsampleKvSteps([pt(1, 1, 42)], 440);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ i: 0, ts: 42, empty: false });
  });

  it('尾部桶不完整（points.length 非整除）：末样本 i = 末步号', () => {
    const pts = Array.from({ length: 999 }, (_, i) => pt(90 - i / 100, 10 + i / 100, i));
    const out = downsampleKvSteps(pts, 100);
    expect(out[out.length - 1].i).toBe(998);
  });
});
