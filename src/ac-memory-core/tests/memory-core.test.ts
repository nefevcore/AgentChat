import { describe, expect, it } from 'vitest';
import {
  grepEntries,
  mintEntry,
  parseTimeline,
  renderDelta,
  renderGrepResult,
  renderSnapshot,
} from '../src/index';

const now = '2026-12-08T14:32:00.000Z';

function entry(content: string, at = now, origin = 'alice~bob', peers?: string[], tags?: string[]): string {
  // 标签是正文通道：拼进 content 前缀段（模拟 Agent 写法）
  const body = tags && tags.length > 0 ? `[${tags.join('|')}] ${content}` : content;
  return mintEntry({ at, origin, ...(peers ? { peers } : {}), content: body });
}

describe('parseTimeline', () => {
  it('铸造-解析往返：头字段完整；标签段在正文（Agent 通道）被提取为轴', () => {
    const text = [
      entry('与 alice 约定：每周五同步代码评审', now, 'g:前端群', ['alice'], ['约定']),
      entry('alice 的部署窗口是周三上午'),
    ].join('\n');
    const entries = parseTimeline(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ seq: 1, at: now, origin: 'g:前端群', peers: ['alice'] });
    // 正文 = [date]（宿主铸）+ [约定]（Agent 写）+ 正文；tags 轴从前缀提取
    expect(entries[0].content).toMatch(/^\[2026-12-08\] \[约定\] 与 alice 约定/);
    expect(entries[0].tags).toEqual(['约定']);
    expect(entries[1].content).toMatch(/^\[2026-12-08\] alice 的部署窗口/); // 无标签段省略
    expect(entries[1].tags).toBeUndefined();
  });

  it('容错：无头正文降级为纯文本条目（seq 照常位置派生）', () => {
    const entries = parseTimeline('裸行一\n<!-- 坏头 -->\n裸行二');
    // 坏头开启新条目（无字段 → 降级），空体条目滤除——两条降级正文
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.degraded === true)).toBe(true);
    expect(entries.map((e) => e.content)).toEqual(['裸行一', '裸行二']);
  });

  it('降级行自愈：裸 [date] [tags] 前缀行提取 at/tags 轴（fs 裸写场景）', () => {
    const entries = parseTimeline('[2026-09-27] [教训|环境] 不臆测环境参数\n[2026-09-26] 裸日期行');
    expect(entries).toHaveLength(2);
    expect(entries[0].at).toContain('2026-09-27');
    expect(entries[0].tags).toEqual(['教训', '环境']);
    expect(entries[0].degraded).toBe(true);
    expect(entries[1].tags).toBeUndefined();
  });

  it('渲染日期段去重：正文自带 [date] 时剥旧铸新；标签段保留（Agent 通道）', () => {
    const out = renderSnapshot(parseTimeline(entry('正常条目', now, 'o', undefined, ['偏好'])), { maxTokens: 500 });
    expect(out).toContain('[2026-12-08] [偏好] 正常条目');
    // Agent 手滑带 [date] 前缀 → mint 去重日期段（只一个）；自带标签段保留
    const dupe = parseTimeline(mintEntry({ at: now, origin: 'o', content: '[2026-12-08] [教训] 手滑带日期' }));
    expect(dupe[0].content).toBe('[2026-12-08] [教训] 手滑带日期');
    expect(dupe[0].tags).toEqual(['教训']);
  });

  it('空内容条目滤除（文件尾残留空头）', () => {
    expect(parseTimeline('<!-- at:x | origin:y -->\n')).toHaveLength(0);
    expect(parseTimeline('')).toHaveLength(0);
  });

  it('多行正文保留（含空行；前缀只铸首行）', () => {
    const entries = parseTimeline(entry('第一行\n\n第三行'));
    expect(entries[0].content).toBe('[2026-12-08] 第一行\n\n第三行');
  });
});

describe('renderSnapshot（确定性）', () => {
  it('空时间线 → 空态说明行', () => {
    expect(renderSnapshot([])).toContain('为空');
  });

  it('统计行含条数/时间跨度/tags', () => {
    const entries = parseTimeline(
      entry('a', '2026-11-01T00:00:00.000Z', 'x', undefined, ['约定']) +
        entry('b', '2026-12-08T00:00:00.000Z', 'y', undefined, ['偏好']),
    );
    const out = renderSnapshot(entries);
    expect(out).toContain('2 条');
    expect(out).toContain('2026-11-01 ~ 2026-12-08');
    expect(out).toContain('tags:');
  });

  it('预算整数条截断 + 溢出注记', () => {
    const entries = parseTimeline(
      [1, 2, 3, 4, 5].map((i) => entry(`条目 ${i} ${'x'.repeat(400)}`, `2026-12-0${i}T00:00:00.000Z`)).join('\n'),
    );
    const out = renderSnapshot(entries, { maxTokens: 80 });
    expect(out).toContain('更早记忆未注入');
    // 截断后仍含最新条、不含最早条
    expect(out).toContain('条目 5');
    expect(out).not.toContain('条目 1');
  });

  it('确定性：同输入同输出', () => {
    const entries = parseTimeline(entry('内容', now, 'o', ['p'], ['t']));
    expect(renderSnapshot(entries, { maxTokens: 500 })).toBe(renderSnapshot(entries, { maxTokens: 500 }));
  });
});

describe('renderDelta', () => {
  it('(S, H] 区间升序渲染；空区间 undefined', () => {
    const entries = parseTimeline([1, 2, 3, 4].map((i) => entry(`条目 ${i}`)).join('\n'));
    expect(renderDelta(entries, { from: 2, to: 2 })).toBeUndefined();
    const out = renderDelta(entries, { from: 2, to: 4 });
    expect(out).toContain('条目 3');
    expect(out).toContain('条目 4');
    expect(out).not.toContain('条目 2');
  });
});

describe('grepEntries 过滤轴', () => {
  it('pattern/peer/tag/时间轴 AND 组合', () => {
    const entries = parseTimeline(
      [
        entry('部署窗口周三', '2026-11-01T00:00:00.000Z', 'g:群', ['alice'], ['约定']),
        entry('deploy window', '2026-12-05T00:00:00.000Z', 'p', ['bob'], ['偏好']),
      ].join('\n'),
    );
    expect(grepEntries(entries, { pattern: '部署' })).toHaveLength(1);
    expect(grepEntries(entries, { peer: 'bob' })).toHaveLength(1);
    expect(grepEntries(entries, { tag: '约定' })).toHaveLength(1);
    expect(grepEntries(entries, { since: '2026-12-01' })).toHaveLength(1);
    expect(grepEntries(entries, { until: '2026-12-01' })).toHaveLength(1);
    expect(grepEntries(entries, { pattern: 'w', peer: 'bob' })).toHaveLength(1);
    expect(grepEntries(entries, { pattern: 'zzz' })).toHaveLength(0);
  });

  it('renderGrepResult 条目级分组 + 溢出计数', () => {
    const entries = parseTimeline([1, 2, 3].map((i) => entry(`条目 ${i}`)).join('\n'));
    expect(renderGrepResult(entries)).toContain('#3');
    expect(renderGrepResult(entries, 2)).toContain('更早 1 条');
    expect(renderGrepResult([])).toContain('无匹配');
  });
});

describe('锚协议辅助（H 计数语义）', () => {
  it('条目数 = 盘上状态 H（H>S delta、H<S 自愈的判定输入）', () => {
    const entries = parseTimeline(entry('a') + entry('b') + entry('c'));
    expect(entries.length).toBe(3);
    expect(entries.at(-1)!.seq).toBe(3);
  });
});