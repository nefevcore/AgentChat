// ============================================================
// edit / read 共享工具函数 —— Hashline 协议 v2
//
// v2 改进（参考 oh-my-pi hashline 实现）：
//   - 文件级哈希：read 输出 [PATH#TAG] 头部，edit 用 TAG 验证文件版本
//   - 纯行号定位：read 输出 "行号:内容"，edit 用行号编辑（哈希已验证文件一致）
//   - DSL patch 语言：edit 接受 patch DSL 字符串而非 JSON
//
// v1 兼容：保留行级 hash（formatHashLine / parseHashPos / hashLine）
//
// 参考：
//   https://ac.llmrank.top/common/hashline-edit-protocol/01-overview/
//   https://github.com/can1357/oh-my-pi
// ============================================================

import * as crypto from 'crypto';

// ── 常量 ──

/** 哈希截断长度（4 字符 hex，约 65K 空间，结合文件路径足够区分） */
const HASH_LENGTH = 4;

// ── v1 行级哈希（保留向后兼容） ──

/** 计算单行内容的内容哈希 */
export function hashLine(content: string): string {
  const normalized = content.replace(/\r$/, '');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
}

/** v1 格式：行号#哈希| 内容 */
export function formatHashLine(lineNum: number, content: string): string {
  return `${lineNum}#${hashLine(content)}|${content}`;
}

