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
// 准入（2026-12 收敛——快照面只服务文本 diff 重建）：仅文本文件
// （前 8 KiB 嗅探）且单文件 ≤ maxBytes（缺省 2 MiB）；超限/二进制
// 只落 skipped 标记，不复制内容。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import { SnapshotStore, looksLikeText, SNAPSHOT_MAX_BYTES, type FileSnapshot } from './store.ts';

/** 行配置 */
export interface FileSnapshotsRowOptions {
  /** 快照根目录（缺省 <dataRoot>/file-snapshots；dataRoot = AGENTCHAT_DATA_ROOT ?? './data'） */
  root?: string;
  /** 单文件快照字节上限（缺省 SNAPSHOT_MAX_BYTES = 2 MiB；<=0 关闭） */
  maxBytes?: number;
}

export class FileSnapshotsService extends Service {
  private store: SnapshotStore;
  /** 行配置层（settings.fileSnapshots 全局层未配置时的回落值） */
  private readonly rowOptions: FileSnapshotsRowOptions;

  constructor(ctx: Context, options: FileSnapshotsRowOptions = {}) {
    super(ctx, 'fileSnapshots');
    const dataRoot = path.resolve(process.env.AGENTCHAT_DATA_ROOT ?? './data');
    this.rowOptions = options;
    this.store = new SnapshotStore({
      root: options.root ?? path.join(dataRoot, 'file-snapshots'),
      maxBytes: options.maxBytes,
    });
    // 全局设置层（settings.fileSnapshots.maxBytes）热更：config/set 落
    // settings → config/changed → 重解析（boot 期已构造时吸收更早写入）
    this.ctx.on('config/changed', () => this.applySettings(), {
      description: '快照上限热更（settings.fileSnapshots 全局层）',
    });
    this.applySettings();
  }

  /**
   * 全局设置层对账：settings.fileSnapshots.maxBytes 覆盖行配置。
   * 形状非法/缺失 = 保持现状（行 config 缺省链不动）。只影响后续
   * ensure/readCurrent——已落快照（含 skipped 标记）是首见事实，不追溯。
   */
  private applySettings(): void {
    const config = this.ctx.get('config', false) as
      | { get<T>(key: string): T | undefined }
      | undefined;
    if (!config) return;
    const layer = config.get<Record<string, unknown>>('settings.fileSnapshots');
    if (layer === undefined) return;
    if (typeof layer !== 'object' || Array.isArray(layer)) {
      this.ctx.logger.warn('[file-snapshots] settings.fileSnapshots 形状非法（保持现状）');
      return;
    }
    const v = layer.maxBytes;
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      this.ctx.logger.warn('[file-snapshots] settings.fileSnapshots.maxBytes 非法（须为 ≥0 有限数；0 = 关闭上限），保持现状');
      return;
    }
    this.store.maxBytes = v;
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
      const resolved = path.resolve(absPath);
      const st = fs.statSync(resolved);
      if (!st.isFile()) return null;
      if (this.store.maxBytes > 0 && st.size > this.store.maxBytes) return null;
      const text = fs.readFileSync(resolved, 'utf-8');
      return looksLikeText(text) ? text : null;
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
  fields: [
    {
      name: 'maxBytes',
      type: 'number',
      min: 0,
      step: 1048576,
      default: SNAPSHOT_MAX_BYTES,
      description: '单文件快照字节上限（超过只落跳过标记不复制内容）。0 = 关闭上限；缺省 2 MiB（2097152）。改后即时生效，只影响后续首见快照。',
    },
  ],
};

export function apply(ctx: Context, options: FileSnapshotsRowOptions = {}) {
  ctx.plugin(FileSnapshotsService, options);
}

export { SnapshotStore, type FileSnapshot } from './store.ts';
