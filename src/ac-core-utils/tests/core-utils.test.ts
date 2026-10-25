// ============================================================
// ac-core-utils：跨行协议纯函数（GROUP_HINT_META/isGroupHint、maxSeqOf、
// runAddress/pairKey/memberStreamKey/ARCHIVE_REVIEW_META/isArchiveReviewRun/
// normalizeToolSpecs)
// persona 解析词法测试住 tests/persona.test.ts（cr-321 随迁）
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  ARCHIVE_REVIEW_META,
  GROUP_HINT_META,
  isArchiveReviewRun,
  isGroupHint,
  maxSeqOf,
  memberStreamKey,
  normalizeToolSpecs,
  pairKey,
  runAddress,
  TITLE_MAX_LEN,
  cleanTitle,
  fallbackTitle,
  titleMaterialOf,
  titlePrompt,
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

describe('memberStreamKey（cr-4 成员私有流键：gid~member，member 恒最右）', () => {
  it('键值 = groupId~member 字面拼接（gid 禁 ~ 规约下右起解析无歧义）', () => {
    expect(memberStreamKey('g1', 'alice')).toBe('g1~alice');
    expect(memberStreamKey('fanout', 'b')).toBe('fanout~b');
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

const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

describe('会话标题词法（cr-672 下沉：生成面与派生面同口径）', () => {
  it('上限 24 字；超长回落补省略号（不切代理对）', () => {
    expect(TITLE_MAX_LEN).toBe(24);
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五';
    const title = fallbackTitle(long);
    expect(title).toHaveLength(25);
    expect(title.endsWith('…')).toBe(true);
    // 代理对（emoji）不切断：24 code unit 上限 = 12 个完整 emoji（+省略号）
    const emoji = '😀'.repeat(20);
    const cut = fallbackTitle(emoji);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).toBe('😀'.repeat(12) + '…');
  });
  it('材料行：跳过空行 / 日期快照行 / 路径与引用行，取首个「像发言」的行', () => {
    expect(titleMaterialOf('C:' + BS + 'repo' + BS + 'a.md' + NL + '分析文档反馈的问题')).toBe('分析文档反馈的问题');
    expect(titleMaterialOf('@preview/docs/spec.md' + NL + '补规格')).toBe('补规格');
    expect(titleMaterialOf('https://example.com/x' + NL + '看这个')).toBe('看这个');
    expect(titleMaterialOf('[当前时间] 2026-10-24 周五' + NL + '真正的内容')).toBe('真正的内容');
    expect(titleMaterialOf(NL + NL + '  第一行内容  ' + NL + '第二行')).toBe('第一行内容');
    // 全是路径 → 回落首个非空行（消息本身只有路径）
    expect(titleMaterialOf('C:' + BS + 'repo' + BS + 'a.md')).toBe('C:' + BS + 'repo' + BS + 'a.md');
  });
  it('fallbackTitle / cleanTitle 都从材料行出发；CRLF 不把 CR 留在标题里', () => {
    expect(fallbackTitle('【第二次测试】 ' + CR + NL + CR + NL + '继续')).toBe('【第二次测试】');
    expect(cleanTitle('「 会话标题 」')).toBe('会话标题');
    expect(cleanTitle('第一行' + NL + '第二行')).toBe('第一行');
    expect(cleanTitle('')).toBe('');
  });
  it('titlePrompt 含材料与上限说明；无 Agent 材料时不留占位段', () => {
    const withAgent = titlePrompt('用户消息甲', 'Agent 的思考');
    expect(withAgent).toContain('不超过24字');
    expect(withAgent).toContain('用户消息甲');
    expect(withAgent).toContain('Agent 的思考');
    const bare = titlePrompt('用户消息甲');
    expect(bare).not.toContain('Agent 的初步思考');
  });
});
