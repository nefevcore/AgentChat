// ============================================================
// card.ts —— 审批卡载荷（cr-903 / cr-901 v2.1 批2 切片三 §4.5）
//
// 一张卡（仅 node 面）：permissions + provides + 来源锚定 + 定格指纹
//（目录形态 = 内容 hash；npm 形态 lock 树指纹随落位切片接入）+ 升级
// 内容 diff + 豁免规则命中清单。人签对象即本载荷——install/对话安装/
// 市场（批 5 CLI）三入口共用；免审 ≠ 无门禁：门禁明细（admission
// reasons）同卡展示。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { admissionOf, type ExemptionRule } from './installer.ts';
import { hashPluginDir, readRegistry, pluginsRoot } from './store.ts';
import { REVIEW_EXPLICIT_REQUIRED, type PluginPermission, type PluginSource } from './manifest.ts';
import { evaluateEngines, type PluginPackage } from './pkg.ts';

/** 升级内容 diff（目录形态：文件级变更清单） */
export interface ContentDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

/** 审批卡载荷（人签对象） */
export interface ApprovalCard {
  name: string;
  version: string;
  form: PluginPackage['form'];
  /** 来源锚定（市场 repo/ref/commit；本地缺省 local） */
  source?: PluginSource;
  /** engines 自求值结论（双轴明细） */
  engines: ReturnType<typeof evaluateEngines>;
  /** 声明权限 + 需人签显式授予面 */
  permissions: {
    declared: PluginPermission[];
    /** REVIEW_EXPLICIT_REQUIRED ∩ declared——卡上必须勾选的面 */
    explicitRequired: PluginPermission[];
  };
  /** 供给面声明（保留字护栏已过/未过见 admission） */
  provides?: NonNullable<PluginPackage['ac']>['provides'];
  /** 定格指纹（目录形态 = 内容 hash） */
  fingerprint: { kind: 'content-hash'; hash: string };
  /** 升级 diff（同包旧版在场时） */
  upgrade?: { oldVersion: string; diff: ContentDiff };
  /** 门禁结论 + 豁免命中留痕 */
  admission: { ok: boolean; reasons: string[] };
  exemptionHits: string[];
}

/** 目录文件清单 → 相对路径 → 内容 hash 映射（diff 基元；排除集同 store） */
function fileHashMap(dir: string): Map<string, string> {
  const EXCLUDE = new Set(['node_modules', '.git', '.staging', '.backup', '.market']);
  const out = new Map<string, string>();
  const walk = (d: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (EXCLUDE.has(e.name)) continue;
        walk(path.join(d, e.name), rel + e.name + '/');
      } else if (e.isFile()) {
        const content = fs.readFileSync(path.join(d, e.name));
        out.set(rel + e.name, crypto.createHash('sha256').update(content).digest('hex').slice(0, 16));
      }
    }
  };
  walk(dir, '');
  return out;
}

/** 两目录文件级 diff（升级卡面——变更/新增/移除清单） */
export function contentDiffOf(oldDir: string, newDir: string): ContentDiff {
  const a = fileHashMap(oldDir);
  const b = fileHashMap(newDir);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [file, hash] of b) {
    const old = a.get(file);
    if (old === undefined) added.push(file);
    else if (old !== hash) changed.push(file);
  }
  for (const file of a.keys()) {
    if (!b.has(file)) removed.push(file);
  }
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/**
 * 构建审批卡（纯读面；安装前人签对象）。豁免规则命中留痕但放行仍需
 * 卡面明示（exemptionHits 即勾选项）。
 */
export function buildApprovalCard(sourceDir: string, options: {
  grants?: unknown;
  source?: PluginSource;
  exemptions?: ExemptionRule[];
} = {}): ApprovalCard {
  const admission = admissionOf(sourceDir, options.grants, options.exemptions);
  if (admission.pkg === null) {
    throw new Error('无法构建审批卡（包描述符不可读）：' + admission.reasons.join('；'));
  }
  const pkg = admission.pkg;
  const declared = pkg.ac?.permissions
    ?? (admission.manifest?.permissions !== undefined ? admission.manifest.permissions : []);
  // 升级 diff：registry 旧版物化目录在场时现算
  const existing = (() => {
    try {
      return readRegistryLocally(sourceDir, pkg.name);
    } catch {
      return undefined;
    }
  })();
  const rootOf = existing?.root;
  const upgrade = rootOf !== undefined && existing?.dir !== undefined
    ? {
      oldVersion: existing.version,
      diff: contentDiffOf(path.join(pluginsRoot(rootOf), existing.dir), sourceDir),
    }
    : undefined;
  return {
    name: pkg.name,
    version: pkg.version,
    form: pkg.form,
    ...(options.source !== undefined ? { source: options.source } : {}),
    engines: evaluateEngines(pkg),
    permissions: {
      declared,
      explicitRequired: declared.filter((p) => REVIEW_EXPLICIT_REQUIRED.includes(p)),
    },
    ...(pkg.ac?.provides !== undefined ? { provides: pkg.ac.provides } : {}),
    fingerprint: { kind: 'content-hash', hash: hashPluginDir(sourceDir) },
    ...(upgrade !== undefined ? { upgrade } : {}),
    admission: { ok: admission.ok, reasons: admission.reasons },
    exemptionHits: admission.exemptionHits,
  };
}

/** registry 旧版查询（升级 diff 锚——root 从插件目录向上找 registry 不可靠，
 * 由调用方传 root 更稳；卡构建独立场景（市场预览）无 root = 无 diff） */
function readRegistryLocally(sourceDir: string, name: string): { root: string; dir: string; version: string } | undefined {
  // 从 sourceDir 向上探测 plugins/registry.json（安装器内调用时 root 已知；
  // 独立预览场景无 root——upgrade 面缺席）
  let dir = path.resolve(sourceDir);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'plugins', 'registry.json');
    if (fs.existsSync(candidate)) {
      const doc = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as {
        plugins?: Record<string, { dir?: string; manifest?: { version?: string } }>;
      };
      const record = doc.plugins?.[name];
      if (record?.dir !== undefined && record.manifest?.version !== undefined) {
        return { root: dir, dir: record.dir, version: record.manifest.version };
      }
      return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
