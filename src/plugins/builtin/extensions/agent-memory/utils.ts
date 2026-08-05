// ============================================================
// agent-memory utils —— 工具函数
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { getGlobalConfig } from '@agents/config';

// ============================================================
// Agent 名称
// ============================================================

/**
 * 获取 Agent 的友好名称。
 * 从 <workspace>/agents/<id>/config.json 读取 name 字段，每次实时读取（名称变更立即生效）。
 * 读取失败时回退到原始 id。
 */
export function agentLabel(id: string): string {
  try {
    const configPath = path.join(getGlobalConfig().agentsDir, id, 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.name) {
        return config.name;
      }
    }
  } catch {
    // 读取失败时回退到 id
  }
  return id;
}
