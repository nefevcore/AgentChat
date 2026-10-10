// ============================================================
// ac-core-utils：跨行协议纯函数（GROUP_HINT_META/isGroupHint、maxSeqOf、
// runAddress/pairKey/ARCHIVE_REVIEW_META/isArchiveReviewRun/normalizeToolSpecs）
// persona 解析词法测试住 tests/persona.test.ts（cr-321 随迁）
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  ARCHIVE_REVIEW_META,
  GROUP_HINT_META,
  isArchiveReviewRun,
  isGroupHint,
  maxSeqOf,
  normalizeToolSpecs,
  pairKey,
  runAddress,
} from '../src/index.ts';

describe('GROUP_HINT_META / isGroupHint', () => {
  it('标记键恒为 group-hint（wire 协议锁定）', () => {
    expect(GROUP_HINT_META).toBe('group-hint');
  });

  it('仅 meta[GROUP_HINT_META] === true 判为群 hint', () => {
    expect(isGroupHint({ [GROUP_HINT_META]: true })).toBe(true);
    expect(isGroupHint({ [GROUP_HINT_META]: false })).toBe(false); // 假值不放行
    expect(isGroupHint({ [GROUP_HINT_META]: 'true' })).toBe(false); // 字符串形态不放行
    expect(isGroupHint({})).toBe(false);
    expect(isGroupHint(undefined)).toBe(false);
  });

  it('与其他 meta 键共存时不误判', () => {
    expect(isGroupHint({ other: true })).toBe(false);
    expect(isGroupHint({ other: 1, [GROUP_HINT_META]: true })).toBe(true);
  });
});

describe('runAddress（steer/串行化门共用的寻址词汇）', () => {
  it('agent 缺省 → 无地址；conversationId 缺省/=agent → agent；群聊 → conversationId~agent', () => {
    expect(runAddress(undefined, undefined)).toBeUndefined();
    expect(runAddress('a1', undefined)).toBe('a1');
    expect(runAddress('a1', 'a1')).toBe('a1');
    expect(runAddress('a1', 'g1')).toBe('g1~a1');
  });
});

describe('pairKey（M19 对桶键：排序 ~ 连接，自会话 = 对角线）', () => {
  it('两端排序后连接——参数序无关', () => {
    expect(pairKey('b', 'a')).toBe('a~b');
    expect(pairKey('a', 'b')).toBe('a~b');
  });
  it('a===b 即自会话对角线', () => {
    expect(pairKey('x', 'x')).toBe('x~x');
  });
});

describe('ARCHIVE_REVIEW_META / isArchiveReviewRun（机制 run 标记）', () => {
  it('标记键恒为 archive-review（wire 协议锁定）', () => {
    expect(ARCHIVE_REVIEW_META).toBe('archive-review');
  });
  it('仅 meta[ARCHIVE_REVIEW_META] === true 判为机制 run', () => {
    expect(isArchiveReviewRun({ [ARCHIVE_REVIEW_META]: true })).toBe(true);
    expect(isArchiveReviewRun({ [ARCHIVE_REVIEW_META]: false })).toBe(false);
    expect(isArchiveReviewRun({ [ARCHIVE_REVIEW_META]: 'true' })).toBe(false); // 字符串形态不放行
    expect(isArchiveReviewRun({})).toBe(false);
    expect(isArchiveReviewRun(undefined)).toBe(false);
  });
});

describe('normalizeToolSpecs（M21/D4 字典序规范化）', () => {
  const defs = [
    { name: 'zulu_tool', description: 'z' },
    { name: 'alpha_tool', description: 'a' },
    { name: 'mid_tool', description: 'm' },
  ];
  it('按工具名字典序输出，与注册序无关', () => {
    const names = normalizeToolSpecs(defs, undefined).map((t) => t.function.name);
    expect(names).toEqual(['alpha_tool', 'mid_tool', 'zulu_tool']);
  });
  it('names 白名单过滤后仍字典序；空清单 = 空集', () => {
    const names = normalizeToolSpecs(defs, ['zulu_tool', 'alpha_tool']).map((t) => t.function.name);
    expect(names).toEqual(['alpha_tool', 'zulu_tool']);
    expect(normalizeToolSpecs(defs, [])).toEqual([]);
  });
  it('shape：type=function，description/parameters 缺省省略', () => {
    expect(normalizeToolSpecs([{ name: 'bare' }], undefined)).toEqual([
      { type: 'function', function: { name: 'bare' } },
    ]);
    const withParams = normalizeToolSpecs(
      [{ name: 'p', parameters: { type: 'object' } }],
      undefined,
    );
    expect(withParams[0].function.parameters).toEqual({ type: 'object' });
  });
});

describe('maxSeqOf', () => {
  it('空集 / 全无 seq → undefined', () => {
    expect(maxSeqOf([])).toBeUndefined();
    expect(maxSeqOf([{}, {}])).toBeUndefined(); // 无 seq 字段的行忽略
  });

  it('取最大 seq；无 seq 行忽略；0 地板（非正 seq 不入选——seq 是 1 起单调计数器）', () => {
    expect(maxSeqOf([{ seq: 3 }, { seq: 7 }, { seq: 5 }])).toBe(7);
    expect(maxSeqOf([{ seq: 1 }, {}, { seq: 2 }])).toBe(2);
    expect(maxSeqOf([{ seq: -5 }, { seq: -1 }])).toBeUndefined(); // 0 地板：负值视同缺席
    expect(maxSeqOf([{ seq: -5 }, { seq: 4 }])).toBe(4);
    expect(maxSeqOf([{ seq: 0 }])).toBeUndefined(); // 0 不大于地板 0，视同缺席
    expect(maxSeqOf([{ seq: 0 }, { seq: 2 }])).toBe(2);
  });

  it('非 number 形态的 seq 忽略（宽容读取）', () => {
    expect(maxSeqOf([{ seq: '9' } as never])).toBeUndefined();
    expect(maxSeqOf([{ seq: '9' } as never, { seq: 4 }])).toBe(4);
  });
});