/** v1 解析 pos 参数 */
export function parseHashPos(pos: string): { lineNum: number; hash: string } {
  const match = pos.match(/^(\d+)#([0-9a-f]+)$/i);
  if (!match) {
    throw new Error(`无效的 pos 格式 "${pos}"，应为 "行号#哈希"（如 "22#a1b2"）。`);
  }
  return { lineNum: parseInt(match[1], 10), hash: match[2].toLowerCase() };
}

// ── v2 文件级哈希 ──

/**
 * 计算整个文件的哈希标签（4 字符 hex）。
 * 归一化：剥离 \r，统一行尾为 \n。
 * 同一文件内容 → 同一 TAG，任何修改 → TAG 变化。
 */
export function computeFileHash(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
}

/**
 * Hashline 文件头部：[PATH#TAG]
 * 如 [src/foo.ts#a1b2]
 */
export function formatHashlineHeader(displayPath: string, tag: string): string {
  return `[${displayPath}#${tag}]`;
}

/**
 * Hashline 行号格式：行号:内容
 * 如 41:def alpha():
 */
export function formatNumberedLine(lineNum: number, text: string): string {
  return `${lineNum}:${text}`;
}

/**
 * 解析 Hashline 头部 [PATH#TAG]，返回 { path, tag }。
 * 也兼容无 TAG 的头部 [PATH]（tag 为空字符串）。
 */
export function parseHashlineHeader(line: string): { path: string; tag: string } | null {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const body = trimmed.slice(1, -1).trim();
  const hashIdx = body.lastIndexOf('#');
  if (hashIdx >= 0) {
    return { path: body.slice(0, hashIdx), tag: body.slice(hashIdx + 1) };
  }
  return { path: body, tag: '' };
}

// ── DSL patch 语言常量 ──

/** Hashline patch 操作类型 */
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

/** Hashline patch 节：一个 [PATH#TAG] 头部 + 若干操作 */
export interface HashlineSection {
  path: string;
  tag: string;
  ops: HashlineOp[];
}

/** 解析 Hashline patch DSL 文本 */
export function parseHashlinePatch(input: string, cwd: string): HashlineSection[] {
  const sections: HashlineSection[] = [];
  const lines = input.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();

    // 跳过信封标记和空行
    if (line === '*** Begin Patch' || line === '*** End Patch' || line.trim() === '') {
      i++;
      continue;
    }

    // 检测 [PATH#TAG] 头部
    const header = parseHashlineHeader(line);
    if (!header || !header.path) {
      i++;
      continue;
    }

    const ops: HashlineOp[] = [];
    i++;

    // 解析操作块
    while (i < lines.length) {
      const opLine = lines[i].trimEnd();
      if (opLine.trim() === '') { i++; continue; }

      // 检查是否进入下一个 section
      const nextHeader = parseHashlineHeader(opLine);
      if (nextHeader && nextHeader.path) break;

      const parsed = parseOp(opLine, i, lines);
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

/** 解析单个操作行 */
function parseOp(
  line: string, _lineIdx: number, allLines: string[]
): { op: HashlineOp; nextIdx: number } | null {
  const trimmed = line.trimStart();
  if (!trimmed || trimmed.startsWith('+')) return null; // body line

  // SWAP N.=M:  — 替换行范围
  let m = trimmed.match(/^SWAP\s+(\d+)\.=(\d+):$/i);
  if (m) {
    return parseBodyLines(allLines, _lineIdx + 1, (body) => ({
      kind: 'swap' as const,
      startLine: parseInt(m![1], 10),
      endLine: parseInt(m![2], 10),
      lines: body,
    }));
  }

  // INS.PRE N:  — 在第 N 行前插入
  m = trimmed.match(/^INS\.PRE\s+(\d+):$/i);
  if (m) {
    return parseBodyLines(allLines, _lineIdx + 1, (body) => ({
      kind: 'ins_pre' as const,
      anchorLine: parseInt(m![1], 10),
      lines: body,
    }));
  }

  // INS.POST N:  — 在第 N 行后插入
  m = trimmed.match(/^INS\.POST\s+(\d+):$/i);
  if (m) {
    return parseBodyLines(allLines, _lineIdx + 1, (body) => ({
      kind: 'ins_post' as const,
      anchorLine: parseInt(m![1], 10),
      lines: body,
    }));
  }

  // INS.HEAD:  — 文件头部插入
  if (/^INS\.HEAD:/i.test(trimmed)) {
    return parseBodyLines(allLines, _lineIdx + 1, (body) => ({
      kind: 'ins_head' as const,
      lines: body,
    }));
  }

  // INS.TAIL:  — 文件尾部追加
  if (/^INS\.TAIL:/i.test(trimmed)) {
    return parseBodyLines(allLines, _lineIdx + 1, (body) => ({
      kind: 'ins_tail' as const,
      lines: body,
    }));
  }

  // CUT N.=M:  — 剪切行范围到剪贴板（暂不支持，记录）
  m = trimmed.match(/^CUT\s+(\d+)\.=(\d+):$/i);
  if (m) {
    // 跳过后续 body lines（CUT 没有 body）
    return { op: { kind: 'cut', startLine: parseInt(m[1], 10), endLine: parseInt(m[2], 10) }, nextIdx: _lineIdx + 1 };
  }

  // PASTE.* 系列 — 跳过（需要剪贴板支持，暂不实现）
  m = trimmed.match(/^PASTE\.(PRE|POST)\s+(\d+):$/i);
  if (m) {
    return parseBodyLines(allLines, _lineIdx + 1, (body) => ({
      kind: m![1].toUpperCase() === 'PRE' ? 'paste_pre' : 'paste_post',
      anchorLine: parseInt(m![2], 10),
      lines: body,
    }));
  }
  if (/^PASTE\.HEAD:/i.test(trimmed)) {
    return parseBodyLines(allLines, _lineIdx + 1, (body) => ({ kind: 'paste_head', lines: body }));
  }
  if (/^PASTE\.TAIL:/i.test(trimmed)) {
    return parseBodyLines(allLines, _lineIdx + 1, (body) => ({ kind: 'paste_tail', lines: body }));
  }

  return null;
}

/** 收集以 + 开头的 body 行 */
function parseBodyLines<T>(
  allLines: string[], startIdx: number,
  build: (body: string[]) => T,
): { op: T; nextIdx: number } | null {
  const body: string[] = [];
  let i = startIdx;
  while (i < allLines.length) {
    const l = allLines[i];
    if (l.startsWith('+')) {
      body.push(l.slice(1)); // 去掉 + 前缀
      i++;
    } else if (l.trim() === '') {
      i++;
    } else {
      break;
    }
  }
  if (body.length === 0) return null;
  return { op: build(body), nextIdx: i };
}
