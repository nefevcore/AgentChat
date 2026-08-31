// ============================================================
// ac-backup —— 数据备份插件行（ctx.backup）
//
// 纯库 ac-backup-core 的 owning 行：备份 = Service 方法
// （timer 机制任务 'backup-all' 直调 / WebUI 手工 force——M13）。
// 布局：备份源 = 数据根 <root>（sessions/agents/archive/timer/usage
// 全量）；备份目录 = <root>/backups（walk 防递归已排除）。
// ============================================================
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import {
  BACKUP_INTERVAL_MS,
  BACKUP_KEEP,
  createBackup,
  listBackups,
  type BackupItem,
  type BackupResult,
} from 'ac-backup-core';

/** 行配置 */
export interface BackupRowOptions {
  /** 数据根（备份源；缺省 './data'） */
  root?: string;
  /** 备份目录（缺省 <root>/backups） */
  backupDir?: string;
  /** 保留份数（缺省 4） */
  keep?: number;
  /** 自动备份最小间隔（缺省 7 天；测试可调小） */
  intervalMs?: number;
}

export class BackupService extends Service {
  private sourceDir: string;
  private backupDir: string;
  private readonly keep: number;
  private readonly intervalMs: number;

  constructor(ctx: Context, options: BackupRowOptions = {}) {
    super(ctx, 'backup');
    const root = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');
    this.sourceDir = root;
    this.backupDir = options.backupDir ? path.resolve(options.backupDir) : path.join(root, 'backups');
    this.keep = options.keep ?? BACKUP_KEEP;
    this.intervalMs = options.intervalMs ?? BACKUP_INTERVAL_MS;
  }

  /**
   * 执行一次备份（timer 机制任务 backup-all / 宿主手工触发）。
   * @param opts.force 跳过间隔检查（手工触发）；定时直调走间隔检查
   */
  async run(opts: { force?: boolean } = {}): Promise<BackupResult> {
    const result = createBackup({
      sourceDir: this.sourceDir,
      backupDir: this.backupDir,
      force: opts.force,
      keep: this.keep,
      intervalMs: this.intervalMs,
    });
    if (!result.skipped) {
      this.ctx.logger.info(
        '[backup] 完成: %C (%C MB)',
        result.file,
        (result.size / 1024 / 1024).toFixed(2),
      );
    }
    return result;
  }

  /** 已有备份清单（最新在前） */
  list(): BackupItem[] {
    return listBackups(this.backupDir);
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 数据备份服务（ac-backup 提供）：run + list（timer 机制任务直调口） */
    backup: BackupService;
  }
}

export const name = 'ac-backup';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'backup',
  label: '数据备份',
  description: '定时全量备份（tar 快照；任务表见全局设置·定时任务 __backup_all__）',
  automatic: true,
};


export function apply(ctx: Context, options: BackupRowOptions = {}) {
  ctx.plugin(BackupService, options);
}
