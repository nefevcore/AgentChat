// ============================================================
// utils/pasteText.ts —— 粘贴文本归一纯函数（PromptEditor 文本粘贴用）
//
// 动机：输入框文档模型 = 纯文本段落（PM schema 仅 Document/Paragraph/
// Text），富文本粘贴若交给 PM 默认解析会产生两类失真：
//   · 空段 / <br> 边界被吞 —— 文本中间的多个换行遭压缩；
//   · <a href> 降级为锚文本 —— 粘贴链接只剩标题文字，URL 丢失。
// 归一模型 = 行（与编辑器 getText('\n') 同构）：
//   · 每个块级元素产出一组行（块与块之间恰一个换行，不叠边框换行）；
//   · <br> = 行内断行；<p><br></p> / 空块 = 恰一个空行（连续空行保留）；
//   · <a> 还原 href（锚文本与 href 等价时保原文；mailto: 剥前缀）；
//   · <pre> 的行逐字保留（缩进/连续空格不折叠——与普通行的空白归一隔离）；
//   · 块间游离的纯空白文本节点（HTML 缩进排版）不产生空行。
// 依赖 DOMParser（浏览器与 jsdom 均有）；clipboardText（文件尾，复制序列化
// 出口）另依赖 @tiptap/pm/model —— 仅类型，无运行时框架依赖。
// ============================================================
import type { Fragment } from '@tiptap/pm/model';

/** 块级元素集（一个块 = 至少一行；PRE 另行单独处理） */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CANVAS', 'DD', 'DIV', 'DL',
  'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'SECTION',
  'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

/** 不产生文本的元素 */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

/** 行记录：pre 行免于收尾空白归一（缩进逐字保留） */
interface Line { text: string; pre: boolean }

/** 块级元素 → 行序列（行内文本已折叠空白；pre 行原样） */
function blockLines(el: Element): Line[] {
  // 空块（无子节点）= 恰一个空行（Word 空段语义：每个空段是一行视觉空行）
  if (el.childNodes.length === 0) return [{ text: '', pre: false }];
  const lines: Line[] = [];
  let cur = '';
  const flush = () => { lines.push({ text: cur, pre: false }); cur = ''; };
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      cur += (child.nodeValue ?? '').replace(/\s+/g, ' ');
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const c = child as Element;
    if (c.tagName === 'BR') { flush(); continue; }
    if (SKIP_TAGS.has(c.tagName)) continue;
    if (c.tagName === 'PRE') {
      // pre：textContent 逐字拆行（代码块换行/缩进是内容而非排版）
      if (cur.trim() !== '') flush();
      for (const ln of (c.textContent || '').split('\n')) lines.push({ text: ln, pre: true });
      continue;
    }
    if (BLOCK_TAGS.has(c.tagName)) {
      // 容器块对子块透明：仅当有未落行的行内文本才先断行，
      // 不叠加入口空行（相邻块之间恰一个换行）
      if (cur.trim() !== '') flush();
      lines.push(...blockLines(c));
      continue;
    }
    // 行内元素：产出可能含 \n 的片段（<a> 内嵌 <br> 等）——拆入行序列
    const chunk = inlineText(c);
    if (chunk.includes('\n')) {
      cur += chunk;
      const parts = cur.split('\n');
      for (let i = 0; i < parts.length - 1; i++) lines.push({ text: parts[i], pre: false });
      cur = parts[parts.length - 1] ?? '';
    } else {
      cur += chunk;
    }
  }
  // 收尾：无子块产出且无尾随文本 → 本块自占一行（可为空行）
  if (cur.trim() !== '' || lines.length === 0) flush();
  return lines;
}

/** 行内元素 → 文本片段（<a> 还原 href、<img> 取 alt、其余递归） */
function inlineText(el: Element): string {
  if (el.tagName === 'IMG') return el.getAttribute('alt') ?? '';
  if (el.tagName === 'A') {
    const href = (el.getAttribute('href') ?? '').trim();
    const inner = inlineChildren(el);
    const flat = inner.replace(/\s+/g, ' ').trim();
    if (!href) return inner;
    if (flat === href) return flat;
    try {
      if (decodeURIComponent(href) === flat) return flat;
    } catch { /* 非法百分号序列 → URL 优先 */ }
    if (href.startsWith('mailto:')) return href.slice('mailto:'.length);
    return href;
  }
  return inlineChildren(el);
}

function inlineChildren(el: Element): string {
  let out = '';
  for (const ch of Array.from(el.childNodes)) {
    if (ch.nodeType === Node.TEXT_NODE) out += (ch.nodeValue ?? '').replace(/\s+/g, ' ');
    else if (ch.nodeType === Node.ELEMENT_NODE) {
      const c = ch as Element;
      if (c.tagName === 'BR') out += '\n';
      else if (!SKIP_TAGS.has(c.tagName)) out += inlineText(c);
    }
  }
  return out;
}

/**
 * 归一剪贴板文本：HTML 字符串 → 纯文本（编辑器 getText('\n') 口径）；
 * 非 HTML 输入原样直通。首尾空行去除，中间空行保留（不压缩换行）。
 * 仅用于外部源（内部回贴走 text/plain 直取——本编辑器口径零失真）。
 */
export function normalizePasteText(html: string): string {
  if (!html.includes('<')) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lines = blockLines(doc.body)
    .map(l => (l.pre ? l : { text: l.text.trim(), pre: false }));
  while (lines.length > 0 && lines[0].text === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].text === '') lines.pop();
  return lines.map(l => l.text).join('\n');
}

// ============================================================
// 复制序列化 —— 剪贴板 text/plain 出口（与粘贴归一互逆）
// ============================================================

/** 选区 Slice 内容 → 剪贴板纯文本：段落间恰一个换行（与编辑器
 *  getText('\n') 同构）。PM 默认 clipboardTextSerializer 用 "\n\n"
 *  块分隔（富文本段距语义），而输入框文档模型 = 纯文本段落
 *  （Shift+Enter = 一个换行）——默认口径会把输入框里的换行复制成
 *  空行，复制出去再粘回来换行翻倍。空段仍产空行（视觉与数据一致）。 */
export function clipboardText(content: Fragment): string {
  return content.textBetween(0, content.size, '\n');
}

/** 粘贴 HTML 根的 PM 开口深度（data-pm-slice="openStart openEnd ..."）。
 *  部分/整段选区从 PM 复制出来时首末段是开放段（open=1），外部源无此
 *  标记（null）。内部回贴据此走段融合语义，外部源走整段块插入。 */
export function pmSliceDepth(html: string): { openStart: number; openEnd: number } | null {
  if (!html.includes('data-pm-slice')) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of Array.from(doc.body.children)) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s|$)/.exec(el.getAttribute('data-pm-slice') ?? '');
    if (m) return { openStart: Number(m[1]), openEnd: Number(m[2]) };
  }
  return null;
}
