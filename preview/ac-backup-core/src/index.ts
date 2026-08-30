// ============================================================
// ac-backup-core —— 数据备份纯库（零 cordis 依赖）
//
// src svc/backup 的 createBackup 平移。preview 差异（地图 §3.2）：
//   · 路径全部显式传入（sourceDir/backupDir）——修 src 以
//     process.cwd() 为锚点的怪味（后端 cwd 变化即漂移）
//   · 定时触发直调（timer 机制任务 backup-all）+ 手工 force
//
// 设计原则（src 用户拍板，原样继承）：
//   1. 不上传 git（会话/记忆含业务内容，泄露风险）
//   2. 周期自动打包（缺省 7 天间隔，定时任务触发，不走 LLM）
//   3. 手工触发 force=true 跳过间隔检查
//   4. 保留最近 N 份（缺省 4），循环覆盖防磁盘膨胀
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';

/** 备份保留份数（缺省 4 份，循环覆盖） */
export const BACKUP_KEEP = 4;

/** 自动备份最小间隔（毫秒，缺省 7 天）——手工触发不受此限制 */
export const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** 排除目录（非数据目录防御性排除 + 备份目录自身防递归） */
export const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', '_tmp', 'backups']);

/** 排除文件 */
export const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/** 备份清单项 */
export interface BackupItem {
  file: string;
  size: number;
  createdAt: string;
}

/** createBackup 选项 */
export interface CreateBackupOptions {
  /** 被备份的数据根（workspace 等价物：sessions/agents/...） */
  sourceDir: string;
  /** 备份输出目录（不与 sourceDir 重叠时可完整还原；默认排除同名防递归） */
  backupDir: string;
  /** 强制执行（手工触发），跳过间隔检查；缺省 false */
  force?: boolean;
  /** 保留份数（缺省 BACKUP_KEEP） */
  keep?: number;
  /** 间隔检查用的最小间隔（缺省 BACKUP_INTERVAL_MS；测试可调小） */
  intervalMs?: number;
}

/** 备份结果 */
export interface BackupResult {
  file: string;
  size: number;
  backups: BackupItem[];
  /** true = 距上次备份不足间隔，未执行 */
  skipped?: boolean;
}

/** 列出已有备份（按文件名倒序，最新在前） */
export function listBackups(backupDir: string): BackupItem[] {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const stat = fs.statSync(path.join(backupDir, f));
      return { file: f, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.file.localeCompare(a.file));
}

/** 距上次备份是否已超过间隔（无备份 = 到期） */
export function backupDue(backupDir: string, intervalMs = BACKUP_INTERVAL_MS): boolean {
  const backups = listBackups(backupDir);
  if (backups.length === 0) return true;
  return Date.now() - new Date(backups[0].createdAt).getTime() >= intervalMs;
}

/**
 * 执行一次完整备份（zip 打包 sourceDir 全量数据 + 轮转清理）。
 * 归档（archive/）也是记忆的一部分——全量备份不排除（src 决策）。
 */
export function createBackup(opts: CreateBackupOptions): BackupResult {
  const { sourceDir, backupDir, force = false, keep = BACKUP_KEEP, intervalMs } = opts;
  if (!force && !backupDue(backupDir, intervalMs)) {
    return { file: '', size: 0, backups: listBackups(backupDir), skipped: true };
  }
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`备份源不存在: ${sourceDir}`);
  }

  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-08-05T07-50-00
  const outFile = path.join(backupDir, `backup-${stamp}.zip`);
  const outName = path.basename(outFile);

  const zip = new AdmZip();
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
        } catch {
          // 单文件失败跳过（如权限/占用），不阻塞整体备份
        }
      }
    }
  };
  walk(sourceDir, '');
  zip.writeZip(outFile);

  // 轮转清理：保留最近 keep 份
  const backups = listBackups(backupDir);
  for (const b of backups.slice(keep)) {
    try {
      fs.unlinkSync(path.join(backupDir, b.file));
    } catch {
      /* ignore */
    }
  }

  return { file: outName, size: fs.statSync(outFile).size, backups: listBackups(backupDir) };
}
