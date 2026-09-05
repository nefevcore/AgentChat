// ============================================================
// input-mention.test.ts —— 快捷输入触发检测纯函数（utils/mention.ts）
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  detectMention,
  replaceMentionToken,
  mentionMatches,
  tokenizeMentionHighlights,
  buildHighlightSegments,
  formatFileMention,
} from '../src/utils/mention';

describe('detectMention', () => {
  it('空串/光标越界 → null', () => {
    expect(detectMention('', 0)).toBeNull();
    expect(detectMention('abc', 0)).toBeNull();
    expect(detectMention('abc', 4)).toBeNull(); // caret 越过文本尾
  });

  it('行首 / 与 @ 触发', () => {
    expect(detectMention('/', 1)).toEqual({ kind: 'slash', start: 0, query: '' });
    expect(detectMention('/ar', 3)).toEqual({ kind: 'slash', start: 0, query: 'ar' });
    expect(detectMention('@', 1)).toEqual({ kind: 'at', start: 0, query: '' });
    expect(detectMention('@Doc', 4)).toEqual({ kind: 'at', start: 0, query: 'Doc' });
  });

  it('空白后触发（换行/空格之后）', () => {
    // '看一下 /goal'：看0 下1 一2 ' '3 '/'4 g5..l8 → token [4,9)
    expect(detectMention('看一下 /goal', 9)).toEqual({ kind: 'slash', start: 4, query: 'goal' });
    expect(detectMention('a\n@文件', 5)).toEqual({ kind: 'at', start: 2, query: '文件' });
  });

  it('行中/URL/路径不触发（前字符非空白）', () => {
    expect(detectMention('https://x.com', 14)).toBeNull(); // / 前是 :
    expect(detectMention('a/b', 3)).toBeNull();
    expect(detectMention('mail@host', 9)).toBeNull();
    expect(detectMention('你好/stop', 8)).toBeNull(); // 前字符是文字
  });

  it('光标不在 token 尾 → null（token 必须结束于光标处）', () => {
    expect(detectMention('/goal 下一句', 9)).toBeNull(); // token 后已有内容
    expect(detectMention('/goal', 2)).toBeNull(); // 光标在触发符前
  });

  it('查询词含空白 → null（空格 = 离开快捷输入）', () => {
    expect(detectMention('/st p', 5)).toBeNull();
    expect(detectMention('@a b', 4)).toBeNull();
  });

  it('slash 查询词限英数与 -_；at 允许任意非空白（中文文件名）', () => {
    expect(detectMention('/技能', 3)).toBeNull();
    expect(detectMention('/pdf-export', 11)).toEqual({ kind: 'slash', start: 0, query: 'pdf-export' });
    expect(detectMention('@计划.md', 6)).toEqual({ kind: 'at', start: 0, query: '计划.md' });
  });

  it('# 触发（会话引用）：行首/空白后触发；标题查询词任意非空白；行中 # 不触发', () => {
    expect(detectMention('#', 1)).toEqual({ kind: 'hash', start: 0, query: '' });
    expect(detectMention('#周报', 3)).toEqual({ kind: 'hash', start: 0, query: '周报' });
    // '看看 #整理中的会话'：看0 看1 ' '2 '#'3 整4..话9 → token [3,10)
    expect(detectMention('看看 #整理中的会话', 10)).toEqual({ kind: 'hash', start: 3, query: '整理中的会话' });
    // 行中（前字符非空白）：C# 不误触发
    expect(detectMention('用C#写', 4)).toBeNull();
    // token 后已有内容（光标在句中）不触发
    expect(detectMention('#标题 正文', 4)).toBeNull();
  });
});

describe('replaceMentionToken', () => {
  it('替换触发符+查询词为插入文本', () => {
    // '请 /go'：0:'请' 1:' ' 2:'/' 3:'g' 4:'o' → token [2,5)
    expect(replaceMentionToken('请 /go', 2, 5, '/goal '))
      .toBe('请 /goal ');
    // 插入文本自带尾随空格 + 原文 token 后的分隔空格 = 双空格（如实替换）
    expect(replaceMentionToken('@Doc 说', 0, 4, '@/x/y.md '))
      .toBe('@/x/y.md  说');
  });

  it('命令执行：替换为空串（token 摘除）', () => {
    expect(replaceMentionToken('/stop', 0, 5, '')).toBe('');
    expect(replaceMentionToken('看 /stop', 2, 7, '')).toBe('看 ');
  });
});

describe('mentionMatches', () => {
  it('空查询全匹配；大小写不敏感包含', () => {
    expect(mentionMatches('anything', '')).toBe(true);
    expect(mentionMatches('PDF-Export', 'pdf')).toBe(true);
    expect(mentionMatches('pdf-export', 'EXP')).toBe(true);
    expect(mentionMatches('stop', 'arch')).toBe(false);
  });
});

