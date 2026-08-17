// ============================================================
// @agentchat/edit —— 模糊匹配索引回映射 + 末尾无换行 diff 边界回归测试
//
// 保护 2026-08-17 修复：
//  P0-1 模糊匹配 Level 1 索引偏移（impc-shyy-approval 8/14 报告）：
//      normalizeForFuzzyMatch(trimEnd) 会删除行尾空白改变字符串长度，
//      旧实现直接返回归一化后内容的 index 用于原始 content 切片，
//      当匹配目标之前存在被 trim 的行尾空白时替换位置偏移，
//      导致内容错乱拼接（新记录与旧记录粘在同一行 / 内容残留）。
//  P0-2 末尾无换行文件替换最后一行时 diff 行范围少算 +1，
//      删除行/新增行缺失导致 diff 显示错乱。
// ============================================================
import { describe, expect, it } from 'vitest';
import { fuzzyFindText, normalizeForFuzzyMatch } from '../src/fuzzy-match';
import { generateIncrementalDiff } from '../src/diff';

describe('fuzzyFindText Level 1 索引回映射（P0-1）', () => {
  it('匹配目标之前存在行尾空白时，返回原始 content 中的正确位置', () => {
    // 第 2 行行尾有 3 个空格；oldText 用弯引号触发 Level 1（trimEnd）模糊匹配
    const content = '# 笔记\n- 记录1: 已完成巡检项   \n- 记录2: it\'s a test';
    const oldText = '- 记录2: it’s a test'; // 弯引号 ’ (U+2019)

    const r = fuzzyFindText(content, oldText);
    expect(r.found).toBe(true);
    expect(r.usedFuzzyMatch).toBe(true);
    expect(r.fuzzyLevel).toBe(1);
    // 映射后的 index 必须落在原始 content 中 oldText 归一化后的实际位置
    expect(r.index).toBe(content.indexOf("- 记录2: it's a test"));
    // 切片验证：从返回位置截取应与归一化 oldText 等长且内容一致
    const matchedLen = normalizeForFuzzyMatch(oldText, false).length;
    expect(content.slice(r.index, r.index + matchedLen)).toBe("- 记录2: it's a test");
  });

  it('无行尾空白时 Level 1 索引映射与精确匹配一致', () => {
    const content = '# 笔记\n- 记录1: 已完成巡检项\n- 记录2: it\'s a test';
    const oldText = '- 记录2: it’s a test';
    const r = fuzzyFindText(content, oldText);
    expect(r.found).toBe(true);
    expect(r.fuzzyLevel).toBe(1);
    expect(r.index).toBe(content.indexOf("- 记录2: it's a test"));
  });

  it('多行内容中间行存在行尾空白时映射正确', () => {
    const content = 'a\nb   \nc\nd it\'s x'; // 第 2 行行尾 3 空格，目标行用直引号
    const exact = content.indexOf("d it's x"); // 直引号精确匹配位置
    // 弯引号版本走 Level 1
    const r = fuzzyFindText(content, 'd it’s x');
    expect(r.found).toBe(true);
    expect(r.fuzzyLevel).toBe(1);
    expect(r.index).toBe(exact);
  });
});

describe('generateIncrementalDiff 末尾无换行边界（P0-2）', () => {
  it('替换无换行文件最后一行时 diff 完整显示删除行与新增行', () => {
    const oldContent = '# 笔记\n- 记录1: 已完成巡检项\n- 记录2: 定时器正常'; // 无尾换行
    const newText = '- 记录2: 定时器正常\n- 记录3: 新增巡检项';
    const newContent = '# 笔记\n- 记录1: 已完成巡检项\n' + newText; // 无尾换行

    // 编辑位置：oldText 命中第 3 行（index = 第 3 行起始）
    const oldCharStart = oldContent.indexOf('- 记录2: 定时器正常');
    const editPositions = [{
      oldCharStart,
      oldCharLen: '- 记录2: 定时器正常'.length,
      newCharLen: newText.length,
    }];

    const { diff, firstChangedLine } = generateIncrementalDiff(oldContent, newContent, editPositions);
    expect(firstChangedLine).toBe(3);
    // 必须同时包含 -3（删除原第 3 行）与 +3/+4（新增两行）
    expect(diff).toContain('- 3 - 记录2: 定时器正常');
    expect(diff).toContain('+ 3 - 记录2: 定时器正常');
    expect(diff).toContain('+ 4 - 记录3: 新增巡检项');
  });

  it('替换末尾带换行文件的最后一行时 diff 正常（回归保护）', () => {
    const oldContent = '# 笔记\n- 记录1: 已完成巡检项\n- 记录2: 定时器正常\n';
    const newText = '- 记录2: 定时器正常\n- 记录3: 新增巡检项';
    const newContent = '# 笔记\n- 记录1: 已完成巡检项\n' + newText + '\n';

    const oldCharStart = oldContent.indexOf('- 记录2: 定时器正常');
    const editPositions = [{
      oldCharStart,
      oldCharLen: '- 记录2: 定时器正常'.length,
      newCharLen: newText.length,
    }];

    const { diff, firstChangedLine } = generateIncrementalDiff(oldContent, newContent, editPositions);
    expect(firstChangedLine).toBe(3);
    expect(diff).toContain('- 3 - 记录2: 定时器正常');
    expect(diff).toContain('+ 3 - 记录2: 定时器正常');
    expect(diff).toContain('+ 4 - 记录3: 新增巡检项');
  });
});
