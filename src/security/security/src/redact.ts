// ============================================================
// src/plugins/builtin/hooks/redact.ts —— 输出脱敏器（redaction）
//
// 密钥保护防线之一：无论工具从哪条路径读到密钥，返回给 LLM 前
// 统一替换为掩码。清单来源：
//   · L2 credential-store 全部明文凭据值（精确匹配）
//   · 装配注入的额外值（L5 从 globalConfig 提取：llm.api_key / 池 api_key 等）
//   · 通用密钥模式（sk-xxx / api_key= 赋值等）
//
// 依赖方向：仅依赖 L2 agents/credential-store（plugins 允许依赖 core+agents）。
// ============================================================

import { listCredentialValues } from '@agentchat/agents';
import type { ToolExecutionEndHook, ToolExecutionEndResult } from '@agentchat/contracts';

/** 通用密钥模式（AI 厂商 key / 配置赋值 / 常见密钥命名） */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,                                    // OpenAI/DeepSeek 风格
  /(?:api[_-]?key|apikey|secret|token|password|passwd)\s*[=:]\s*['"]?[A-Za-z0-9_\-./+]{16,}['"]?/gi,
];

/**
 * 构建脱敏器：返回 (content, toolName) => content 的变换函数。
 * @param getExtraSecrets 可选：额外敏感值来源（L5 装配注入，从 globalConfig 提取密钥字段值）
 */
export function makeSecretRedactor(
  getExtraSecrets?: () => string[],
): (content: string, toolName: string) => string {
  return (content: string, _toolName: string): string => {
    if (!content) return content;
    let out = content;

    // 1. 精确值替换（凭据库 + 装配注入）
    const secrets = new Set<string>();
    for (const v of listCredentialValues()) secrets.add(v);
    for (const v of getExtraSecrets?.() ?? []) {
      if (v && v.length > 0) secrets.add(v);
    }
    for (const v of secrets) {
      if (v.length < 4) continue; // 过短不替换，避免误伤
      out = out.split(v).join('***');
    }

    // 2. 通用模式替换（保留赋值前缀，只掩码值部分）
    for (const re of SECRET_PATTERNS) {
      out = out.replace(re, (m) => {
        const eq = m.search(/[=:]\s*['"]?/);
        return eq > 0 ? m.slice(0, eq + 1) + '***' : '***';
      });
    }
    return out;
  };
}

/** 递归脱敏任意详情载荷（字符串直接替换；对象/数组 JSON 序列化后替换并还原） */
export function redactSecretValue(value: any, redact: (text: string) => string): any {
  if (typeof value === 'string') return value ? redact(value) : value;
  if (value && typeof value === 'object') {
    try {
      return JSON.parse(redact(JSON.stringify(value)));
    } catch { /* 解析失败保留原值（脱敏不应制造损坏数据） */ }
  }
  return value;
}

/**
 * 构造 toolExecutionEnd 脱敏变换钩子（security.redact-output）。
 * 对 outcome.result 的 string content 与 { content, details } 中的 details 一并脱敏，
 * 返回 { content?, details? } 供 loop 在写入 tool 消息与发射事件前应用。
 * 是否启用由 Agent 的 config.hooks.toolExecutionEnd 决定（无 mandatory 强制）。
 */
export function makeRedactEndHook(getExtraSecrets?: () => string[]): ToolExecutionEndHook {
  const redact = makeSecretRedactor(getExtraSecrets);
  return async (outcome): Promise<ToolExecutionEndResult> => {
    const result = outcome.result;
    if (typeof result === 'string') {
      return result ? { content: redact(result, outcome.toolName) } : undefined;
    }
    if (!result) return undefined;
    const transformed: { content?: string; details?: any } = {};
    if (typeof result.content === 'string' && result.content) {
      transformed.content = redact(result.content, outcome.toolName);
    }
    if (result.details !== undefined) {
      transformed.details = redactSecretValue(result.details, (text) => redact(text, outcome.toolName));
    }
    return transformed;
  };
}
