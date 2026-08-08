// ============================================================
// 数据备份核心 —— createBackup()（L4 运行时可调能力）
//
// 设计原则（用户 8/5 拍板）：
//   1. 不能上传 git —— 数据泄露风险（会话/记忆含业务内容）
//   2. 每周自动打包一次（定时任务 __backup_all__ 触发，不走 LLM）
//   3. 活动栏"更多"菜单可手工触发
//   4. 备份位置：项目根 backups/ 目录（.gitignore 排除，绝不入库）
//   5. 保留最近 N 份（默认 4 周），循环覆盖防磁盘膨胀
//
// 备份内容：workspace/<name>/ 下全部数据（sessions/ agents/ groups/
//   files/ config.json 等），排除 archive 中的大体积归档？
//   —— 不排除：archive 也是记忆的一部分，全量备份更稳妥。
//
// 适配新架构：
//   · 旧 getGlobalConfig().workspaceDir → workspaceRoot()（AGENTCHAT_WORKSPACE 覆盖，
//     与 L3 会话/记忆路径约定一致）
//   · logger ← @core/logger
//
// 依赖方向：仅依赖 src/core + 本层 runtime + Node 内置 + adm-zip。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { workspaceRoot } from '@plugins/builtin/tools/shared';
import { createLogger } from '@core/logger';

const log = createLogger('[services:backup]');

/** 备份保留份数（默认 4 份，循环覆盖） */
export const BACKUP_KEEP = 4;

/** 自动备份最小间隔（毫秒，默认 7 天）——手工触发不受此限制 */
export const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** 备份目录名（项目根下，gitignore 排除） */
export const BACKUP_DIR = 'backups';

/** 备份目录绝对路径（项目根/backups） */
export function backupRootDir(): string {
  // 项目根 = 当前工作目录（后端启动时 cwd=项目根）；
  // workspaceDir 可能是相对（DEFAULT）或绝对（config.json 覆盖），
  // 统一以 cwd 为锚点最稳定。
  return path.resolve(process.cwd(), BACKUP_DIR);
}

/** 列出已有备份（按文件名倒序，最新在前） */
export function listBackups(): Array<{ file: string; size: number; createdAt: string }> {
  const dir = backupRootDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { file: f, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.file.localeCompare(a.file));
}

/**
 * 判断距上次自动备份是否已超过间隔（7 天）。
 * 用于每日定时任务：满足间隔才真正执行，否则跳过。
 */
export function backupDue(): boolean {
  const backups = listBackups();
  if (backups.length === 0) return true;
  const latest = new Date(backups[0].createdAt).getTime();
  return Date.now() - latest >= BACKUP_INTERVAL_MS;
}

/**
 * 执行一次完整备份。
 * @param opts.force 强制（手工触发），跳过间隔检查；默认 false
 * @returns { file, size, backups, skipped } — skipped=true 表示距上次备份不足间隔未执行
 */
export function createBackup(opts?: { force?: boolean }): { file: string; size: number; backups: Array<{ file: string; size: number; createdAt: string }>; skipped?: boolean } {
  if (!opts?.force && !backupDue()) {
    const latest = listBackups()[0];
    log.info(`距上次备份不足 7 天（${latest.file}），跳过自动备份`);
    return { file: '', size: 0, backups: listBackups(), skipped: true };
  }

  const workspaceDir = workspaceRoot();
  if (!fs.existsSync(workspaceDir)) {
    throw new Error(`工作区不存在: ${workspaceDir}`);
  }

  const outDir = backupRootDir();
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-08-05T07-50-00
  const outFile = path.join(outDir, `backup-${stamp}.zip`);
  const outName = path.basename(outFile);

  const zip = new AdmZip();

  // 递归收集工作区文件（排除 .archive 大目录？不——全量，archive 也是数据）
  // 排除：node_modules、.git、dist 等非数据目录（正常 workspace 下没有，防御性排除）
  const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', '_tmp']);
  const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        walk(abs, rel);
      } else if (entry.isFile()) {
        if (EXCLUDE_FILES.has(entry.name)) continue;
        try {
          zip.addLocalFile(abs, path.posix.dirname(rel));
        } catch (err: any) {
          log.warn(`跳过文件 ${rel}: ${err.message}`);
        }
      }
    }
  };
  walk(workspaceDir, '');

  zip.writeZip(outFile);

  // 清理旧备份，保留最近 BACKUP_KEEP 份
  const backups = listBackups();
  for (const b of backups.slice(BACKUP_KEEP)) {
    const old = path.join(backupRootDir(), b.file);
    try {
      fs.unlinkSync(old);
      log.info(`清理旧备份 ${b.file}`);
    } catch { /* ignore */ }
  }

  const size = fs.statSync(outFile).size;
  log.info(`完成: ${outName} (${(size / 1024 / 1024).toFixed(2)}MB)，保留 ${Math.min(backups.length, BACKUP_KEEP)} 份`);
  return { file: outName, size, backups: listBackups() };
}
