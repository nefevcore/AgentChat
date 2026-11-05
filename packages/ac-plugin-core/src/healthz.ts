// ============================================================
// healthz.ts —— 插件安装态健康面（cr-903 / cr-901 v2.1 批2 切片三 §4.5）
//
// healthz 新增面：installed.patch.yml ↔ registry.json ↔ plugins/ 物化
// 三方一致性对账 + needs-reinstall 清单 + 熔断态。只读——异常态上报
// 不自愈（修复动作归安装器/急救 RPC）。宿主轮询/RPC 暴露随切片四接线。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { listInstalled, pluginsRoot } from './store.ts';
import { readInstalledDoc } from './installed.ts';
import { readLoadHealth } from './load-health.ts';
import { needsReinstallOf } from './receipt.ts';

/** 单插件健康项 */
export interface PluginHealthzEntry {
  name: string;
  version: string;
  /** registry.json 记录在场 */
  registered: boolean;
  /** plugins/<name>/ 物化在场 */
  materialized: boolean;
  /** installed.patch.yml 登记在场 */
  documented: boolean;
  /** 备份口径恢复钩子命中（物化缺席） */
  needsReinstall: boolean;
  /** 熔断（load-health 连败停用） */
  loadDisabled: boolean;
  /** 异常态汇总（空 = 健康） */
  issues: string[];
}

export interface PluginHealthz {
  entries: PluginHealthzEntry[];
  /** 全局异常（文档损坏等——fail-loud 面由读方决定） */
  warnings: string[];
}

/** 安装态健康对账（只读；三方一致性 + 恢复钩子 + 熔断） */
export function pluginHealthz(root: string): PluginHealthz {
  const warnings: string[] = [];
  const loadHealth = readLoadHealth(root);
  const disabledNames = new Set(Object.keys(loadHealth.disabled));
  let installedNames: string[] = [];
  let versions = new Map<string, string>();
  try {
    versions = new Map(listInstalled(root).map((r) => [r.manifest.name, r.manifest.version]));
    installedNames = [...versions.keys()];
  } catch (err: unknown) {
    warnings.push('registry.json 不可读：' + (err instanceof Error ? err.message : String(err)));
  }
  let docNames: string[] = [];
  try {
    // 对账键 = 条目 id（稳定包名）；name 是解析词形（npm 裸名 / link:<dir>）
    docNames = readInstalledDoc(root).map((e) => e.id);
  } catch (err: unknown) {
    warnings.push('installed.patch.yml 不可读：' + (err instanceof Error ? err.message : String(err)));
  }
  const docSet = new Set(docNames);
  const entries: PluginHealthzEntry[] = [];
  for (const name of new Set([...installedNames, ...docNames])) {
    const materialized = fs.existsSync(path.join(pluginsRoot(root), name));
    const registered = installedNames.includes(name);
    const documented = docSet.has(name);
    const needsReinstall = needsReinstallOf(root, name);
    const loadDisabled = disabledNames.has(name);
    const issues: string[] = [];
    if (registered && !materialized) issues.push('物化目录缺席（needs-reinstall——备份恢复钩子面）');
    if (registered !== documented) issues.push(registered
      ? 'registry 有记录但 installed.patch.yml 未登记（登记链断裂）'
      : 'installed.patch.yml 有登记但 registry 无记录（卸载半态）');
    if (loadDisabled) issues.push('装载熔断（连续失败停用）');
    entries.push({
      name,
      version: versions.get(name) ?? '',
      registered,
      materialized,
      documented,
      needsReinstall,
      loadDisabled,
      issues,
    });
  }
  return { entries, warnings };
}
