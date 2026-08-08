// ============================================================
// src/plugins/builtin/tools/shared.ts —— 内置工具共享辅助
//
// 迁移自旧 mod 的 tools/shared.ts + 沙箱路径解析（原 core/config 的 resolveSafePath）
// + token 估算/安全截断（原 utils/tokens）。
//
// 内容：
//   · workspaceDir / workspaceRoot —— 工作区根解析（AGENTCHAT_WORKSPACE 覆盖）
//   · getAllowedPaths / resolveSafePath —— 沙箱路径解析（security.allowedPaths 白名单）
//   · estimateTokens / safeTruncate / safeClipByTokens —— token 估算与 UTF-16 安全截断
//   · hashline 协议（v1 行级 + v2 文件级哈希 / 格式化 / 解析，参考 oh-my-pi）
//
// 依赖方向：仅依赖 Node 内置 + @agents/config 类型。
// ============================================================

import * as path from 'path';
import * as crypto from 'crypto';
import { getNamespaceConfig } from '@agents/config';
import { NS_SECURITY } from '../namespaces';
import type { AgentConfig } from '@agents/config';

// ============================================================
// 工作区与沙箱
// ============================================================

/** 工作根目录（相对解析基准） */
export function workspaceDir(): string {
  return process.env.AGENTCHAT_WORKSPACE ?? 'workspace/default';
}

/** 读取路径穿透白名单（命名空间 NS_SECURITY；write/edit/bash 内置工具共享管控） */
export function getAllowedPaths(config: AgentConfig): string[] | undefined {
  const paths = getNamespaceConfig(config, NS_SECURITY).allowedPaths;
  return Array.isArray(paths) ? (paths as string[]) : undefined;
}

/** 工作区根绝对路径 */
export function workspaceRoot(): string {
  return path.resolve(process.cwd(), workspaceDir());
}

/**
 * 沙箱路径解析：目标必须落在 workspaceDir 或 security.allowedPaths 内。
 * @throws 越界抛错
 */
export function resolveSafePath(config: AgentConfig, p: string): string {
  const root = workspaceRoot();
  const allowed = getAllowedPaths(config);
  const roots = [root, ...(allowed ?? []).map(a => (path.isAbsolute(a) ? a : path.resolve(root, a)))];
  const target = path.resolve(root, p);
  const ok = roots.some(r => target === r || target.startsWith(r + path.sep));
  if (!ok) throw new Error(`路径越界（沙箱限制）：${p}`);
  return target;
}

// ============================================================
// token 估算 / UTF-16 安全截断（照搬旧 utils/tokens）
// ============================================================

/** 估算文本 token 数（CJK 0.6 / 其他 0.3，近似值用于阈值判断） */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    tokens += /[\u4e00-\u9fff]/.test(ch) ? 0.6 : 0.3;
  }
  return Math.ceil(tokens);
}

/** 匹配 lone surrogate（孤立的高/低代理项） */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** 将文本中的 lone surrogate 替换为 U+FFFD（纵深防御） */
export function sanitizeSurrogates(text: string): string {
  if (!text) return text;
  return text.replace(LONE_SURROGATE_RE, '\uFFFD');
}

/** 判断字符是否为 high surrogate（代理对前半） */
function isHighSurrogate(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0xD800 && code <= 0xDBFF;
}

/** 按 code unit 长度安全截断：不会切断 surrogate pair */
export function safeTruncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text;
  let end = maxLen;
  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) {
      end -= 1;
    }
  }
  return text.slice(0, end);
}

/**
 * 按 token 预算安全截取（keepTail=true 保留尾部，false 保留头部）。
 * 代理对（high+low）作为一个单位计入 token、完整拼接。
 */
export function safeClipByTokens(text: string, budgetTokens: number, keepTail: boolean): string {
  if (!text) return '';
  if (estimateTokens(text) <= budgetTokens) return text;

  const isCjk = (ch: string) => /[\u4e00-\u9fff]/.test(ch);
  const isHigh = (code: number) => code >= 0xD800 && code <= 0xDBFF;
  const isLow = (code: number) => code >= 0xDC00 && code <= 0xDFFF;
  let out = '';
  let tokens = 0;
  const markerMargin = 1;

  // 取当前位置的完整字符（代理对或单 code unit）
  const charAt = (i: number): string => {
    const code = text.charCodeAt(i);
    if (isHigh(code) && i + 1 < text.length && isLow(text.charCodeAt(i + 1))) {
      return text[i] + text[i + 1];
    }
    return text[i];
  };

  if (keepTail) {
    // 从尾部累积到预算，保留末尾（代理对完整）
    for (let i = text.length - 1; i >= 0; i--) {
      const code = text.charCodeAt(i);
      if (isLow(code)) continue; // low 随 high 一起处理
      const ch = charAt(i);
      tokens += isCjk(ch) ? 0.6 : 0.3;
      if (tokens + markerMargin > budgetTokens) break;
      out = ch + out;
    }
    return `…${out}`;
  }

  // 保留头部（代理对完整）
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isLow(code)) continue;
    const ch = charAt(i);
    tokens += isCjk(ch) ? 0.6 : 0.3;
    if (tokens + markerMargin > budgetTokens) break;
    out += ch;
  }
  return `${out}…`;
}

// ============================================================
// hashline 协议（v1 行级 + v2 文件级）
// ============================================================

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
