// ============================================================
// ac-migration-core —— 版本升级数据迁移纯库（零 cordis 依赖）
//
// 动机（skill-injection-and-storage-vocab §4）：数据形态变更
//（存储词汇 v2 / subcall 双文件分流补课）需要重写 append-only 历史——
// 显式例外通道。顺序敏感（必须先于任何行装载/首写），唯一可保证时序的
// 位置是 boot.ts（运行锁后、Loader 装载前）——故纯库 + boot 调用段，
// 非行非服务（行激活序是需求驱动的 PENDING，无法保证先于 session）。
//
// 机制：
//   · 版本标记 data/meta.json { dataVersion }（首启从 .initialized 推断 v0）；
//   · 迁移注册表：升序版本号 → 迁移体（纯函数，数据根路径入参）；
//   · 执行器：目标版本 > 当前版本 → 迁移前强制快照（ac-backup-core 直调
//     ——行未激活，owning 行的 core 独立可用）→ 按序应用 → 每迁移完成
//     即落版本（断点续跑：半途崩溃下次从断点继续，已应用的跳过）；
//   · 失败语义：任一迁移失败 = 抛出（boot 捕获后拒绝启动，EXIT_CONFIG
//     同款）——绝不带着半迁移数据跑。
//
// 红线：append-only 历史仅可经本通道重写；迁移前快照强制不可跳过。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackup } from 'ac-backup-core';

/** 版本标记文件（数据根下） */
export const META_FILE = 'meta.json';

/** 旧初始化标记（首启版本推断源；v0 语义） */
export const LEGACY_INITIALIZED = '.initialized';

/** 迁移体：数据根路径入参的纯函数（幂等：重复应用无副作用） */
export interface Migration {
  /** 目标版本（升序应用；= 应用完成后的 dataVersion） */
  version: number;
  /** 迁移标识（诊断/日志） */
  id: string;
  /** 说明（日志呈现） */
  description: string;
  /** 应用迁移（失败抛错 = boot 拒绝启动） */
  apply(dataRoot: string): void;
}

/** 版本标记文件形态 */
export interface DataMeta {
  dataVersion: number;
  /** 已应用迁移记录（诊断；断点续跑以 dataVersion 为准，此为审计面） */
  applied?: Array<{ id: string; at: string }>;
}

/** 读当前数据版本：meta.json > .initialized 推断 v0 > 空目录 v0 */
export function readDataVersion(dataRoot: string): number {
  const metaPath = path.join(dataRoot, META_FILE);
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as DataMeta;
      if (typeof meta.dataVersion === 'number' && meta.dataVersion >= 0) return meta.dataVersion;
    } catch {
      // 损坏的 meta：视为未知（v=-1）→ 全量重放（迁移幂等保证安全）
      return -1;
    }
  }
  // 无 meta：.initialized 在场 = 旧数据（v0）；全新数据根也按 v0（无迁移可跳）
  return fs.existsSync(path.join(dataRoot, LEGACY_INITIALIZED)) ? 0 : 0;
}

/** 原子写版本标记（临时文件 + rename） */
export function writeDataVersion(dataRoot: string, version: number, applied: Array<{ id: string; at: string }>): void {
  const metaPath = path.join(dataRoot, META_FILE);
  const tmp = metaPath + '.tmp';
  const meta: DataMeta = { dataVersion: version, applied };
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf-8');
  fs.renameSync(tmp, metaPath);
}

/**
 * 迁移执行入口：目标版本 > 当前 → 快照 + 按序应用 + 逐迁移落版本。
 * 幂等：已应用（dataVersion >= 迁移版本）跳过。返回实际应用的迁移
 * 清单（空 = 无需迁移）。任一失败即抛（调用方拒绝启动）。
 */
export function runMigrations(dataRoot: string, migrations: Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const current = readDataVersion(dataRoot);
  const pending = sorted.filter((m) => m.version > current);
  if (pending.length === 0) return [];
  // 迁移前强制快照（红线：不可跳过；ac-backup-core 直调）
  const backupDir = path.join(dataRoot, 'backups');
  const snapshot = createBackup({ sourceDir: dataRoot, backupDir, force: true });
  console.log(`[migration] 迁移前快照: ${snapshot.file}（${Math.round(snapshot.size / 1024)}KB）`);
  const applied: Array<{ id: string; at: string }> = [];
  for (const m of pending) {
    console.log(`[migration] 应用 ${m.version} ${m.id}: ${m.description}`);
    m.apply(dataRoot);
    applied.push({ id: m.id, at: new Date().toISOString() });
    writeDataVersion(dataRoot, m.version, applied); // 断点续跑锚
  }
  return pending;
}
