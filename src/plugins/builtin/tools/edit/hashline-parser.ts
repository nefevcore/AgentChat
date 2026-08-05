// ============================================================
// hashline-parser.ts —— Hashline DSL patch 语言解析器
//
// 解析 oh-my-pi 风格的 patch 文本为结构化操作列表。
//
// DSL 格式：
//   [PATH#TAG]         ← 文件头部（TAG 来自 read/write 输出）
//   SWAP N.=M:         ← 替换第 N~M 行
//   INS.PRE N:         ← 在第 N 行前插入
//   INS.POST N:        ← 在第 N 行后插入
//   INS.HEAD:          ← 文件开头插入
//   INS.TAIL:          ← 文件末尾追加
//   +body line         ← 替换/插入内容（+ 前缀）
// ============================================================

import { parseHashlineHeader } from '../shared';

// ── 类型定义 ──

export type HashlineOp =
  | { kind: 'swap'; startLine: number; endLine: number; lines: string[] }
  | { kind: 'ins_pre'; anchorLine: number; lines: string[] }
  | { kind: 'ins_post'; anchorLine: number; lines: string[] }
  | { kind: 'ins_head'; lines: string[] }
  | { kind: 'ins_tail'; lines: string[] }
  | { kind: 'cut'; startLine: number; endLine: number }
  | { kind: 'paste_pre'; anchorLine: number; lines: string[] }
  | { kind: 'paste_post'; anchorLine: number; lines: string[] }
  | { kind: 'paste_head'; lines: string[] }
  | { kind: 'paste_tail'; lines: string[] };

export interface HashlineSection {
  path: string;
  tag: string;
  ops: HashlineOp[];
}

// ── 主解析函数 ──

/** 解析 Hashline patch DSL 文本为节列表 */
export function parseHashlinePatch(input: string): HashlineSection[] {
  const sections: HashlineSection[] = [];
  const lines = input.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();

    if (line === '*** Begin Patch' || line === '*** End Patch' || line.trim() === '') {
      i++;
      continue;
    }

    const header = parseHashlineHeader(line);
    if (!header?.path) { i++; continue; }

    const ops: HashlineOp[] = [];
    i++;

    while (i < lines.length) {
      const opLine = lines[i].trimEnd();
      if (opLine.trim() === '') { i++; continue; }

      const nextHeader = parseHashlineHeader(opLine);
      if (nextHeader?.path) break;

      const parsed = parseSingleOp(opLine, i, lines);
      if (parsed) {
        ops.push(parsed.op);
        i = parsed.nextIdx;
      } else {
        i++;
      }
    }

    sections.push({ path: header.path, tag: header.tag, ops });
  }

  return sections;
}

// ── 操作行解析 ──

const OP_PATTERNS: { regex: RegExp; kind: string }[] = [
  { regex: /^SWAP\s+(\d+)\.=(\d+):$/i,     kind: 'swap' },
  { regex: /^INS\.PRE\s+(\d+):$/i,          kind: 'ins_pre' },
  { regex: /^INS\.POST\s+(\d+):$/i,         kind: 'ins_post' },
  { regex: /^CUT\s+(\d+)\.=(\d+):$/i,       kind: 'cut' },
  { regex: /^PASTE\.(PRE|POST)\s+(\d+):$/i, kind: 'paste_rel' },
];

function parseSingleOp(
  line: string, lineIdx: number, allLines: string[]
): { op: HashlineOp; nextIdx: number } | null {
  const trimmed = line.trimStart();
  if (!trimmed || trimmed.startsWith('+')) return null;

  // 无行号操作
  if (/^INS\.HEAD:/i.test(trimmed)) {
    return parseBody(allLines, lineIdx + 1, (body) => ({ kind: 'ins_head' as const, lines: body }));
  }
  if (/^INS\.TAIL:/i.test(trimmed)) {
    return parseBody(allLines, lineIdx + 1, (body) => ({ kind: 'ins_tail' as const, lines: body }));
  }
  if (/^PASTE\.HEAD:/i.test(trimmed)) {
    return parseBody(allLines, lineIdx + 1, (body) => ({ kind: 'paste_head' as const, lines: body }));
  }
  if (/^PASTE\.TAIL:/i.test(trimmed)) {
    return parseBody(allLines, lineIdx + 1, (body) => ({ kind: 'paste_tail' as const, lines: body }));
  }

  // 带行号操作
  for (const { regex, kind } of OP_PATTERNS) {
    const m = trimmed.match(regex);
    if (!m) continue;

    switch (kind) {
      case 'swap':
        return parseBody(allLines, lineIdx + 1, (body) => ({
          kind: 'swap', startLine: +m[1], endLine: +m[2], lines: body,
        }));
      case 'ins_pre':
        return parseBody(allLines, lineIdx + 1, (body) => ({
          kind: 'ins_pre', anchorLine: +m[1], lines: body,
        }));
      case 'ins_post':
        return parseBody(allLines, lineIdx + 1, (body) => ({
          kind: 'ins_post', anchorLine: +m[1], lines: body,
        }));
      case 'cut':
        return { op: { kind: 'cut', startLine: +m[1], endLine: +m[2] }, nextIdx: lineIdx + 1 };
      case 'paste_rel':
        return parseBody(allLines, lineIdx + 1, (body) => ({
          kind: m[1].toUpperCase() === 'PRE' ? 'paste_pre' : 'paste_post',
          anchorLine: +m[2], lines: body,
        }));
    }
  }

  return null;
}

/** 收集 + 前缀的 body 行 */
function parseBody<T>(
  allLines: string[], startIdx: number,
  build: (body: string[]) => T,
): { op: T; nextIdx: number } | null {
  const body: string[] = [];
  let i = startIdx;
  while (i < allLines.length) {
    const l = allLines[i];
    if (l.startsWith('+')) {
      body.push(l.slice(1));
      i++;
    } else if (l.trim() === '') {
      i++;
    } else {
      break;
    }
  }
  return body.length > 0 ? { op: build(body), nextIdx: i } : null;
}
