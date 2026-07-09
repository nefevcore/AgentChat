// ============================================================
// agent-session utils —— 工具函数
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { LLMUsage } from '../../../core/types';
import { getGlobalConfig } from '../../../core/config';

// ============================================================
// Agent 名称
// ============================================================

// Agent 名称缓存：避免每次调用 agentLabel 都读取 config.json
const agentNameCache = new Map<string, string>();

/**
 * 获取 Agent 的友好名称。
 * 从 <workspace>/agents/<id>/config.json 读取 name 字段，
 * 读取失败时回退到原始 id。结果会被缓存。
 */
export function agentLabel(id: string): string {
  if (agentNameCache.has(id)) {
    return agentNameCache.get(id)!;
  }
  try {
    const configPath = path.join(getGlobalConfig().agentsDir, id, 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.name) {
        agentNameCache.set(id, config.name);
        return config.name;
      }
    }
  } catch {
    // 读取失败时回退到 id
  }
  agentNameCache.set(id, id);
  return id;
}

// ============================================================
// Token 用量记录
// ============================================================

/**
 * 记录本轮 LLM Token 用量。
 * 输出提示词/补全/缓存命中/总计的明细到控制台和持久化文件。
 */
export function logUsage(usage: LLMUsage | undefined, agent: string, counterpart: string): void {
  if (!usage) return;
  // 控制台输出
  const parts: string[] = [];
  parts.push(`输入 ${usage.prompt_tokens}`);
  parts.push(`输出 ${usage.completion_tokens}`);
  if (usage.prompt_cache_hit_tokens !== undefined) {
    parts.push(`缓存命中 ${usage.prompt_cache_hit_tokens}`);
  }
  if (usage.prompt_cache_miss_tokens !== undefined) {
    parts.push(`缓存未命中 ${usage.prompt_cache_miss_tokens}`);
  }
  parts.push(`合计 ${usage.total_tokens}`);
  console.log(`[agent-session] Token 用量 ${agent}/${counterpart}：${parts.join(' | ')}`);

  // 持久化到 data/usage/token_<date>.jsonl (JSONL 格式，每行一条记录)
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const usageDir = path.join(path.dirname(getGlobalConfig().sessionsDir), 'usage');
  if (!fs.existsSync(usageDir)) {
    fs.mkdirSync(usageDir, { recursive: true });
  }
  const record = {
    timestamp: new Date().toISOString(),
    agent,
    counterpart,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
    prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens,
  };
  fs.appendFileSync(
    path.join(usageDir, `token_${date}.jsonl`),
    JSON.stringify(record) + '\n',
    'utf-8',
  );
}
