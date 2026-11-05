// ============================================================
// disk.ts —— 目录与偏好文件直读（数据根纪律同族）
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RowsetCatalog, HostRowPreference } from './rowset.ts';
import { readBaseCatalog } from './base-docs.ts';

/** 目录文件缺省位（数据根内）；boot 显式传完整路径（仓库静态资产位） */
export function defaultCatalogFile(dataRoot: string): string {
  return dataRoot + '/row-catalog.json';
}

/**
 * 目录双读（cr-902 批1 双读窗口：基座赢）：catalogFile 同目录 profile/
 * 下基座源文档在场 → 读基座投影（单一事实源）；否则回退 JSON 生成物
 *（批 6 退役；缺席 = 空目录——fixture 容错语义原样保留）。
 */
export function readCatalog(catalogFile: string): RowsetCatalog {
  const base = readBaseCatalog(path.join(path.dirname(catalogFile), 'profile'));
  if (base !== null) return base;
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogFile, 'utf-8')) as Partial<RowsetCatalog>;
    if (Array.isArray(parsed.rows)) return { rows: parsed.rows as RowsetCatalog['rows'] };
  } catch {
    // 缺席 = 空目录
  }
  return { rows: [] };
}

/** 宿主行集偏好文件（数据根 host-rows.json——写者 = plugin-registry 急救 RPC） */
export function hostPreferenceFile(dataRoot: string): string {
  return dataRoot + '/host-rows.json';
}

/** 写偏好文件（原子换名；写者 = plugin-registry 行急救 RPC——空数组 = 恢复全装） */
export function writeHostPreferences(dataRoot: string, preferences: HostRowPreference[]): void {
  const file = hostPreferenceFile(dataRoot);
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(preferences, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

export function readHostPreferences(dataRoot: string): HostRowPreference[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(hostPreferenceFile(dataRoot), 'utf-8')) as unknown;
    if (Array.isArray(parsed)) return parsed as HostRowPreference[];
  } catch {
    // 缺席 = 无偏好（全装载）
  }
  return [];
}
