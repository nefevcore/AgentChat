// ============================================================
// ac-cdp-core/src/perceive.ts —— 感知层（M2）
//
// DOMSnapshot.captureSnapshot（扁平索引数组形态）→ 树重建 →
// 交互性过滤 → 可见性（layoutIndex -1 = 未绘制）→ 稳定 ref 编号
// → 序列化（[n]<tag role name> 截断形）。正文抽取：正文密度启发，
// 输出 markdown 化文本（绕过 innerText 对 shadow DOM/虚拟列表的短板）。
//
// ref 失稳处置（browser-cdp-plan §10）：索引只保证当帧有效；
// 动作执行前校验目标仍存在，失稳返回新索引让 LLM 重选。
// ============================================================
import type { CdpFlatNodes, CdpSnapshotDoc } from './protocol.ts';

export interface RefElement {
  ref: number;
  tag: string;
  role: string;
  name: string;
  /** 视口内坐标（点击用） */
  x: number;
  y: number;
  backendNodeId?: number;
}

/** 重建后的树节点（内部形态） */
interface TreeNode {
  nodeType: number;
  tag: string; // 大写标签名；'#text' 等
  text: string;
  attrs: Map<string, string>;
  bounds?: [number, number, number, number];
  backendNodeId?: number;
  children: TreeNode[];
}

const INTERACTIVE_TAGS = new Set([
  'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION', 'LABEL',
]);

/** 扁平索引数组 → 树（parentIndex 亲代关系；文档序天然保持）。
 * bounds 来自文档级 layout.nodeIndex 倒排（节点下标 → 布局条目）。 */
function buildTree(nodes: CdpFlatNodes, strings: string[], layout?: { nodeIndex: number[]; bounds: number[][] }): TreeNode | null {
  const n = nodes.parentIndex.length;
  const treeNodes: Array<TreeNode | null> = new Array(n).fill(null);
  // 布局倒排：nodeIndex[i] = 节点下标 → layouts[i].bounds
  const boundsOf = new Map<number, [number, number, number, number]>();
  if (layout) {
    for (let i = 0; i < layout.nodeIndex.length; i++) {
      const b = layout.bounds[i] ?? [];
      if (b.length === 4) boundsOf.set(layout.nodeIndex[i]!, [b[0]!, b[1]!, b[2]!, b[3]!]);
    }
  }
  let root: TreeNode | null = null;
  for (let i = 0; i < n; i++) {
    const nodeType = nodes.nodeType[i] ?? 0;
    const attrs = new Map<string, string>();
    const raw = nodes.attributes[i] ?? [];
    for (let k = 0; k + 1 < raw.length; k += 2) {
      attrs.set(String(strings[raw[k]] ?? ''), String(strings[raw[k + 1]] ?? ''));
    }
    const textIdx = nodes.textValue?.[i] ?? nodes.nodeValue?.[i] ?? -1;
    const node: TreeNode = {
      nodeType,
      tag: nodeType === 3 ? '#text' : String(strings[nodes.nodeName[i] ?? -1] ?? '').toUpperCase(),
      text: nodeType === 3 ? String(strings[textIdx] ?? '') : '',
      attrs,
      bounds: boundsOf.get(i),
      backendNodeId: nodes.backendNodeId[i],
      children: [],
    };
    treeNodes[i] = node;
    const parent = nodes.parentIndex[i] ?? -1;
    if (parent < 0 || !treeNodes[parent]) root = node;
    else treeNodes[parent]!.children.push(node);
  }
  return root;
}

/** 无障碍角色启发（不调 Accessibility 域——DOM 形状启发够 M2 用） */
function roleOf(tag: string, attrs: Map<string, string>): string {
  const role = attrs.get('role');
  if (role) return role;
  switch (tag) {
    case 'A': return attrs.has('href') ? 'link' : 'generic';
    case 'BUTTON': case 'SUMMARY': return 'button';
    case 'INPUT': {
      const t = attrs.get('type') ?? 'text';
      return t === 'checkbox' || t === 'radio' ? t : ('input_' + t);
    }
    case 'SELECT': return 'combobox';
    case 'TEXTAREA': return 'textbox';
    case 'OPTION': return 'option';
    default: return 'generic';
  }
}

/** 节点可读名（aria-label > alt > title > placeholder > 文本首段） */
function nameOf(node: TreeNode): string {
  const pick = node.attrs.get('aria-label') ?? node.attrs.get('alt') ?? node.attrs.get('title') ?? node.attrs.get('placeholder');
  if (pick) return pick;
  for (const c of node.children) {
    if (c.nodeType === 3 && c.text.trim()) return c.text.trim();
  }
  return '';
}

const MAX_REFS = 100;
const NAME_TRUNCATE = 60;

function inViewport(b: [number, number, number, number], vp: { width: number; height: number }): boolean {
  const [x, y, w, h] = b;
  if (w <= 0 || h <= 0) return false;
  return x < vp.width && y < vp.height && x + w > 0 && y + h > 0;
}

