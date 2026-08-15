// ============================================================
// @agentchat/edit/src/hashline.ts —— hashline 协议（v1 行级 + v2 文件级）
//
// 迁移自 src/plugins/builtin/tools/shared.ts 的 hashline 部分。
// 命名领域化：edit 引擎的哈希定位协议，可独立发布复用。
// ============================================================
import * as crypto from 'crypto';

const HASH_LENGTH = 4;

/** v1 行级哈希（向后兼容） */
export function hashLine(content: string): string {
  return crypto.createHash('sha256').update(content.replace(/\r$/, '')).digest('hex').slice(0, HASH_LENGTH);
}

/** v1 行级 Hashline 格式化 */
export function formatHashLine(lineNum: number, content: string): string {
  return `${lineNum}#${hashLine(content)}|${content}`;
}

/** 解析 v1 pos（行号#哈希） */
export function parseHashPos(pos: string): { lineNum: number; hash: string } {
  const m = pos.match(/^(\d+)#([0-9a-f]+)$/i);
  if (!m) throw new Error(`无效的 pos 格式 "${pos}"，应为 "行号#哈希"。`);
  return { lineNum: parseInt(m[1], 10), hash: m[2].toLowerCase() };
}

/** v2 文件级哈希标签（4 字符 hex）。归一化 \r\n → \n。 */
export function computeFileHash(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
}

/** [PATH#TAG] 头部 */
export function formatHashlineHeader(displayPath: string, tag: string): string {
  return `[${displayPath}#${tag}]`;
}

/** 行号:内容 */
export function formatNumberedLine(lineNum: number, text: string): string {
  return `${lineNum}:${text}`;
}

/** 解析 [PATH#TAG] 或 [PATH]，返回 { path, tag } */
export function parseHashlineHeader(line: string): { path: string; tag: string } | null {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const body = trimmed.slice(1, -1).trim();
  const hashIdx = body.lastIndexOf('#');
  return hashIdx >= 0
    ? { path: body.slice(0, hashIdx), tag: body.slice(hashIdx + 1) }
    : { path: body, tag: '' };
}
