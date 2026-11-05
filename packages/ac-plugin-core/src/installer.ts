// ============================================================
// installer.ts —— v2 统一安装器（cr-903 / cr-901 v2.1 批2 切片二）
//
// 三入口（市场一键 / 对话安装 / CLI——批 5 接线）共享同一安装器：
//   门禁（包描述符 + engines 自求值 + 保留字护栏 + 权限边界）
//   → 事务（withRootLock + stage→approve 补偿链复用 v1 store）
//   → 登记（installed.patch.yml 代写；registry.json/plugin-rows.json
//     双写窗口兼容——旧读路径退役随批 6）
//   → 回执两轴（receipt.ts）。
//
// 免审 ≠ 无门禁（§4.5）：门禁失败不 throw——回执 failed 携带明细
//（审批卡〔切片三〕消费同一明细面）。
// ============================================================

import * as path from 'node:path';
import {
  stagePlugin, approveStaging, uninstallPlugin, pluginsRoot, loadManifestFromDir,
  type ApproveResult,
} from './store.ts';
import { findReservedConflict, reservedConflictError } from './reserved.ts';
import { grantPermissions, missingPermissions, type PluginManifest, type PluginPermission, type PluginSource } from './manifest.ts';
import { readPluginPackage, evaluateEngines, type PluginPackage } from './pkg.ts';
import { readInstalledDoc, writeInstalledDoc, type InstalledEntry } from './installed.ts';
import {
  effectiveStateOf, needsReinstallOf,
  type InstallResultAxis, type EffectiveStateAxis, type LiveProcess, type ProcKind,
} from './receipt.ts';

/** 安装回执（两轴 + 事务事实） */
export interface InstallReceipt {
  name: string;
  version: string;
  /** 安装结果轴 */
  result: InstallResultAxis;
  /** 目标基座（插件行恒 shell——host 面 insert 仅出厂，§4.3） */
  scope: ProcKind;
  /** 生效状态轴（目标进程种类） */
  effective: EffectiveStateAxis;
  /** failed 明细（门禁/事务失败原因——审批卡同源面） */
  reasons?: string[];
  /** 豁免命中留痕（审批卡例外放行——审计面） */
  exemptionHits?: string[];
  /** 成功事务事实（审计/展示面） */
  installedDir?: string;
  hash?: string;
  replaced?: ApproveResult['replaced'];
  form?: PluginPackage['form'];
}

/** 门禁面（原因归类——豁免规则按面命中） */
export type AdmissionGate = 'engines' | 'reserved' | 'permissions';

/** 豁免规则（§4.2：豁免 = 显式记录的例外，非默认放行；命中必留痕） */
export interface ExemptionRule {
  id: string;
  /** 插件名（精确匹配；'*' = 全体——慎用） */
  plugin: string;
  gate: AdmissionGate;
  /** 人签理由（审计面展示——为什么这个例外成立） */
  note: string;
}

/**
 * 安装门禁（纯读面；审批卡与安装事务共用）：
 * 包描述符合法 + engines 自求值 + 保留字护栏 + 权限边界。
 * 豁免规则命中的失败面被放行并记录进 exemptionHits（显式例外留痕）。
 */
export function admissionOf(sourceDir: string, grants?: unknown, exemptions?: ExemptionRule[]): {
  ok: boolean;
  reasons: string[];
  /** 豁免命中留痕（规则 id + 被放行的原因） */
  exemptionHits: string[];
  pkg: PluginPackage | null;
  manifest: PluginManifest | null;
  granted: PluginPermission[];
} {
  const granted = grantPermissions(grants);
  const reasons: Array<{ gate: AdmissionGate; message: string }> = [];
  let pkg: PluginPackage;
  try {
    pkg = readPluginPackage(sourceDir);
  } catch (err: unknown) {
    return {
      ok: false,
      reasons: [err instanceof Error ? err.message : String(err)],
      exemptionHits: [],
      pkg: null,
      manifest: null,
      granted,
    };
  }
  const engines = evaluateEngines(pkg);
  if (!engines.ok) reasons.push(...engines.failures.map((message) => ({ gate: 'engines' as const, message })));
  // 保留字护栏：provides 三面（tools/llmProviders/agents）比内置名常量表
  const provides = pkg.ac?.provides;
  if (provides !== undefined) {
    const conflict = findReservedConflict({ name: pkg.name, provides } as PluginManifest);
    if (conflict !== undefined) {
      reasons.push({ gate: 'reserved', message: reservedConflictError(conflict, pkg.name) });
    }
  }
  // 权限边界（v1 语义原样：默认授予 fs/network，process/shell/ui 强制
  // 显式授予——missingPermissions 判定；package 形态投影同判）
  let manifest: PluginManifest | null = null;
  try {
    manifest = loadManifestFromDir(sourceDir);
  } catch {
    manifest = null; // package 形态无 manifest.json（装载面切片四接入）
  }
  const permissionManifest: PluginManifest | null = manifest !== null
    ? manifest
    : (pkg.ac?.permissions !== undefined
      ? { name: pkg.name, version: pkg.version, entry: '', permissions: pkg.ac.permissions } as PluginManifest
      : null);
  if (permissionManifest !== null) {
    const missing = missingPermissions(permissionManifest, granted);
    if (missing.length > 0) {
      reasons.push({ gate: 'permissions', message: '未授予的权限：' + missing.join(', ') });
    }
  }
  // 豁免规则：按 (plugin, gate) 命中放行；命中留痕（id + 被放行原因）
  const exemptionHits: string[] = [];
  const remaining = reasons.filter((r) => {
    const rule = exemptions?.find((x) =>
      (x.plugin === pkg.name || x.plugin === '*') && x.gate === r.gate);
    if (rule === undefined) return true;
    exemptionHits.push('豁免 ' + rule.id + '（' + rule.note + '）放行：' + r.message);
    return false;
  });
  return {
    ok: remaining.length === 0,
    reasons: remaining.map((r) => r.message),
    exemptionHits,
    pkg,
    manifest,
    granted,
  };
}


