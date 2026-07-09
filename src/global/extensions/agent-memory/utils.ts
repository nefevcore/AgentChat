// ============================================================
// agent-memory utils —— 工具函数
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { getGlobalConfig } from '../../../core/config';

// ============================================================
// Agent 名称
// ============================================================

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
