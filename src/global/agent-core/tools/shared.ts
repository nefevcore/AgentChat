// ============================================================
// edit / read 共享工具函数 —— Hashline 协议
//
// Hashline 协议（内容哈希编辑协议）：
//   - read 输出格式：行号#哈希| 内容
//   - edit 定位格式：行号#哈希（pos 参数）
//   - 哈希：SHA-256 截断 4 字符（行号 + 短哈希 = 足够区分）
//
// 参考：https://ac.llmrank.top/common/hashline-edit-protocol/01-overview/
// ============================================================

import * as crypto from 'crypto';

/** 哈希截断长度（2-4 字符，协议推荐） */
const HASH_LENGTH = 4;

/** 计算单行内容的内容哈希（行末 \r 被剥离以保证跨平台一致） */
export function hashLine(content: string): string {
  const normalized = content.replace(/\r$/, '');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
}

/**
 * Hashline 格式化：将行号和内容组合为 Hashline 格式。
 * @returns "行号#哈希| 内容" （如 "11#a1b2| function hello() {"）
 */
export function formatHashLine(lineNum: number, content: string): string {
  return `${lineNum}#${hashLine(content)}|${content}`;
}

/**
 * 解析 pos 参数（"行号#哈希" 格式）。
 * @returns { lineNum: 1-based 行号, hash: 哈希字符串 }
 * @throws 如果格式无效
 */
export function parseHashPos(pos: string): { lineNum: number; hash: string } {
  const match = pos.match(/^(\d+)#([0-9a-f]+)$/i);
  if (!match) {
    throw new Error(
      `无效的 pos 格式 "${pos}"，应为 "行号#哈希"（如 "22#a1b2"）。请使用 read(lineHash=true) 重新读取文件获取正确格式。`
    );
  }
  return { lineNum: parseInt(match[1], 10), hash: match[2].toLowerCase() };
}
