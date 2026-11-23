// ============================================================
// boot-progress.ts —— 壳 boot 进度文件（协议离 stdio 批 1/2，cr-1125）
//
// shell-protocol-off-stdio-plan §2.1：boot.rows.ready / plugin.load-failed /
// fingerprint.root 三类 stdout TSV 信号的落盘承接形态。单文件覆写（§八
// 裁决：temp + rename 原子写，宿主读无流语义负担）。
//
// 代际校验（调研缺口钉补）：bootId 必填——壳退出不清文件，宿主只采信
// 与 activation.lock 同 bootId 的进度（上代残留文件不得误判本代节拍）。
// 零 cordis 依赖。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 进度文件名（住 agents/<id>/ 域） */
export const BOOT_PROGRESS_FILE = 'boot-progress.json';

export interface PluginLoadFailure {
  plugin: string;
  error: string;
}

export interface BootProgress {
  /** 代际键——与 activation.lock.bootId 一致才可采信 */
  bootId: string;
  writtenAt: string;
  /** 行集装配完成行数（boot.rows.ready 承接） */
  rows?: number;
  /** 主体指纹根（fingerprint.root 承接，R-7 对拍） */
  fingerprintRoot?: string;
  /** 装载失败清单（plugin.load-failed 承接） */
  pluginLoadFailures?: PluginLoadFailure[];
  /** activation 锁接管凭据（cr-1255：判死因子快照——pid 死/租约超限等） */
  lockTakeover?: string;
}

/** 读进度（缺席/损坏 = null——半写窗口被原子写消灭，损坏只剩磁盘故障面） */
export function readBootProgress(agentDir: string): BootProgress | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(agentDir, BOOT_PROGRESS_FILE), 'utf-8')) as BootProgress;
    return typeof raw.bootId === 'string' ? raw : null;
  } catch {
    return null;
  }
}

/** 原子写进度（temp + rename——读写双端共用，无锁窗口） */
export function writeBootProgress(agentDir: string, progress: BootProgress): void {
  const file = path.join(agentDir, BOOT_PROGRESS_FILE);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(progress), 'utf-8');
  fs.renameSync(tmp, file);
}
