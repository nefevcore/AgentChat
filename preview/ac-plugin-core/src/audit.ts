// ============================================================
// ac-plugin-core/src/audit.ts —— 插件域审计流水（M23 P1a：F2/H3、G7）
//
// <root>/plugins/audit.jsonl（append-only + M24 X5 大小轮转）：
//   install / uninstall / reject / load 四类事件全入账（uninstall 删
//   registry 条目后卸载史不可追、回滚取证断链——必须同入流水）。
// 写口经数据根串行队列（与 registry mutation 同队保序）；写前查大小，
// 超 5 MiB 轮转 audit.jsonl → .1（→ .2，保留 2 份历史，串行队列内
// rename——无跨队交错）；readAudit 只读当前份（历史份取证手工查）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withRootLock } from './fsx.ts';
import type { PluginPermission } from './manifest.ts';

/** 审计事件词汇 */
export type PluginAuditEvent = 'install' | 'uninstall' | 'reject' | 'load';

/** 审计流水行（jsonl 单行形状） */
export interface PluginAuditEntry {
  ts: string;
  event: PluginAuditEvent;
  name: string;
  /** 执行身份（install 的 owner / load 的触发方；人审流缺省 'host'） */
  owner?: string;
  /** install/reject：原始来源目录（数据根外来源的取证锚点） */
  sourceDir?: string;
  /** install/reject/load：内容哈希 */
  hash?: string;
  /** install：授予快照 */
  grants?: PluginPermission[];
  /** install/load：结果态（loaded / installed+failed / rejected / …） */
  outcome?: string;
  /** 失败原因（失败态必带） */
  error?: string;
  /** 卸载备份目录（uninstall） */
  backupDir?: string;
  /** 版本（有 manifest 语境时） */
  version?: string;
}

/** 审计流水文件路径 */
export function auditFile(root: string): string {
  return path.join(root, 'plugins', 'audit.jsonl');
}

/** 轮转大小上限（5 MiB；M24 X5/G7） */
export const AUDIT_ROTATE_MAX_BYTES = 5 * 1024 * 1024;

/** 轮转保留份数（.1 / .2；更早历史份轮转时丢弃） */
export const AUDIT_ROTATE_KEEP = 2;

/**
 * 大小轮转（串行队列内调用——与 append 同队保序）：
 * 当前份超上限 → .1 → .2（保留 2 份；旧 .2 丢弃），当前份 rename 走
 * fsx retry（Windows EBUSY 退避）。幂等：不超上限零操作。
 */
export function rotateAuditIfLarge(root: string): boolean {
  const file = auditFile(root);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false; // 当前份不存在（尚未入账）→ 无需轮转
  }
  if (size <= AUDIT_ROTATE_MAX_BYTES) return false;
  const second = `${file}.2`;
  try {
    if (fs.existsSync(second)) fs.rmSync(second);
    const first = `${file}.1`;
    if (fs.existsSync(first)) fs.renameSync(first, second);
    fs.renameSync(file, first);
  } catch {
    /* 轮转失败不阻断入账（append 继续写当前份——审计连续性优先） */
    return false;
  }
  return true;
}

/**
 * 追加一条审计流水（串行队列内 append + 写前大小轮转；文件不可写时抛错
 * 由调用方决定是否吞掉——审计失败不阻断主流程是调用方策略，本函数不做
 * 静默丢弃）。
 */
export function appendAudit(root: string, entry: PluginAuditEntry): Promise<void> {
  return withRootLock(root, () => {
    rotateAuditIfLarge(root);
    const file = auditFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf-8');
  });
}

/** 读全部审计流水（当前份；解析失败行跳过；诊断/RPC 用） */
export function readAudit(root: string): PluginAuditEntry[] {
  const file = auditFile(root);
  if (!fs.existsSync(file)) return [];
  const out: PluginAuditEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as PluginAuditEntry);
    } catch {
      /* 损坏行跳过（append-only，不阻断读取） */
    }
  }
  return out;
}