describe('tokenizeMentionHighlights / buildHighlightSegments（overlay 语义化渲染）', () => {
  it('四类 token 各自命中并给出精确区间', () => {
    // '对比 @C:\\a\\b.md 和 @张三 的 /pdf-export 与 #周报(sid-1)，看 https://x.com'
    const text = '对比 @C:\\a\\b.md 和 @张三 的 /pdf-export 与 #周报(sid-1)，看 https://x.com';
    const tokens = tokenizeMentionHighlights(text);
    expect(tokens.map((t) => ({ kind: t.kind, raw: text.slice(t.start, t.end) }))).toEqual([
      { kind: 'file', raw: '@C:\\a\\b.md' },
      { kind: 'agent', raw: '@张三' },
      { kind: 'skill', raw: '/pdf-export' },
      { kind: 'session', raw: '#周报(sid-1)' }, // 中文标点不吞：，看 留在正文
    ]);
    // 不该命中的：URL（// 非空白界）
    expect(tokens.some((t) => text.slice(t.start, t.end).includes('x.com'))).toBe(false);
  });

  it('误触不命中：行中 a@b / C# / https:// / ## 标题', () => {
    expect(tokenizeMentionHighlights('mail a@b.com 用C#写')).toEqual([]);
    expect(tokenizeMentionHighlights('看 https://x.com/y 和 ## 标题')).toEqual([]);
  });

  it('中文标点截断：@张三，过来 / #周报(sid-1)，看 → 后文归正文；@后紧跟标点不成 token', () => {
    const at = tokenizeMentionHighlights('叫 @张三，过来');
    expect(at).toHaveLength(1);
    expect('叫 @张三，过来'.slice(at[0]!.start, at[0]!.end)).toBe('@张三');
    const hash = tokenizeMentionHighlights('参考 #周报(sid-1)，看下');
    expect(hash).toHaveLength(1);
    expect('参考 #周报(sid-1)，看下'.slice(hash[0]!.start, hash[0]!.end)).toBe('#周报(sid-1)');
    expect(tokenizeMentionHighlights('就这 @，好了')).toEqual([]); // @ 后紧跟中文标点
    // ASCII 标点不截（路径/文件名合法字符）
    const path = tokenizeMentionHighlights('看 @C:\\docs\\报告(1).txt 谢');
    expect('看 @C:\\docs\\报告(1).txt 谢'.slice(path[0]!.start, path[0]!.end)).toBe('@C:\\docs\\报告(1).txt');
  });

  it('引号路径（含未闭合）→ file；目录尾斜杠 → file', () => {
    const t1 = tokenizeMentionHighlights('看 @"C:\\my docs\\计划 v1');
    expect(t1).toEqual([{ start: 2, end: 2 + '@"C:\\my docs\\计划 v1'.length, kind: 'file' }]);
    const t2 = tokenizeMentionHighlights('@C:\\src/ 目录');
    expect(t2[0]?.kind).toBe('file');
    // 纯名称 → agent
    expect(tokenizeMentionHighlights('@张三 ')[0]?.kind).toBe('agent');
  });

  it('segments 交替纯文本/token 段并拼回原文', () => {
    const text = '用 /pdf-export 处理 @C:\\a.md';
    const segments = buildHighlightSegments(text);
    expect(segments.map((s) => s.kind ?? 'plain')).toEqual(['plain', 'skill', 'plain', 'file']);
    expect(segments.map((s) => s.text).join('')).toBe(text);
    // 无 token 文本 → 单纯文本段
    expect(buildHighlightSegments('普通文本')).toEqual([{ text: '普通文本' }]);
    expect(buildHighlightSegments('')).toEqual([]);
  });
});

describe('formatFileMention（文件引用插入格式——与 [引用约定] 同语法）', () => {
  it('无空格路径裸形态；含空格走 @"…" 引号形态（DSH 语法）', () => {
    expect(formatFileMention({ path: 'C:\\docs\\plan.md', kind: 'file' })).toBe('@C:\\docs\\plan.md');
    expect(formatFileMention({ path: 'C:\\my docs\\计划 v1.md', kind: 'file' })).toBe('@"C:\\my docs\\计划 v1.md"');
  });

  it('目录补尾斜杠；引号形态的目录保持引号开（补全可继续下钻）', () => {
    expect(formatFileMention({ path: 'C:\\src', kind: 'directory' })).toBe('@C:\\src/');
    expect(formatFileMention({ path: 'C:\\my docs', kind: 'directory' })).toBe('@"C:\\my docs/');
    // 已带分隔符的目录不双补
    expect(formatFileMention({ path: 'C:\\src/', kind: 'directory' })).toBe('@C:\\src/');
  });

  it('控制字符/内嵌引号 → null（语法无法安全表示）；preserveQuote 保持引号形态', () => {
    expect(formatFileMention({ path: 'C:\\a"b.md', kind: 'file' })).toBeNull();
    expect(formatFileMention({ path: 'C:\\a\x01b.md', kind: 'file' })).toBeNull();
    expect(formatFileMention({ path: 'C:\\plain.md', kind: 'file', }, true)).toBe('@"C:\\plain.md"');
  });

  it('引号形态与渲染层同口径：@"…" 染色为 file token', () => {
    const token = formatFileMention({ path: 'C:\\my docs\\a b.md', kind: 'file' })!;
    const highlights = tokenizeMentionHighlights(`看 ${token} 谢谢`);
    expect(highlights).toHaveLength(1);
    expect(highlights[0]).toMatchObject({ kind: 'file' });
    expect(`看 ${token} 谢谢`.slice(highlights[0]!.start, highlights[0]!.end)).toBe(token);
  });
});