/** 从快照提取可交互元素索引（视口内、有 layout、非隐藏；ref 从 1 起文档序） */
export function extractElements(doc: CdpSnapshotDoc, viewport: { width: number; height: number }): RefElement[] {
  const strings = doc.strings;
  const entry = doc.documents[0];
  const root = buildTree(entry.nodes, strings, entry.layout);
  const out: RefElement[] = [];
  const walk = (node: TreeNode | null): void => {
    if (!node || out.length >= MAX_REFS) return;
    if (node.nodeType === 1) {
      const interactive = INTERACTIVE_TAGS.has(node.tag) || node.attrs.has('onclick');
      if (interactive && node.bounds && inViewport(node.bounds, viewport)) {
        const name = nameOf(node);
        if (name || node.tag !== 'LABEL') {
          out.push({
            ref: out.length + 1,
            tag: node.tag.toLowerCase(),
            role: roleOf(node.tag, node.attrs),
            name: name.length > NAME_TRUNCATE ? name.slice(0, NAME_TRUNCATE) + '…' : name,
            x: Math.round(node.bounds[0] + node.bounds[2] / 2),
            y: Math.round(node.bounds[1] + node.bounds[3] / 2),
            backendNodeId: node.backendNodeId,
          });
        }
      }
    }
    for (const c of node.children) walk(c);
  };
  walk(root);
  return out;
}

/** 元素索引序列化（LLM 可读行；role 与 tag 本义同则省略——button/button 冗余） */
const IMPLICIT_ROLE: Record<string, string> = { button: 'button', combobox: 'combobox', textbox: 'textbox', option: 'option', input_checkbox: 'checkbox', input_radio: 'radio' };
const isImplicitRole = (tag: string, role: string): boolean => IMPLICIT_ROLE[tag] === role || (tag === 'input' && role.startsWith('input_'));
export function serializeElements(refs: RefElement[], limit = 100): string[] {
  return refs.slice(0, limit).map((e) => `[${e.ref}] <${e.tag}${e.role !== 'generic' && !isImplicitRole(e.tag, e.role) ? ` role=${e.role}` : ''}>${e.name ? ` ${e.name}` : ''}`);
}

// ── 正文抽取（read）──────────────────────────────────────────

export interface ExtractedText {
  text: string;
  title: string;
}

/**
 * 正文抽取（正文密度启发）：跳过 script/style/nav/header/footer/aside/
 * noscript/svg/iframe/button/select/form，保留标题层级与链接文本的
 * markdown 化（# 前缀 / [text](url)）。
 */
export function extractText(doc: CdpSnapshotDoc, maxLen: number): ExtractedText {
  const strings = doc.strings;
  const docEntry = doc.documents[0];
  const nodes = docEntry.nodes;
  const title = docEntry.title !== undefined ? String(strings[docEntry.title] ?? '') : '';
  const root = buildTree(nodes, strings, docEntry.layout);
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME', 'TEMPLATE', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'SELECT', 'HEAD']);
  const lines: string[] = [];

  const collectText = (node: TreeNode): string =>
    node.nodeType === 3 ? node.text : node.children.map(collectText).join('');

  const walk = (node: TreeNode | null): void => {
    if (!node || lines.join('\n').length > maxLen * 2) return;
    if (node.nodeType === 3) {
      const t = node.text.trim();
      if (t) lines.push(t);
      return;
    }
    if (node.nodeType !== 1) {
      for (const c of node.children) walk(c); // document(9)/fragment(11)：深入
      return;
    }
    if (skip.has(node.tag)) return;
    const heading = /^H([1-6])$/.exec(node.tag);
    if (heading) {
      const inner = collectText(node).trim();
      if (inner) lines.push('#'.repeat(Number(heading[1])) + ' ' + inner);
      return;
    }
    const href = node.attrs.get('href');
    if (node.tag === 'A' && href) {
      const inner = collectText(node).trim();
      if (inner) {
        lines.push('[' + inner + '](' + (href.startsWith('javascript:') ? '' : href) + ')');
        return;
      }
    }
    if (node.tag === 'P' || node.tag === 'LI' || node.tag === 'BLOCKQUOTE' || node.tag === 'PRE' || node.tag === 'TD' || node.tag === 'TH') {
      const inner = collectText(node).replace(/\s+/g, ' ').trim();
      if (inner) lines.push(node.tag === 'LI' ? '- ' + inner : inner);
      return;
    }
    if (node.tag === 'BR') { lines.push(''); return; }
    for (const c of node.children) walk(c);
  };

  walk(root);
  const merged: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) {
      if (merged.length && merged[merged.length - 1] !== '') merged.push('');
      continue;
    }
    merged.push(t);
  }
  while (merged.length && merged[merged.length - 1] === '') merged.pop();
  let text = merged.join('\n');
  if (text.length > maxLen) text = text.slice(0, maxLen) + '…';
  return { text, title };
}
