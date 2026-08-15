// ============================================================
// @agentchat/toolkit/src/shared.ts —— 工具执行基础（沙箱 + 文本工具）
//
// 迁移自 src/plugins/builtin/tools/shared.ts（沙箱/路径 + token/文本部分；
// hashline 协议已迁 @agentchat/edit）。命名领域化：工具基础库可独立发布复用。
// ============================================================
import * as path from 'path';
import * as os from 'os';
import { getNamespaceConfig } from '@agentchat/agent-config';
import { NS_SECURITY } from './namespaces';
import type { AgentConfig } from '@agentchat/agent-config';

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

// ============================================================
// 敏感文件黑名单（DENY，优先于 allow）
// ============================================================

/**
 * 内置敏感路径黑名单（不可覆盖）：
 *   · 家目录凭据目录（~/.agentchat 整目录）
 *   · 常见密钥/凭据文件名模式
 * read/write/edit/bash 共享管控（经 resolveSafePath）。
 */
const BUILTIN_DENY_PATTERNS: string[] = [
  '~/.agentchat',
  '**/.env',
  '**/*.pem',
  '**/id_rsa*',
  '**/*_rsa',
  '**/.npmrc',
  '**/.git-credentials',
];

/** 读取路径黑名单（内置 DENY + security.denyPaths 追加；追加不可覆盖内置） */
export function getDenyPatterns(config: AgentConfig): string[] {
  const paths = getNamespaceConfig(config, NS_SECURITY).denyPaths;
  const extra = Array.isArray(paths) ? (paths as string[]) : [];
  return [...BUILTIN_DENY_PATTERNS, ...extra];
}

/**
 * 判断目标路径是否命中黑名单。
 * 支持模式：`** /` 前缀 = 文件名模式（任意目录层级，如 `.env`、`*.pem`、`id_rsa*`）、
 *           `~` = 家目录展开、其余为绝对路径前缀。
 */
export function isDeniedPath(config: AgentConfig, target: string): boolean {
  const norm = target.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  for (const pattern of getDenyPatterns(config)) {
    if (!pattern) continue;
    if (pattern.startsWith('**/')) {
      // 文件名模式（任意目录层级）
      const p = pattern.slice(3);
      if (p.startsWith('*') && p.length > 1) {
        if (base.endsWith(p.slice(1))) return true;
      } else if (p.endsWith('*') && p.length > 1) {
        if (base.startsWith(p.slice(0, -1))) return true;
      } else if (base === p) {
        return true;
      }
    } else if (pattern.startsWith('~')) {
      // 家目录展开 + 前缀匹配
      const home = os.homedir().replace(/\\/g, '/');
      const p = home + pattern.slice(1);
      if (norm === p || norm.startsWith(p + '/')) return true;
    } else if (norm === pattern || norm.startsWith(pattern + '/')) {
      // 绝对路径前缀
      return true;
    }
  }
  return false;
}

/** 工作区根绝对路径 */
export function workspaceRoot(): string {
  return path.resolve(process.cwd(), workspaceDir());
}

/**
 * 沙箱路径解析：目标必须落在 workspaceDir 或 security.allowedPaths 内，
 * 且不得命中敏感文件黑名单（security.denyPaths / 内置 DENY，优先于 allow）。
 * @throws 越界 / 命中黑名单抛错
 */
export function resolveSafePath(config: AgentConfig, p: string): string {
  const root = workspaceRoot();
  const allowed = getAllowedPaths(config);
  const roots = [root, ...(allowed ?? []).map(a => (path.isAbsolute(a) ? a : path.resolve(root, a)))];
  const target = path.resolve(root, p);
  const ok = roots.some(r => target === r || target.startsWith(r + path.sep));
  if (!ok) throw new Error(`路径越界（沙箱限制）：${p}`);
  if (isDeniedPath(config, target)) throw new Error(`路径被沙箱拒绝（敏感文件黑名单）：${p}`);
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
