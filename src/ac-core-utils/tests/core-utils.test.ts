// ============================================================
// ac-core-utils：跨行协议纯函数（GROUP_HINT_META/isGroupHint、maxSeqOf）
// ============================================================
import { describe, it, expect } from 'vitest';
import { GROUP_HINT_META, isGroupHint, maxSeqOf } from '../src/index.ts';

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
