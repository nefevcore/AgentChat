// ============================================================
// disk.ts —— 两层直读 + B3 授权注册表指纹
//
// 壳每 run 前重读（生效时点语义——协议规格 E：最终一致，在线吊销最坏
// 延迟 = run 收束 + 下次重读）。写者面在宿主 auth-registry 行（M4）。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { GlobalAuth, AgentAuth } from './auth.ts';

/** 全局层路径：数据根/auth.json */
export function globalAuthFile(dataRoot: string): string {
  return path.join(dataRoot, 'auth.json');
}

/** per-agent 层路径：agents/<id>/auth.json */
export function agentAuthFile(dataRoot: string, agentId: string): string {
  if (/[/\\]/.test(agentId) || agentId === '.' || agentId === '..' || agentId.length === 0) {
    throw new Error(`agentId 含路径组件（${agentId}）——拒绝`);
  }
  return path.join(dataRoot, 'agents', agentId, 'auth.json');
}

/** 直读全局层（缺席/损坏 = 空表——fail-open 读侧，写侧恒宿主单写） */
export function readGlobalAuth(dataRoot: string): GlobalAuth {
  try {
    const parsed = JSON.parse(fs.readFileSync(globalAuthFile(dataRoot), 'utf-8')) as Partial<GlobalAuth>;
    if (Array.isArray(parsed.entries)) return { version: 1, entries: parsed.entries as GlobalAuth['entries'] };
  } catch {
    // 缺席 = 空
  }
  return { version: 1, entries: [] };
}

/** 直读 per-agent 层（缺席/损坏 = null——无授权） */
export function readAgentAuth(dataRoot: string, agentId: string): AgentAuth | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(agentAuthFile(dataRoot, agentId), 'utf-8')) as Partial<AgentAuth>;
    if (!Array.isArray(parsed.grants) || !Array.isArray(parsed.denials)) return null;
    return parsed as AgentAuth;
  } catch {
    return null;
  }
}

/** canonical 形态（键排序 + 数组按 canonical 序 + 紧凑 JSON——指纹稳定前提：
 * 全局层条目 id 唯一，元素排序无损语义且乱序写入不漂移指纹） */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).sort().join(',') + ']';
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** B3. 授权注册表指纹 = sha256(canonical(全局) || canonical(per-agent)) */
export function authFingerprint(global: GlobalAuth, agent: AgentAuth | undefined): string {
  const h = createHash('sha256');
  h.update(canonical(global));
  h.update(canonical(agent ?? null));
  return h.digest('hex');
}