/**
 * 统一安装入口（事务 + 登记 + 回执）。
 * 门禁失败 / 事务失败 → failed 回执（不 throw——三入口统一消费回执）；
 * liveProcesses 为回执求值输入（探活住宿主编排层）。
 */
export async function installPackage(input: {
  root: string;
  sourceDir: string;
  owner: string;
  grants?: unknown;
  source?: PluginSource;
  liveProcesses?: LiveProcess[];
  /** 豁免规则（审批卡人签后的例外放行——命中留痕进回执） */
  exemptions?: ExemptionRule[];
}): Promise<InstallReceipt> {
  const live = input.liveProcesses ?? [];
  // 不外包裹数据根锁：store 两步事务各自持锁（withRootLock 不可重入，
  // 嵌套 = 死锁）；原子性由步内补偿链 + 登记幂等 upsert 承担
  const admission = admissionOf(input.sourceDir, input.grants, input.exemptions);
  if (!admission.ok || admission.pkg === null) {
    return {
      name: admission.pkg?.name ?? path.basename(input.sourceDir),
      version: admission.pkg?.version ?? '0.0.0',
      result: 'failed' as const,
      scope: 'shell' as const,
      effective: 'live' as const,
      reasons: admission.reasons,
      ...(admission.pkg?.form !== undefined ? { form: admission.pkg.form } : {}),
    };
  }
  const pkg = admission.pkg;
    try {
      // 事务：stage（hash 定格）→ approve（补偿链 + registry 落账）
      const staged = await stagePlugin(input.root, input.sourceDir, input.owner, input.source, {
        uiIsolatedDefault: true,
      });
      const approved = await approveStaging(input.root, staged.id, input.grants);
      // 登记：installed.patch.yml upsert（词形分轨 cr-904：目录形态 =
      // link:<物化目录>；npm 形态〔npm-form.ts〕= 裸包名——name 即解析规则）
      registerInstalled(input.root, { id: pkg.name, name: 'link:' + path.join(pluginsRoot(input.root), pkg.name), owner: input.owner, scope: 'shell' });
      return {
        name: pkg.name,
        version: pkg.version,
        result: 'applied' as const,
        scope: 'shell' as const,
        effective: effectiveStateOf({ scope: 'shell', liveProcesses: live }),
        installedDir: approved.installedDir,
        hash: approved.hash,
        ...(approved.replaced !== undefined ? { replaced: approved.replaced } : {}),
        ...(admission.exemptionHits.length > 0 ? { exemptionHits: admission.exemptionHits } : {}),
        form: pkg.form,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name: pkg.name,
        version: pkg.version,
        result: 'failed' as const,
        scope: 'shell' as const,
        // Windows EPERM/EBUSY（活壳占文件）显式归 blocked-by-live-process
        effective: /EPERM|EBUSY|EACCES/.test(message)
          ? 'blocked-by-live-process' as const
          : 'live' as const,
        reasons: [message],
        form: pkg.form,
      };
    }
}

/** installed.patch.yml upsert（按 name 定位替换；保序追加；导出 = 宿主行
 * approve 流〔市场人审路径〕复用同一登记面） */
export function registerInstalled(root: string, entry: InstalledEntry): void {
  const entries = readInstalledDoc(root).filter((e) => e.name !== entry.name);
  entries.push(entry);
  writeInstalledDoc(root, entries);
}

/** 卸载入口（对称摘除：事务 + 登记撤销 + 回执） */
export async function uninstallPackage(input: {
  root: string;
  name: string;
  liveProcesses?: LiveProcess[];
}): Promise<InstallReceipt> {
  const live = input.liveProcesses ?? [];
  // 同 installPackage：不外包裹锁（uninstallPlugin 自持）
  try {
    const removed = await uninstallPlugin(input.root, input.name);
    // 撤销登记：对账键 = 条目 id（稳定包名——name 是解析词形 link:/裸名）
    const entries = readInstalledDoc(input.root).filter((e) => e.id !== input.name && e.name !== input.name);
    writeInstalledDoc(input.root, entries);
    return {
      name: input.name,
      version: '',
      result: 'applied',
      scope: 'shell',
      effective: effectiveStateOf({ scope: 'shell', liveProcesses: live }),
      ...(removed.backupDir !== undefined
        ? { replaced: { oldVersion: '', backupDir: removed.backupDir } }
        : {}),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: input.name,
      version: '',
      result: 'failed',
      scope: 'shell',
      effective: /EPERM|EBUSY|EACCES/.test(message)
        ? 'blocked-by-live-process'
        : 'live',
      reasons: [message],
    };
  }
}

export { needsReinstallOf, pluginsRoot };
