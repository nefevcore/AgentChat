// @vitest-environment jsdom
// ============================================================
// ac-client-ui-conversation/tests/paste-text.test.ts ——
// 粘贴文本归一（normalizePasteText）单测
//
// 覆盖（两个用户报告的失真 + 基线语义）：
//   · 富文本多换行保留：空段/连续 <br> 不被压缩（问题 1）；
//   · 链接还原 URL：<a> 锚文本 ≠ href → 粘出 URL（问题 2）；
//   · 纯文本直通：无标签输入原样返回；
//   · <pre> 代码块：换行与缩进逐字保留；
//   · 块边界 → 换行：<p>/<div>/<li> 等块级元素间生成换行。
//   · 收尾归一 trimPastedText：整段首尾空白去除（纯文本源主路径 +
//     <pre> 首尾兜底；中间空行/缩进保留）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { normalizePasteText, trimPastedText } from '../client/pasteText.ts';

describe('normalizePasteText', () => {
  it('纯文本直通：无标签输入原样返回', () => {
    expect(normalizePasteText('第一行\n\n\n第三行')).toBe('第一行\n\n\n第三行');
    expect(normalizePasteText('a < b 含尖括号文本')).toBe('a < b 含尖括号文本');
  });

  it('问题1：富文本多换行保留——连续空段不被压缩', () => {
    const html = '<meta charset="utf-8"><p>第一段</p><p><br></p><p><br></p><p>第二段</p>';
    expect(normalizePasteText(html)).toBe('第一段\n\n\n第二段');
  });

  it('问题1：连续 <br> 产出的多个换行保留', () => {
    const html = '<p>行1<br><br><br>行2</p>';
    expect(normalizePasteText(html)).toBe('行1\n\n\n行2');
  });

  it('问题1：Word 风格空段（<p>&nbsp;</p>）保留为空行', () => {
    const html = '<p>段落一</p><p>&nbsp;</p><p>段落二</p>';
    expect(normalizePasteText(html)).toBe('段落一\n\n段落二');
  });

  it('问题2：链接还原 URL——锚文本是标题时粘出 URL', () => {
    const html = '<a href="https://example.com/page">Example 页面标题</a>';
    expect(normalizePasteText(html)).toBe('https://example.com/page');
  });

  it('问题2：锚文本与 href 相同的链接保原文（不重复）', () => {
    const html = '见 <a href="https://example.com">https://example.com</a> 详情';
    expect(normalizePasteText(html)).toBe('见 https://example.com 详情');
  });

  it('问题2：mailto 链接 → 邮箱地址', () => {
    const html = '<a href="mailto:user@example.com">给用户发信</a>';
    expect(normalizePasteText(html)).toBe('user@example.com');
  });

  it('链接在富文本正文中：URL 与周围文本正确衔接', () => {
    const html = '<p>参考 <a href="https://docs.example.com/guide">入门指南</a> 开始</p>';
    expect(normalizePasteText(html)).toBe('参考 https://docs.example.com/guide 开始');
  });

  it('<pre> 代码块：换行与缩进逐字保留', () => {
    const html = '<pre>const a = 1;\n    const b = 2;</pre>';
    expect(normalizePasteText(html)).toBe('const a = 1;\n    const b = 2;');
  });

  it('块级边界 → 换行：<div>/<li>/<h1> 各成一行', () => {
    const html = '<div>甲</div><div>乙</div><ul><li>项一</li><li>项二</li></ul>';
    expect(normalizePasteText(html)).toBe('甲\n乙\n项一\n项二');
  });

  it('问题1：空块 = 一行空行（Word 空段语义，连续空块逐个保留）', () => {
    const html = '<p>甲</p><p></p><p></p><p>乙</p>';
    expect(normalizePasteText(html)).toBe('甲\n\n\n乙');
  });

  it('脚本/样式/模板不产生文本', () => {
    const html = '<p>正文</p><script>evil()</script><style>p{}</style>';
    expect(normalizePasteText(html)).toBe('正文');
  });

  it('收尾归一：纯文本源首尾空白（空格/换行/制表/全角空格）去除，中间保留', () => {
    expect(trimPastedText('  \n\t第一行\n\n  第二行  \n\n')).toBe('第一行\n\n  第二行');
    expect(trimPastedText('\u3000\u00a0x\u3000')).toBe('x');
    expect(trimPastedText('正文')).toBe('正文');
  });

  it('收尾归一：纯空白/空串 → 空串（粘贴侧吞掉，不插入空段）', () => {
    expect(trimPastedText('   \n\t ')).toBe('');
    expect(trimPastedText('')).toBe('');
  });

  it('收尾归一链路：<pre> 首尾空白兜底去除，中间缩进逐字保留', () => {
    const html = '<pre>\n  code line\n    indented\n</pre>';
    expect(trimPastedText(normalizePasteText(html))).toBe('code line\n    indented');
  });
});
