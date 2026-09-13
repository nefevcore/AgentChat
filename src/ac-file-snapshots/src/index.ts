// ============================================================
// ac-file-snapshots —— 会话文件首见快照行（ctx.fileSnapshots）
//
// 方案 C 挂点：ac-fs-tools（write/edit）与 ac-str-replace-editor
//（create/str_replace/insert）的写路径经 withFileMutationQueue 前
// 调 ensure（可选探测——本行缺席不阻断工具行，快照面静默退场）。
// 前端「文件编辑」面板经 RPC fileSnapshots/list 拉快照重算
// 存量文件的初版 diff。
//
// 存储：<dataRoot>/file-snapshots/<conversationId>/<absPath 编码>。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import { SnapshotStore, type FileSnapshot } from './store.ts';

/** 行配置 */
export interface FileSnapshotsRowOptions {
  /** 快照根目录（缺省 <dataRoot>/file-snapshots；dataRoot = AGENTCHAT_DATA_ROOT ?? './data'） */
  root?: string;
}

export class FileSnapshotsService extends Service {
  private store: SnapshotStore;

  constructor(ctx: Context, options: FileSnapshotsRowOptions = {}) {
    super(ctx, 'fileSnapshots');
    const dataRoot = path.resolve(process.env.AGENTCHAT_DATA_ROOT ?? './data');
    this.store = new SnapshotStore({ root: options.root ?? path.join(dataRoot, 'file-snapshots') });
  }

  /**
   * 确保快照（工具写路径前调用）：会话×文件首见时存磁盘内容，
   * 此后幂等 no-op。快照失败不抛（写路径优先——磁盘满等异常只 warn）。
   */
  ensure(conversationId: string, absPath: string): boolean {
    try {
      return this.store.ensure(conversationId, absPath);
    } catch (err) {
      this.ctx.logger.warn(
        '[file-snapshots] 快照写入失败（不影响工具执行）: %C → %C',
        conversationId, absPath, err,
      );
      return false;
    }
  }

  /** 读取单个快照（无 = undefined） */
  get(conversationId: string, absPath: string): FileSnapshot | undefined {
    return this.store.get(conversationId, absPath);
  }

  /** 会话快照清单 */
  list(conversationId: string): FileSnapshot[] {
    return this.store.list(conversationId);
  }

  /**
   * 读文件当前磁盘内容（前端「磁盘终版 + 逆向回推初版」重建的数据源——
   * 无快照的存量文件兜底）。文件不存在/不可读 = null。
   *
   * 威胁模型说明：AgentChat 是本地单机宿主（webui 用户 = 本机用户，
   * 本就有文件系统全权）；本行本就持有 Agent 写路径的绝对路径读写面。
   */
  readCurrent(absPath: string): string | null {
    try {
      return fs.readFileSync(path.resolve(absPath), 'utf-8');
    } catch {
      return null;
    }
  }

  /** 会话删除级联 */
  dropConversation(conversationId: string): number {
    return this.store.dropConversation(conversationId);
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 会话文件首见快照服务（ac-file-snapshots 提供） */
    fileSnapshots: FileSnapshotsService;
  }
}

export const name = 'ac-file-snapshots';

// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明 ──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'file-snapshots',
  label: '文件快照',
  description: '会话文件首见快照（写工具首见磁盘内容存底——文件编辑面板的存量文件初版 diff 数据源）',
  automatic: true,
};

export function apply(ctx: Context, options: FileSnapshotsRowOptions = {}) {
  ctx.plugin(FileSnapshotsService, options);
}

export { SnapshotStore, type FileSnapshot } from './store.ts';
