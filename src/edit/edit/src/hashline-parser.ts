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

import { parseHashlineHeader } from './hashline';

// ── 类型定义 ──

export type HashlineOp =
  | { kind: 'swap'; startLine: number; endLine: number; lines: string[] }
  | { kind: 'ins_pre'; anchorLine: number; lines: string[] }
  | { kind: 'ins_post'; anchorLine: number; lines: string[] }
  | { kind: 'ins_head'; lines: string[] }
  | { kind: 'ins_tail'; lines: string[] };

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
      } else if (opLine.trim() !== '' && !opLine.trimStart().startsWith('+')) {
        // 无法识别的 op 行：显式报错而非静默跳过（8/12 社区实测复现：
        // 缺冒号/格式错误的 SWAP 被静默丢弃 → ops 不完整 → 部分或全部操作未生效且返回 success）
        throw new Error(
          `Hashline 语法错误：第 ${i + 1} 行无法识别（"${opLine.trim().slice(0, 50)}"）。` +
          `支持：SWAP N.=M: / INS.PRE N: / INS.POST N: / INS.HEAD: / INS.TAIL:`
        );
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
];

function parseSingleOp(
  line: string, lineIdx: number, allLines: string[]
): { op: HashlineOp; nextIdx: number } | null {
  const trimmed = line.trimStart();
  if (!trimmed || trimmed.startsWith('+')) return null;

  // 未实现的 CUT/PASTE：显式报错（此前解析后被执行器静默忽略，操作无效且无提示）
  if (/^CUT\b|^PASTE\./i.test(trimmed)) {
    throw new Error(
      `Hashline 暂不支持 ${trimmed.split(/[\s:]/)[0].toUpperCase()} 操作。` +
      `删除行请用 SWAP 空 body（如 "SWAP 3.=3:"），插入请用 INS。`
    );
  }

  // 无行号操作（空 body 无意义 → 显式报错，杜绝静默丢弃）
  if (/^INS\.HEAD:/i.test(trimmed)) {
    return requireBody(allLines, lineIdx + 1, 'INS.HEAD', (body) => ({ kind: 'ins_head' as const, lines: body }));
  }
  if (/^INS\.TAIL:/i.test(trimmed)) {
    return requireBody(allLines, lineIdx + 1, 'INS.TAIL', (body) => ({ kind: 'ins_tail' as const, lines: body }));
  }

  // 带行号操作
  for (const { regex, kind } of OP_PATTERNS) {
    const m = trimmed.match(regex);
    if (!m) continue;

    switch (kind) {
      case 'swap':
        // SWAP 空 body = 删除该行范围（lines=[]），合法语义
        return parseBody(allLines, lineIdx + 1, (body) => ({
          kind: 'swap', startLine: +m[1], endLine: +m[2], lines: body,
        }), true);
      case 'ins_pre':
        return requireBody(allLines, lineIdx + 1, `INS.PRE ${m[1]}`, (body) => ({
          kind: 'ins_pre', anchorLine: +m[1], lines: body,
        }));
      case 'ins_post':
        return requireBody(allLines, lineIdx + 1, `INS.POST ${m[1]}`, (body) => ({
          kind: 'ins_post', anchorLine: +m[1], lines: body,
        }));
    }
  }

  return null;
}

/** 收集 + 前缀的 body 行。allowEmpty=true 时允许空 body（如 SWAP 删除语义）。 */
function parseBody<T>(
  allLines: string[], startIdx: number,
  build: (body: string[]) => T,
  allowEmpty = false,
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
  if (body.length > 0 || allowEmpty) {
    return { op: build(body), nextIdx: i };
  }
  return null;
}

/** 要求 op 必须有 body，否则显式报错（不再静默丢弃 op） */
function requireBody<T>(
  allLines: string[], startIdx: number, opLabel: string,
  build: (body: string[]) => T,
): { op: T; nextIdx: number } {
  const r = parseBody(allLines, startIdx, build);
  if (!r) {
    throw new Error(
      `Hashline 语法错误：${opLabel} 缺少 body 内容（需至少一行以 "+" 开头）。` +
      `要删除行请用 SWAP 空 body（如 "SWAP 3.=3:"）。`
    );
  }
  return r;
}
