// ============================================================
// ac-plugin-registry/src/service.ts —— 插件注册中心（ctx.pluginRegistry）
//
// src PluginHost + registry.ts 的 preview 形态（地图 §3.3）：
//   · owner 手工回收【删除】——注册即归属的机器化推论：装载经
//     this.ctx.plugin()，fiber 父 = 本服务行；工具/监听器注册随各 fiber
//     自动回收（ToolsService 的 unregister(owner) 半边不再需要）
//   · 权限/契约 gate 拆进 ac-plugin-gates 策略行——装载管道的
//     plugin/before-load waterfall 是 seam（不调 next() = 拒绝装载，
//     代码不进进程，fail-closed 原样）
//   · staging 人审管（哈希/只读代理/权限快照/来源锚定）原样继承
//     （算法住 ac-plugin-core 纯库；本服务只做编排与事件）
//   · 三层分工：yml = 出厂态、registry.json = 安装态（永不写回 yml）、
//     settings = 启用表达（M24 X1）
//   · manifest.ui → 可选能力 ctx.get('webui') 挂载（未装 webui 行时
//     静默跳过 UI 半边，后端装载不受影响）
//   · watch：开发期轮询目录哈希自动重载（750ms，src 原样；失败保留旧实例）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Service, type Context, type Fiber, type Plugin } from '@agentchat/cordis';
import {
  appendAudit,
  approveStaging,
  clearLoadHealth,
  findReservedConflict,
  getStagingRecord,
  grantPermissions,
  hashPluginDir,
  isLoadDisabled,
  listInstalled,
  listStaging,
  listStagingFiles,
  loadManifestFromDir,
  readAudit,
  readLoadHealth,
  readRegistry,
  readStagingFile,
  recordLoadFailure,
  rejectStaging,
  reservedConflictError,
  stagePlugin,
  uninstallPlugin as uninstallFromStore,
  LOAD_FAILURE_THRESHOLD,
  patchFilePath,
  readPatchFile,
  setPatchEntry,
  writePatchFile,
  type PatchFileEntry,
  type ApproveResult,
  type PluginAuditEntry,
  type PluginManifest,
  type PluginPermission,
  type PluginSource,
  type PluginStagingRecord,
  type StagingFileContent,
  type StagingFileInfo,
} from 'ac-plugin-core';
import type { WebUiService } from 'ac-webui';

/** cordis 插件模块最小形状（{ name?, inject?, apply }） */
export interface PluginModule {
  name?: string;
  inject?: string[];
  apply(ctx: Context, config?: Record<string, unknown>): unknown;
}

/** 已装载插件记录 */
export interface LoadedPlugin {
  name: string;
  manifest: PluginManifest;
  dir: string;
  entry: string;
  fiber: Fiber;
  module: PluginModule;
  allowedPermissions: PluginPermission[];
  /** 会话级加载归属 Agent（sessionOnly） */
  agentId?: string;
  /** false = 安装记录（重启扫描可恢复）；true = 会话级（重启即失） */
  sessionOnly: boolean;
  watch: boolean;
  watcher?: ReturnType<typeof setInterval>;
  reloading?: boolean;
  uiDisposer?: () => void;
  loadedAt: number;
}

export interface PluginLoadSpec {
  /** 插件目录（manifest.json 所在；manifest 以目录为真相源读取校验） */
  dir: string;
  agentId?: string;
  sessionOnly: boolean;
  /** 授予的权限（缺省 = fs/network；gates 行可经 before-load 变异） */
  allowedPermissions?: PluginPermission[];
  watch?: boolean;
}

/** 装载结果 */
export type PluginLoadOutcome =
  | { status: 'loaded' | 'replaced' | 'restored'; name: string; entry: string; fiberUid: number | null }
  | { status: 'rejected'; name: string; error: string };

/**
 * installFromDir 三态结果（M23 E6/F6）：
 *   · installed —— 安装成（load.status 区分 loaded / rejected=装载失败但安装不受影响）
 *   · rejected  —— 安装未成（暂存已清；error 教下一步动作）
 * idempotent = 同 name+version 且 hash 一致的重装短路（G8：不触发装载重试，
 * 返回已装状态与上次装载结果；重试装载的正路 = bump version）。
 */
export type PluginInstallResult =
  | {
      status: 'installed';
      name: string;
      version: string;
      installedDir: string;
      hash: string;
      /** 装载结果（idempotent 短路时 = 上次装载结果或 unloaded） */
      load: PluginLoadOutcome | { status: 'unloaded'; name: string };
      /** 同 hash 幂等短路标记 */
      idempotent?: boolean;
      /** 升级替换的旧版本备份（装载失败时可手工回旧版） */
      backupDir?: string;
      /** 来源目录在数据根之外等可见警告（F14/L10） */
      warning?: string;
      /** 携带非隔离 UI（显式声明 ui.isolated:false——徽章/回执明示，F7） */
      uiNonIsolated?: boolean;
    }
  | {
      status: 'rejected';
      name?: string;
      error: string;
      /** 来源目录警告（与拒绝理由一并呈现） */
      warning?: string;
    };

/** 熔断跳过记录（plugin/loaded 的 skipped[]；G9 第四态徽章数据源） */
export interface PluginSkipInfo {
  name: string;
  reason: string;
  count: number;
}

/** plugin/before-load waterfall 的可变载体（gates seam） */
export interface PluginLoadCall {
  manifest: PluginManifest;
  /** 授予快照——gates 可变异（收紧/放行）；变异后的值即实际授予 */
  grants: PluginPermission[];
  sessionOnly: boolean;
  watch: boolean;
  agentId?: string;
}

/**
 * 开发插件信息（devScan 扫描面——M22 D7）。
 * 目录布局：`<root>/plugins/<ownerAgentId>/<name>/manifest.json`。
 */
export interface DevPluginInfo {
  name: string;
  version?: string;
  description?: string;
  /** 归属 Agent（owner 目录名；会话装载时作为 agentId） */
  owner: string;
  /** 插件目录（绝对路径；plugin/load 的 dir 直用） */
  dir: string;
  permissions?: PluginPermission[];
}

const WATCH_INTERVAL_MS = 750;
const WATCH_EXCLUDE = new Set(['node_modules', '.git', '.staging', '.backup', '.market']);
/** devScan 顶层跳过项（插件库自有目录；registry.json 是文件，isDirectory 已滤） */
const DEV_SCAN_SKIP = new Set(['.staging', '.backup', '.market']);

export interface PluginRegistryRowOptions {
  /** 数据根（<root>/plugins/ 为插件库；缺省 './data'） */
  root?: string;
  /** 自定义模块导入器（测试注入） */
  importModule?: (url: string) => Promise<unknown>;
  /**
   * boot 首扫等待 plugin-gates 就绪的上限 ms（缺省 3000；G5 屏障——
   * plugin-registry 行先于 gates 行激活，不等待则首批装载过空 waterfall）。
   */
  gatesTimeoutMs?: number;
}

export class PluginRegistryService extends Service {
  private readonly root: string;
  private readonly importModule: (url: string) => Promise<unknown>;
  private readonly gatesTimeoutMs: number;
  private loaded = new Map<string, LoadedPlugin>();
  private loadingNames = new Set<string>();
  /** 装载失败记录（内存态运行诊断——M22 D6；不写 registry.json，安装态不混运行态） */
  private loadFailures = new Map<string, string>();
  /** 熔断跳过记录（G9：进 disabled 集后 loadInstalled 跳过 → failed[] 不再重算） */
  private loadSkipped = new Map<string, PluginSkipInfo>();
  /** gates 就绪屏障（G5：首扫延迟到 gates 行挂上 before-load 监听） */
  private gatesNotified = false;
  private gatesResolve: (() => void) | undefined;

  constructor(ctx: Context, options: PluginRegistryRowOptions = {}) {
    super(ctx, 'pluginRegistry');
    this.root = options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data';
    this.importModule = options.importModule ?? ((u: string) => import(u));
    this.gatesTimeoutMs = options.gatesTimeoutMs ?? 3000;
    // 行卸载 = 全部动态插件回收（fiber 父 = 本行；显式逆序兜底）
    this.ctx.fiber.effect(
      () => async () => {
        for (const record of [...this.loaded.values()].reverse()) {
          await this.disposeRecord(record).catch(() => undefined);
        }
      },
      'pluginRegistry.unloadAll',
    );

    // M25 P3：yml 行熔断（internal/status FAILED ≥3 → patch disable）
    this.watchRowFailures();
  }

  // ============================================================
  // gates 就绪屏障（G5）/ 安全模式（§3.6）
  // ============================================================

  /**
   * plugin-gates 行 apply 时上报就绪（首扫屏障放行）。幂等：重复调用无副作用。
   * 未装载 gates 行的组合：首扫等满 gatesTimeoutMs 后带告警继续（gate 面
   * 可能空转——行组合决定安全策略的既有语义）。
   */
  notifyGatesReady(): void {
    this.gatesNotified = true;
    this.gatesResolve?.();
    this.gatesResolve = undefined;
  }

  /** 首扫屏障：等 gates 就绪（已就绪立即过；超时告警继续） */
  private async awaitGates(): Promise<void> {
    if (this.gatesNotified) return;
    const ready = new Promise<void>((resolve) => {
      this.gatesResolve = resolve;
    });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.gatesTimeoutMs));
    await Promise.race([ready, timeout]);
    if (!this.gatesNotified) {
      this.ctx.logger.warn(
        `[pluginRegistry] plugin-gates 行 ${this.gatesTimeoutMs}ms 内未就绪（或未装载）——首扫继续，权限/契约 gate 面可能空转`,
      );
    }
  }

  /**
   * 安全模式（§3.6）：AGENTCHAT_SAFE_MODE=1（env）或 <root>/.safe-mode
   * 标记存在 → 跳过 loadInstalled（动态插件全体拒载；yml 行与 patch 照常）。
   * boot 日志 + plugin/loaded 透出（UI 横幅，L8）。
   */
  isSafeMode(): boolean {
    if (process.env.AGENTCHAT_SAFE_MODE === '1') return true;
    return fs.existsSync(path.join(this.root, '.safe-mode'));
  }

  // ============================================================
  // staging 人审管（文件域算法住 ac-plugin-core）
  // ============================================================

  /** 暂存插件（发布第一阶段：校验 + 暂存，等宿主审查；串行队列内） */
  async stage(
    sourceDir: string,
    owner = 'host',
    source?: PluginSource,
    options: { uiIsolatedDefault?: boolean } = {},
  ): Promise<PluginStagingRecord> {
    const record = await stagePlugin(this.root, sourceDir, owner, source, options);
    this.ctx.emit('plugin/catalog-changed', { kind: 'staging' });
    return record;
  }

  listStaging(): PluginStagingRecord[] {
    return listStaging(this.root);
  }

  /** 暂存人审查看器：文件清单（只读代理） */
  listStagingFiles(id: string): StagingFileInfo[] {
    return listStagingFiles(this.root, id);
  }

  /** 暂存人审查看器：文件内容（路径守卫 + 大小上限） */
  readStagingFile(id: string, rel: string): StagingFileContent {
    return readStagingFile(this.root, id, rel);
  }

  /** 拒绝暂存（删除目录与记录；审计流水入账——G7） */
  async rejectStaging(id: string): Promise<{ id: string; removedDir?: string }> {
    let name = id;
    let owner = 'host';
    try {
      const record = getStagingRecord(this.root, id);
      name = record.manifest.name;
      owner = record.owner;
    } catch {
      /* 记录不可读（已被清）→ 仍执行删除，审计记 id */
    }
    const result = await rejectStaging(this.root, id);
    await this.audit({
      ts: new Date().toISOString(),
      event: 'reject',
      name,
      owner,
      error: 'staging rejected（暂存被拒绝，目录与记录已清除）',
    }).catch(() => undefined);
    this.ctx.emit('plugin/catalog-changed', { kind: 'staging' });
    return result;
  }

  /** 已安装清单（registry.json 安装态） */
  listInstalled(): ReturnType<typeof listInstalled> {
    return listInstalled(this.root);
  }

  /** 审计流水只读面（RPC/诊断） */
  listAudit(): PluginAuditEntry[] {
    return readAudit(this.root);
  }

  // ============================================================
  // 行偏好层 cordis.patch.yml（M23 A2：owning = 本域，与安装态同域）
  // ============================================================

  /** 读行偏好层（fail-soft；warnings 透出给 RPC/前端呈现） */
  listPatches(): { patches: PatchFileEntry[]; file: string; warnings: string[] } {
    const read = readPatchFile(this.root);
    return { patches: read.patches, file: patchFilePath(this.root), warnings: read.warnings };
  }

  /**
   * 设置一条行偏好（upsert {id, disabled}；原子写 + 串行队列）。
   * **id 必须是装配文件（cordis.yml）的裸行 id**——include 的 patch 匹配
   * 走文件原文 id（applyEntryPatches），namespaced entry.id 永不命中。
   * 三态返回（F12/M5，契约前向兼容）：
   *   · 'hot' —— include 热通道（M25 P3）：进程内有 include 行时经
   *     fiber.update 事务化行树变更（失败回滚保持旧树、cordis.yml 字节
   *     不变——F10 守卫维持），当前进程立即生效。**更新后核对目标行
   *     disabled 态**（2026-08-30 事故：未命中 patch 是 warn+skip 非报错，
   *     fiber.update 成功 ≠ 行已变更——未落地不谎报 hot）；
   *   · 'written' + restartRequired=true —— 已写文件，热通道失败/未落地/
   *     不可用，重启后生效；
   *   · 'no-include-row' —— 写了文件但进程内无 include 行（bootTree
   *     程序化组合等）：偏好无消费者。
   */
  async setPatch(
    id: string,
    disabled: boolean,
  ): Promise<{
    state: 'hot' | 'written' | 'no-include-row';
    restartRequired?: boolean;
    patches: PatchFileEntry[];
  }> {
    const patches = await setPatchEntry(this.root, id, disabled);
    // 行熔断计数联动：再启用即清计数（与动态插件熔断同款生命周期）
    this.rowFailures.delete(id);
    // include 热通道：fiber.update({path, patches}) 事务化更新行树
    // （path 必须与 include 行 config 原文一致——internal/update handler
    // 按 path 比对分派；测试用独立 yml 时与生产不同）
    const include = this.includeInfo();
    if (include) {
      try {
        await include.fiber.update({ path: include.path, patches });
        // 假阳性防护：核对目标行 disabled 态是否真的落地
        if (!this.rowPatchLanded(id, disabled)) {
          this.ctx.logger.warn(
            `[pluginRegistry] setPatch("${id}") 热更新未落地（patch id 不在装配文件原文——须为 yml 裸 id），回落重启生效`,
          );
          return { state: 'written', restartRequired: true, patches };
        }
        return { state: 'hot', patches };
      } catch (err: unknown) {
        this.ctx.logger.warn(
          `[pluginRegistry] 行偏好热更新失败（回滚保持旧树，回落重启生效）: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { state: 'written', restartRequired: true, patches };
      }
    }
    if (!this.hasIncludeRow()) {
      this.ctx.logger.warn(
        `[pluginRegistry] setPatch("${id}") 已写入 ${patchFilePath(this.root)}，但当前进程无 include 行（程序化组合）——偏好无消费者`,
      );
      return { state: 'no-include-row', patches };
    }
    return { state: 'written', restartRequired: true, patches };
  }

  /** 热更新落地核对：装配树中该裸 id 行的 disabled 态是否等于目标 */
  private rowPatchLanded(id: string, disabled: boolean): boolean {
    const loader = this.ctx.get('loader', false) as
      | {
          entries(): Array<{
            options?: { id?: unknown };
            subtree?: unknown;
            disabled?: boolean;
          }>;
        }
      | undefined;
    if (!loader) return false;
    for (const entry of loader.entries()) {
      if (entry.options?.id !== id) continue;
      if (entry.subtree !== undefined && entry.subtree !== null) continue; // include 行自身（子树载体）——同名防御
      return entry.disabled === disabled;
    }
    return false;
  }

  // ============================================================
  // 还原模式（2026-08-30）：factory（清空停用 = 出厂全量装配）/
  // minimal（只保留最小可运行集，其余行全部写入停用——安全模式基线）
  // ============================================================

  /**
   * 最小可运行集（yml 裸行 id）：RPC 面依赖闭包（web-api 全部 inject 的
   * 归一行名 → entry id）+ 会话链（llm/loop/router/conversation/session）
   * + 传输面（web-server/ws-bridge/webui）+ 急救通道（plugin-registry/
   * patch-rpc）+ 安全双行（security/plugin-gates）+ 一个 provider
   * （llm-openai，裸聊天能力）。不含 persona/system-prompt/memory/技能/
   * 工具行——聊天为裸循环，仅作诊断基线。
   */
  static readonly MINIMAL_CORE_ENTRY_IDS: ReadonlySet<string> = new Set([
    'logger-console', 'timer', 'tools', 'jobs', 'config', 'credentials',
    'agent-store', 'agents', 'agents-dir', 'llm', 'llm-openai', 'agent-loop',
    'router', 'conversation', 'session', 'group', 'usage', 'durable-interaction',
    'timers', 'backup', 'workspace', 'security', 'web-server', 'ws-bridge',
    'webui', 'web-api', 'plugin-registry', 'plugin-gates', 'patch-rpc',
  ]);

  /**
   * 还原行偏好层（批量）：
   *   · 'factory' —— 清空全部停用条目 → 出厂 cordis.yml 全量装配；
   *   · 'minimal' —— 装配树现有行中，最小核心集以外的全部写入停用
   *     （只关在册行——不写陈旧 id；include 子树载体行不参与）。
   * 热通道同 setPatch：有 include 行经 fiber.update 事务生效并逐条核对
   * 落地；未落地/无 include → written（重启生效）。
   */
  async resetPatches(
    mode: 'factory' | 'minimal',
  ): Promise<{
    state: 'hot' | 'written' | 'no-include-row';
    restartRequired?: boolean;
    patches: PatchFileEntry[];
  }> {
    let patches: PatchFileEntry[];
    if (mode === 'factory') {
      patches = [];
    } else {
      const ids = PluginRegistryService.enumerateDisablableEntryIds(this.ctx);
      if (ids === undefined) {
        throw new Error('无装配树可枚举（进程非 loader 组合）——minimal 模式不可用，可用 factory');
      }
      const core = PluginRegistryService.MINIMAL_CORE_ENTRY_IDS;
      patches = ids
        .filter((id) => !core.has(id))
        .sort()
        .map((id) => ({ id, disabled: true }));
    }
    await writePatchFile(this.root, patches);
    this.rowFailures.clear();
    const include = this.includeInfo();
    if (include) {
      try {
        await include.fiber.update({ path: include.path, patches });
        const allLanded = patches.every((p) => this.rowPatchLanded(p.id, true));
        if (!allLanded) {
          this.ctx.logger.warn('[pluginRegistry] resetPatches(minimal) 热更新部分未落地，回落重启生效');
          return { state: 'written', restartRequired: true, patches };
        }
        return { state: 'hot', patches };
      } catch (err: unknown) {
        this.ctx.logger.warn(
          `[pluginRegistry] 还原热更新失败（回滚保持旧树，回落重启生效）: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { state: 'written', restartRequired: true, patches };
      }
    }
    if (!this.hasIncludeRow()) {
      return { state: 'no-include-row', patches };
    }
    return { state: 'written', restartRequired: true, patches };
  }

  /** 装配树中可停用的行裸 id（跳过子树载体行；无 loader → undefined） */
  static enumerateDisablableEntryIds(ctx: Context): string[] | undefined {
    const loader = ctx.get('loader', false) as
      | {
          entries(): Array<{
            options?: { id?: unknown };
            subtree?: unknown;
          }>;
        }
      | undefined;
    if (!loader) return undefined;
    const ids = new Set<string>();
    for (const entry of loader.entries()) {
      if (entry.subtree !== undefined && entry.subtree !== null) continue; // include 行自身
      const id = entry.options?.id;
      if (typeof id === 'string' && id) ids.add(id);
    }
    return [...ids].sort();
  }

  /** 进程内是否有 include 行（yml 配置驱动组合） */
  private hasIncludeRow(): boolean {
    return [...this.ctx.registry.values()].some((r) => r.name === '@agentchat/cordis-include');
  }

  /** include 行 fiber + config path（热通道；无活跃 include 行 = undefined） */
  private includeInfo():
    | { fiber: Fiber & { update(config: unknown): Promise<void> }; path: string }
    | undefined {
    const loader = this.ctx.get('loader', false) as
      | {
          entries(): Array<{
            subtree?: unknown;
            fiber?: Fiber;
            options?: { config?: { path?: unknown } };
          }>;
        }
      | undefined;
    if (!loader) return undefined;
    for (const entry of loader.entries()) {
      const tree = entry.subtree as { refresh?: unknown; filename?: string } | undefined;
      // include 子树判据（与 ac-app ecosystem findIncludeEntry 同款）
      if (!tree || !('refresh' in tree) || !('filename' in tree)) continue;
      const path = entry.options?.config?.path;
      const fiber = entry.fiber;
      if (fiber && fiber.uid !== null && typeof path === 'string' && path) {
        return { fiber: fiber as Fiber & { update(config: unknown): Promise<void> }, path };
      }
    }
    return undefined;
  }

  // ============================================================
  // M25 P3：yml 行熔断（internal/status；与动态插件熔断同款生命周期）
  // FAILED ≠ 级联 PENDING：只计行自身 fiber 的 FAILED 转换（inject 缺失
  // 停 PENDING 不计）；失败 ≥3 写 patch disable（热通道即时生效）；
  // setPatch 再启用清计数。
  // ============================================================
  /** yml 行失败计数（entry id → 连续失败次数；再启用清零） */
  private rowFailures = new Map<string, number>();

  /** internal/status 订阅：行 fiber FAILED → 计数 + 熔断写 patch */
  private watchRowFailures(): void {
    this.ctx.on(
      'internal/status',
      (fiber: Fiber) => {
        if (fiber.uid === null) return;
        if (!this.fiberFailed(fiber)) return;
        // 归属：沿祖先链找最近 loader entry（yml 行；动态/程序化 fiber
        // 无 entry 不计——动态插件熔断归 .load-health 两层化）
        const entryId = this.rowEntryIdOf(fiber);
        if (entryId === undefined) return;
        const count = (this.rowFailures.get(entryId) ?? 0) + 1;
        this.rowFailures.set(entryId, count);
        if (count >= 3) {
          this.rowFailures.delete(entryId); // 熔断后不再累计（写 patch 一次性）
          void this.setPatch(entryId, true)
            .then((r) => {
              this.ctx.logger.warn(
                `[pluginRegistry] yml 行 "${entryId}" 连续失败 ${count} 次已熔断：cordis.patch.yml 写入停用（${r.state === 'hot' ? '热通道已生效——当前进程行已卸下' : '重启后生效'}）。再启用 = 行偏好开关重新打开（清计数）。`,
              );
            })
            .catch(() => undefined);
        }
      },
      { global: true },
    );
  }

  /** fiber 是否 FAILED（FiberState 私有枚举——state 字符串近似 + _error 兜底） */
  private fiberFailed(fiber: Fiber): boolean {
    const f = fiber as unknown as { state: string; _error?: unknown };
    return f.state === 'failed' || f._error !== undefined;
  }

  /** fiber → 顶层 yml 行裸 id（沿祖先链最近 entry；无 entry = undefined）。
   *  裸 id（entry.options.id）——patch 文件按装配文件原文 id 匹配，
   *  namespaced entry.id（<树前缀>:<裸id>）永不命中 */
  private rowEntryIdOf(fiber: Fiber): string | undefined {
    let cursor: Fiber | undefined = fiber;
    while (cursor) {
      const entry = (cursor as unknown as { entry?: { id?: string; options?: { id?: string } } }).entry;
      if (entry?.options?.id) return entry.options.id;
      if (entry?.id) return entry.id;
      const parent: Fiber | undefined = cursor.parent?.fiber;
      if (parent === undefined || parent === cursor) break; // root 自指 → 终止
      cursor = parent;
    }
    return undefined;
  }

  /** 审计追加（失败不阻断主流程——吞错记日志） */
  private async audit(entry: PluginAuditEntry): Promise<void> {
    try {
      await appendAudit(this.root, entry);
    } catch (err: unknown) {
      this.ctx.logger.warn(
        `[pluginRegistry] 审计流水写入失败（${entry.event}/${entry.name}）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 批准暂存并安装（文件域：哈希校验/权限快照/旧版本备份 + 可补偿分步）
   * + 立即装载。装载失败不影响安装（已入 registry.json，下次重启扫描恢复）。
   * 审计流水 install + load 同入账（G7）。
   */
  async approve(id: string, grants?: unknown): Promise<ApproveResult & { load: PluginLoadOutcome }> {
    let sourceDir: string | undefined;
    let owner = 'host';
    try {
      const staging = getStagingRecord(this.root, id);
      sourceDir = staging.sourceDir;
      owner = staging.owner;
    } catch {
      /* 记录不可读 → proceed（approveStaging 会抛可诊断错误） */
    }
    const result = await approveStaging(this.root, id, grants);
    // install 强制清熔断记录（F4：防"修复后永远装不上"死锁）
    await clearLoadHealth(this.root, result.name).catch(() => undefined);
    this.loadSkipped.delete(result.name);
    const load = await this.load({
      dir: result.installedDir,
      sessionOnly: false,
      allowedPermissions: result.permissions,
    });
    await this.audit({
      ts: new Date().toISOString(),
      event: 'install',
      name: result.name,
      owner,
      ...(sourceDir ? { sourceDir } : {}),
      hash: result.hash,
      grants: result.permissions,
      version: result.version,
      outcome: load.status === 'rejected' ? 'installed+failed' : 'installed+loaded',
      ...(load.status === 'rejected' ? { error: load.error } : {}),
      ...(result.replaced ? { backupDir: result.replaced.backupDir } : {}),
    });
    this.ctx.emit('plugin/installed', {
      name: result.name,
      version: result.version,
      dir: result.installedDir,
      permissions: result.permissions,
      ...(result.source ? { source: result.source } : {}),
    });
    this.ctx.emit('plugin/catalog-changed', { kind: 'installed' });
    return { ...result, load };
  }

  /**
   * 免审安装复合口（M23 §3.1：install_plugin 的服务侧）。
   * 一律免审（stage → 自动 approve → 立即装载）；免审快照 = manifest
   * permissions 全集（不暴露 grants——F14/L5）；同 hash 幂等短路不重试
   * 装载（G8）；保留字护栏拒绝（F13/G1）；数据根外来源附可见警告 +
   * 审计记原始 sourceDir（F14/L10）。三态结果见 PluginInstallResult。
   */
  async installFromDir(
    sourceDir: string,
    owner: string,
    grants?: PluginPermission[],
  ): Promise<PluginInstallResult> {
    const resolved = path.resolve(sourceDir);
    const warning = this.outOfRootWarning(resolved);
    const fail = async (error: string, name?: string): Promise<PluginInstallResult> => {
      await this.audit({
        ts: new Date().toISOString(),
        event: 'reject',
        name: name ?? '(unknown)',
        owner,
        sourceDir: resolved,
        error,
      });
      return { status: 'rejected', ...(name !== undefined ? { name } : {}), error, ...(warning ? { warning } : {}) };
    };

    let manifest: PluginManifest;
    try {
      manifest = loadManifestFromDir(resolved);
    } catch (err: unknown) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    // 保留字护栏：内置注册名冲突可诊断拒绝（代码不进进程）
    const conflict = findReservedConflict(manifest);
    if (conflict) return fail(reservedConflictError(conflict, manifest.name), manifest.name);

    // 同 hash 幂等（F14/L4、G8）：同 name+version 且 hash 一致 → 返回已装
    // 状态与上次装载结果，不触发装载重试；hash 不一致 → 教 bump version。
    const hash = hashPluginDir(resolved);
    const installed = readRegistry(this.root).plugins[manifest.name];
    if (installed) {
      if (installed.manifest.version === manifest.version) {
        if (installed.hash === hash) {
          const current = this.loaded.get(manifest.name);
          const lastFailure = this.loadFailures.get(manifest.name);
          const lastOutcome: PluginLoadOutcome | { status: 'unloaded'; name: string } = current
            ? { status: 'loaded', name: manifest.name, entry: current.entry, fiberUid: current.fiber.uid }
            : lastFailure !== undefined
              ? { status: 'rejected', name: manifest.name, error: lastFailure }
              : { status: 'unloaded', name: manifest.name };
          return {
            status: 'installed',
            name: manifest.name,
            version: manifest.version,
            installedDir: path.join(this.root, 'plugins', installed.dir),
            hash,
            load: lastOutcome,
            idempotent: true,
            ...(warning ? { warning } : {}),
          };
        }
        return fail(
          `插件 "${manifest.name}@${manifest.version}" 已安装且内容哈希不一致（已装 ${installed.hash.slice(0, 8)}… / 本次 ${hash.slice(0, 8)}…）。` +
            '重装同版本且内容有改动不会被接受；请先在 manifest.json 中 bump version（如 1.0.0 → 1.0.1）后重新 install_plugin。',
          manifest.name,
        );
      }
    }

    // stage → 自动 approve（免审：无人参与）→ 立即装载
    // F7：免审通道 UI 缺省 isolated（浏览器侧常驻面对冲——可读会话流/以
    // 用户会话身份调全部 RPC；显式声明 ui.isolated:false 才进宿主上下文）
    let stagingId: string;
    try {
      stagingId = (await this.stage(resolved, owner, undefined, { uiIsolatedDefault: true })).id;
    } catch (err: unknown) {
      return fail(`暂存失败: ${err instanceof Error ? err.message : String(err)}`, manifest.name);
    }
    let approveResult: ApproveResult;
    try {
      approveResult = await approveStaging(this.root, stagingId, grants ?? manifest.permissions ?? []);
    } catch (err: unknown) {
      // 安装未成：清暂存（E6——rejected 态暂存已清）
      await this.rejectStaging(stagingId).catch(() => undefined);
      return fail(err instanceof Error ? err.message : String(err), manifest.name);
    }

    // install 强制清熔断记录（F4，含 bump version 重装）
    await clearLoadHealth(this.root, approveResult.name).catch(() => undefined);
    this.loadSkipped.delete(approveResult.name);
    const load = await this.load({
      dir: approveResult.installedDir,
      sessionOnly: false,
      allowedPermissions: approveResult.permissions,
    });
    await this.audit({
      ts: new Date().toISOString(),
      event: 'install',
      name: approveResult.name,
      owner,
      sourceDir: resolved,
      hash: approveResult.hash,
      grants: approveResult.permissions,
      version: approveResult.version,
      outcome: load.status === 'rejected' ? 'installed+failed' : 'installed+loaded',
      ...(load.status === 'rejected' ? { error: load.error } : {}),
      ...(approveResult.replaced ? { backupDir: approveResult.replaced.backupDir } : {}),
    });
    this.ctx.emit('plugin/installed', {
      name: approveResult.name,
      version: approveResult.version,
      dir: approveResult.installedDir,
      permissions: approveResult.permissions,
    });
    this.ctx.emit('plugin/catalog-changed', { kind: 'installed' });
    return {
      status: 'installed',
      name: approveResult.name,
      version: approveResult.version,
      installedDir: approveResult.installedDir,
      hash: approveResult.hash,
      load,
      ...(approveResult.replaced ? { backupDir: approveResult.replaced.backupDir } : {}),
      ...(approveResult.manifest.ui?.isolated === false ? { uiNonIsolated: true } : {}),
      ...(warning ? { warning } : {}),
    };
  }

  /** 数据根外来源警告（F14/L10：数据根外目录 = 事实上的第三方来源） */
  private outOfRootWarning(resolvedDir: string): string | undefined {
    const rootAbs = path.resolve(this.root);
    if (resolvedDir === rootAbs || resolvedDir.startsWith(rootAbs + path.sep)) return undefined;
    return `来源目录在数据根（${rootAbs}）之外——免审范围是自开发自安装（政策面），数据根外目录等同第三方来源，请确认信任该代码。`;
  }

  /**
   * 卸载：装载回收 + 文件域（目录移 .backup + registry 移除）+ 熔断记录
   * 清除（F4）+ 审计流水（G7：卸载史不可追，必须同入流水）。
   * 回执消费方（H4）：已共享给哪些 Agent（capabilities 含 agent:<owner>）。
   */
  async uninstall(name: string): Promise<{ name: string; backupDir?: string; consumers?: string[] }> {
    const record = this.loaded.get(name);
    if (record) await this.disposeRecord(record);
    this.loadFailures.delete(name); // 卸载即终结：残留失败记录不再有意义
    const consumers = this.consumersOfInstalled(name);
    const result = await uninstallFromStore(this.root, name);
    await clearLoadHealth(this.root, name).catch(() => undefined);
    this.loadSkipped.delete(name);
    await this.audit({
      ts: new Date().toISOString(),
      event: 'uninstall',
      name,
      ...(result.backupDir ? { backupDir: result.backupDir } : {}),
      ...(consumers.length > 0 ? { outcome: `consumers: ${consumers.join(', ')}` } : {}),
    });
    this.ctx.emit('plugin/catalog-changed', { kind: 'installed' });
    return { ...result, ...(consumers.length > 0 ? { consumers } : {}) };
  }

  /**
   * 已安装插件的消费方（H4）：owner 之外、capabilities 含 `agent:<owner>`
   * 的 Agent 清单（共享 = 他人显式加 owner tag，B4/E2）。无共享 → 空数组。
   */
  private consumersOfInstalled(name: string): string[] {
    const installed = readRegistry(this.root).plugins[name];
    const owner = this.loaded.get(name)?.agentId ?? installed?.owner;
    if (!owner) return [];
    const agents = this.ctx.get('agents') as
      | {
          list(): Array<{ id: string; tags?: string[]; settings?: Record<string, unknown> }>;
          settingsOf(id: string, n: string): Record<string, unknown>;
        }
      | undefined;
    if (!agents) return [];
    const out: string[] = [];
    for (const agent of agents.list()) {
      if (agent.id === owner) continue;
      // M24 X4：共享 = 他人显式加 owner tag（单源）；存量
      // settings.security.capabilities 覆盖层继续生效（与 ac-security 门禁同语义）
      const tag = `agent:${owner}`;
      let shared = (agent.tags ?? []).includes(tag);
      if (!shared) {
        const security = agents.settingsOf(agent.id, 'security');
        const caps = Array.isArray(
          security && typeof security === 'object' ? (security as { capabilities?: unknown }).capabilities : undefined,
        )
          ? ((security as { capabilities?: unknown[] }).capabilities as unknown[])
          : [];
        shared = caps.includes(tag);
      }
      if (shared) out.push(agent.id);
    }
    return out;
  }

  // ============================================================
  // 装载管道：before-load waterfall（gates seam）→ import → fiber
  // ============================================================

  /**
   * 启动扫描：装载全部已安装插件。
   * M23 补偿控制（§3.6）：
   *   · 安全模式（AGENTCHAT_SAFE_MODE / .safe-mode）→ 全体跳过 + 告警（L8）
   *   · gates 就绪屏障（G5：首扫延迟到 fiber 树稳定——gates 行挂上
   *     before-load 监听后才扫，防首批装载过空 waterfall）
   *   · 熔断（E4：.load-health disabled 集）→ 跳过 + 告警 + skipped[] 透出（G9）
   *   · hash 复验（F3：hashPluginDir(dir) !== record.hash → 拒载记 failed[]，
   *     防 bash 篡改已装目录重启静默装载调包代码）
   *   · 失败计数（F4：与 install 期同源——失败立即计数，成功清零）
   */
  async loadInstalled(): Promise<PluginLoadOutcome[]> {
    if (this.isSafeMode()) {
      this.ctx.logger.warn(
        '[pluginRegistry] 安全模式生效（AGENTCHAT_SAFE_MODE / .safe-mode）——已安装插件本次不装载（yml 行与 patch 照常）',
      );
      return [];
    }
    await this.awaitGates();
    const outcomes: PluginLoadOutcome[] = [];
    for (const record of listInstalled(this.root)) {
      const name = record.manifest.name;
      if (this.loaded.has(name) || this.isLoading(name)) continue;
      const dir = path.join(this.root, 'plugins', record.dir);
      if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
        this.ctx.logger.warn(`已安装插件 "${name}" 目录缺失，跳过加载`);
        this.loadFailures.set(name, `已安装目录缺失: ${dir}`);
        continue;
      }
      // 熔断：disabled 集 → 跳过（不再重算 failed[]，skipped[] 透出第四态）
      if (isLoadDisabled(this.root, name)) {
        const disabledRecord = readLoadHealth(this.root).disabled[name];
        const reason = disabledRecord?.reason ?? '连续装载失败已熔断';
        this.loadSkipped.set(name, {
          name,
          reason,
          count: disabledRecord?.count ?? LOAD_FAILURE_THRESHOLD,
        });
        this.ctx.logger.warn(`[pluginRegistry] 已安装插件 "${name}" 处于熔断态，本次跳过（复位 = 重装 bump version / uninstall / 删 .load-health.json）`);
        continue;
      }
      // hash 复验：不符拒载（F3）——文案引导"重装或 uninstall"防良性手工
      // 改动被静默熔断（不计入熔断计数：内容审计与崩溃熔断是两件事）
      if (hashPluginDir(dir) !== record.hash) {
        const error = `已安装目录内容哈希与安装记录不一致（可能被改动）: ${dir}——拒载。确认改动是自己的 → bump version 后 install_plugin 重装；不要该插件 → uninstall_plugin；想恢复原版 → 从 .backup 取回后重装。`;
        this.ctx.logger.warn(`[pluginRegistry] ${error}`);
        this.loadFailures.set(name, error);
        continue;
      }
      outcomes.push(
        await this.load({
          dir,
          sessionOnly: false,
          allowedPermissions: record.permissions,
        }).catch((err: unknown) => ({
          status: 'rejected' as const,
          name,
          error: err instanceof Error ? err.message : String(err),
        })),
      );
    }
    return outcomes;
  }

  /** 装载失败清单（boot 扫描/装载管道 rejected outcome；成功装载自动清除） */
  listFailed(): Array<{ name: string; error: string }> {
    return [...this.loadFailures.entries()].map(([name, error]) => ({ name, error }));
  }

  /** 熔断跳过清单（G9：plugin/loaded 的 skipped[]；徽章第四态"已熔断"） */
  listSkipped(): PluginSkipInfo[] {
    return [...this.loadSkipped.values()];
  }

  /**
   * 开发目录扫描（M22 D7）：`<root>/plugins/` 一层遍历——
   * 跳过 .staging/.backup/.market 与直接含 manifest.json 的平铺目录（= 已安装
   * 插件）；其余视为 owner 目录，再扫其下一层子目录的 manifest.json（损坏
   * 跳过不阻断），owner = 目录名。同时透出数据根（前端路径提示用）。
   */
  devScan(): { root: string; dev: DevPluginInfo[] } {
    const dev: DevPluginInfo[] = [];
    const base = path.join(this.root, 'plugins');
    let owners: fs.Dirent[];
    try {
      owners = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return { root: this.root, dev }; // plugins/ 尚不存在 → 空扫描
    }
    for (const owner of owners) {
      if (!owner.isDirectory() || DEV_SCAN_SKIP.has(owner.name)) continue;
      const ownerDir = path.join(base, owner.name);
      if (fs.existsSync(path.join(ownerDir, 'manifest.json'))) continue; // 平铺已安装目录
      let subs: fs.Dirent[];
      try {
        subs = fs.readdirSync(ownerDir, { withFileTypes: true });
      } catch {
        continue; // owner 目录瞬时不可读 → 跳过
      }
      for (const sub of subs) {
        if (!sub.isDirectory()) continue;
        const dir = path.join(ownerDir, sub.name);
        try {
          const manifest = loadManifestFromDir(dir);
          dev.push({
            name: manifest.name,
            ...(manifest.version ? { version: manifest.version } : {}),
            ...(manifest.description ? { description: manifest.description } : {}),
            owner: owner.name,
            dir,
            ...(manifest.permissions && manifest.permissions.length > 0 ? { permissions: manifest.permissions } : {}),
          });
        } catch {
          /* manifest 损坏/缺失 → 跳过不阻断 */
        }
      }
    }
    dev.sort((a, b) => a.name.localeCompare(b.name));
    return { root: this.root, dev };
  }

  /** 同名装载在途标记（组合行与启动扫描并发首装去重） */
  isLoading(name: string): boolean {
    return this.loadingNames.has(name);
  }

  has(name: string): boolean {
    return this.loaded.has(name);
  }

  listLoaded(): Array<Omit<LoadedPlugin, 'fiber' | 'module' | 'watcher'>> {
    return [...this.loaded.values()].map(({ fiber: _f, module: _m, watcher: _w, ...rest }) => rest);
  }

  /**
   * 装载（或同名重载）插件。
   * 管道：plugin/before-load waterfall（gates 决策/变异授予；不调
   * next() = 拒绝——代码不进进程）→ inject 可满足性 → 动态 import
   * （cache-busting）→ ctx.plugin 激活（fiber 父 = 本行）→ ui 挂载。
   * 同名替换失败时回滚恢复旧实例（src 回滚语义原样）。
   */
  async load(spec: PluginLoadSpec): Promise<PluginLoadOutcome> {
    const check = loadManifestFromDir(spec.dir); // manifest 以目录为真相源读取校验
    // F7：Agent 自服务装载（register_plugin 会话级）的 manifest.ui 缺省
    // isolated（仅内存缺省——磁盘 manifest 不动，hash 复验不受影响；
    // 宿主 UI 装载 plugin/load 走人审语义不设缺省）
    if (spec.agentId !== undefined && check.ui && check.ui.isolated === undefined) {
      check.ui = { ...check.ui, isolated: true };
    }
    const call: PluginLoadCall = {
      manifest: check,
      grants: spec.allowedPermissions ?? grantPermissions(undefined),
      sessionOnly: spec.sessionOnly,
      watch: spec.watch === true,
      ...(spec.agentId !== undefined ? { agentId: spec.agentId } : {}),
    };
    this.loadingNames.add(check.name);
    try {
      // gates seam：waterfall 拒绝（自返回 rejected outcome）即短路。
      // 运行态失败记录（M22 D6）：rejected 记因（前端与 installed 交叉出
      // "装载失败"徽章），成功装载即清除。
      const outcome = await this.ctx.waterfall('plugin/before-load', call, () => this.loadInner(spec, call));
      if (outcome.status === 'rejected') this.loadFailures.set(outcome.name, outcome.error);
      else this.loadFailures.delete(outcome.name);
      // 熔断计数（F4/G8）：非会话装载失败立即计数（与 loadInstalled 同源——
      // install 期失败不等重启周期）；成功清零。会话级装载不入 boot 恢复面，不计数。
      if (!call.sessionOnly) {
        if (outcome.status === 'rejected') {
          const after = await recordLoadFailure(this.root, check.name, outcome.error).catch(() => undefined);
          if (after && 'reason' in after) {
            this.loadSkipped.set(check.name, { name: check.name, reason: after.reason, count: after.count });
            this.ctx.logger.warn(
              `[pluginRegistry] 插件 "${check.name}" 连续装载失败 ${after.count} 次，已熔断（后续 boot 跳过；复位 = bump version 重装 / uninstall）`,
            );
          }
        } else {
          await clearLoadHealth(this.root, check.name).catch(() => undefined);
          this.loadSkipped.delete(check.name);
        }
      }
      // 审计流水：load 事件全入账（G7——装载史取证；含 boot 扫描与会话装载）
      await this.audit({
        ts: new Date().toISOString(),
        event: 'load',
        name: check.name,
        ...(spec.agentId !== undefined ? { owner: spec.agentId } : {}),
        outcome: outcome.status,
        ...(outcome.status === 'rejected' ? { error: outcome.error } : {}),
      });
      return outcome;
    } finally {
      this.loadingNames.delete(check.name);
    }
  }

  private async loadInner(spec: PluginLoadSpec, call: PluginLoadCall): Promise<PluginLoadOutcome> {
    const manifest = call.manifest;
    const allowedPermissions = call.grants;
    const dir = path.resolve(spec.dir);
    const entry = path.resolve(dir, manifest.entry);
    if (!fs.existsSync(entry)) {
      return { status: 'rejected', name: manifest.name, error: `插件入口不存在: ${entry}` };
    }

    // inject 依赖缺失时 ctx.plugin 停在 PENDING（await 永不返回）——
    // 装载前显式检查，给出可诊断错误而不是挂死调用方
    for (const dep of manifest.inject ?? []) {
      if (this.ctx.get(dep) === undefined) {
        return { status: 'rejected', name: manifest.name, error: `插件 "${manifest.name}" 依赖的 ctx 服务 "${dep}" 未提供（inject 声明不可满足）` };
      }
    }

    // 会话级加载不得覆盖已安装插件（installed 的替换走发布流程）
    const existing = this.loaded.get(manifest.name);
    if (existing && call.sessionOnly && !existing.sessionOnly) {
      return { status: 'rejected', name: manifest.name, error: `插件 "${manifest.name}" 已作为全局插件安装，会话级加载被拒绝（请改用发布流程）` };
    }

    // cache-busting：dev 模式修改入口后重载可得新模块
    const url = pathToFileURL(entry).href + `?t=${Date.now()}`;
    let mod: unknown;
    try {
      mod = await this.importModule(url);
    } catch (err: unknown) {
      return {
        status: 'rejected',
        name: manifest.name,
        error: `动态 import 失败（${entry}）: ${err instanceof Error ? err.message : String(err)}。TS 插件需在 tsx 运行态加载，发布前请保证入口可被 Node ESM 解析。`,
      };
    }
    const plugin = mod as PluginModule;
    if (!plugin || typeof plugin.apply !== 'function') {
      return { status: 'rejected', name: manifest.name, error: `插件模块缺少 apply(ctx, config)（${entry}）` };
    }
    if (typeof plugin.name === 'string' && plugin.name !== manifest.name) {
      return { status: 'rejected', name: manifest.name, error: `插件模块 name "${plugin.name}" 与 manifest.name "${manifest.name}" 不一致` };
    }

    // 旧实例暂存（新模块激活失败时回滚恢复），然后回收旧 fiber
    const old = existing;
    if (old) await this.disposeRecord(old);

    let fiber: Fiber & PromiseLike<Fiber>;
    // provides 对账基线（§3.2/3.3：装载后对账到名字级——不符 warn 不阻断；
    // 读取经 ctx.get——root-traced，见 reconcileProvides 注）
    const toolsSvc = this.ctx.get('tools') as { list(): Array<{ name: string }> } | undefined;
    const llmSvc = this.ctx.get('llm') as { providers(): string[] } | undefined;
    const toolsBefore = new Set(toolsSvc?.list().map((t) => t.name) ?? []);
    const providersBefore = new Set(llmSvc?.providers() ?? []);
    try {
      fiber = this.ctx.plugin(plugin as unknown as Plugin, manifest.config ?? {}) as Fiber & PromiseLike<Fiber>;
      await fiber;
    } catch (err: unknown) {
      // apply 抛错可能留下半注册：cordis fiber 自带回滚；旧实例存在则恢复
      if (old) {
        try {
          const restored = await this.activate(old.module, old.manifest);
          this.mountRecord(old, restored);
          this.ctx.emit('plugin/reloaded', {
            name: old.name,
            status: 'failed',
            error: `新版本激活失败，已回滚旧版本: ${err instanceof Error ? err.message : String(err)}`,
          });
          return {
            status: 'restored',
            name: manifest.name,
            entry,
            fiberUid: restored.uid,
          };
        } catch (restoreErr: unknown) {
          this.ctx.emit('plugin/reloaded', {
            name: old.name,
            status: 'failed',
            error: `新版本激活失败且旧版本回滚失败: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`,
          });
          return { status: 'rejected', name: manifest.name, error: `激活失败且旧版本回滚失败: ${err instanceof Error ? err.message : String(err)}；restore: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}` };
        }
      }
      return { status: 'rejected', name: manifest.name, error: `激活失败: ${err instanceof Error ? err.message : String(err)}` };
    }

    const record: LoadedPlugin = {
      name: manifest.name,
      manifest,
      dir,
      entry,
      fiber,
      module: plugin,
      allowedPermissions,
      ...(spec.agentId !== undefined ? { agentId: spec.agentId } : {}),
      sessionOnly: call.sessionOnly,
      watch: call.watch,
      loadedAt: Date.now(),
    };
    this.mountRecord(record, fiber);
    this.reconcileProvides(record, toolsBefore, providersBefore);

    if (old) {
      this.ctx.emit('plugin/reloaded', { name: manifest.name, status: 'replaced' });
    } else {
      this.ctx.emit('plugin/catalog-changed', { kind: call.sessionOnly ? 'session' : 'installed' });
    }
    return { status: old ? 'replaced' : 'loaded', name: manifest.name, entry, fiberUid: fiber.uid };
  }

  /**
   * provides 装载后对账（§3.2/§3.3：对账到名字级——不符 **warn 不阻断**）。
   * tools/llmProviders 与激活前后注册面差分比对；events 为规约级对账
   * （订阅无公开列举面，不对账）；F8"违规对账升级审计事件"是第二期项。
   */
  private reconcileProvides(
    record: LoadedPlugin,
    toolsBefore: Set<string>,
    providersBefore: Set<string>,
  ): void {
    const provides = record.manifest.provides;
    if (!provides) return;
    const issues: string[] = [];
    // M12 铁律 2：跨服务读取经 ctx.get（root-traced 无限制——本服务 fiber 链
    // 只 inject tools，裸 this.ctx.llm 会断链）
    const tools = this.ctx.get('tools') as { list(): Array<{ name: string }> } | undefined;
    if (provides.tools !== undefined && tools) {
      const after = new Set(tools.list().map((t) => t.name));
      const registered = [...after].filter((n) => !toolsBefore.has(n));
      const missing = provides.tools.filter((n) => !after.has(n));
      const extra = registered.filter((n) => !provides.tools!.includes(n));
      if (missing.length > 0) issues.push(`声明未注册的工具 [${missing.join(', ')}]`);
      if (extra.length > 0) issues.push(`未声明的工具注册 [${extra.join(', ')}]`);
    }
    if (provides.llmProviders !== undefined) {
      const llm = this.ctx.get('llm') as { providers(): string[] } | undefined;
      if (llm) {
        const after = new Set(llm.providers());
        const registered = [...after].filter((n) => !providersBefore.has(n));
        const missing = provides.llmProviders.filter((n) => !after.has(n));
        const extra = registered.filter((n) => !provides.llmProviders!.includes(n));
        if (missing.length > 0) issues.push(`声明未注册的 provider [${missing.join(', ')}]`);
        if (extra.length > 0) issues.push(`未声明的 provider 注册 [${extra.join(', ')}]`);
      }
    }
    if (issues.length > 0) {
      this.ctx.logger.warn(
        `[pluginRegistry] 插件 "${record.name}" provides 对账不符（warn 不阻断）：${issues.join('；')}`,
      );
    }
  }

  /** 重载已装载插件（重读 manifest，沿用授予/watch） */
  async reload(name: string): Promise<PluginLoadOutcome> {    const record = this.loaded.get(name);
    if (!record) return { status: 'rejected', name, error: `插件 "${name}" 未装载` };
    const manifest = loadManifestFromDir(record.dir);
    if (manifest.name !== name) {
      return { status: 'rejected', name, error: `插件 "${name}" 重载时 manifest.name 已变为 "${manifest.name}"（改名请先卸载后重新注册）` };
    }
    return this.load({
      dir: record.dir,
      ...(record.agentId !== undefined ? { agentId: record.agentId } : {}),
      sessionOnly: record.sessionOnly,
      allowedPermissions: record.allowedPermissions,
      watch: record.watch,
    });
  }

  /** 卸载已装载插件（fiber dispose + ui/ watcher 回收）；返回是否确有卸载 */
  async unload(name: string): Promise<boolean> {
    const record = this.loaded.get(name);
    if (!record) return false;
    await this.disposeRecord(record);
    this.ctx.emit('plugin/catalog-changed', { kind: record.sessionOnly ? 'session' : 'installed' });
    return true;
  }

  private async activate(module: PluginModule, manifest: PluginManifest): Promise<Fiber> {
    const fiber = this.ctx.plugin(module as unknown as Plugin, manifest.config ?? {}) as Fiber & PromiseLike<Fiber>;
    await fiber;
    return fiber;
  }

  private mountRecord(record: LoadedPlugin, fiber: Fiber): void {
    record.fiber = fiber;
    this.loaded.set(record.name, record);
    if (record.watch) this.startWatcher(record);
    this.mountUi(record, 'register');
  }

  /** 挂载 manifest.ui（可选能力：未装 webui 行时静默跳过） */
  private mountUi(record: LoadedPlugin, reason: 'register' | 'reload'): void {
    if (!record.manifest.ui) return;
    const webui = this.ctx.get('webui') as WebUiService | undefined;
    if (!webui) return;
    void webui
      .addEntry(
        record.name,
        record.manifest.version,
        record.dir,
        record.manifest.ui,
        record.sessionOnly ? 'session' : 'installed',
        record.allowedPermissions,
      )
      .then((disposer) => {
        record.uiDisposer = disposer;
        this.ctx.emit('webui/extensions-changed', { name: record.name, reason });
      })
      .catch((err: unknown) => {
        // UI 半边失败不回滚后端装载（isolated 降级）；记日志
        this.ctx.logger.warn(`插件 "${record.name}" UI 挂载失败: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  private async disposeRecord(record: LoadedPlugin): Promise<void> {
    // UI 扩展先卸载（前端注册表撤销），再回收 fiber
    try {
      record.uiDisposer?.();
    } catch (err: unknown) {
      this.ctx.logger.warn(`卸载插件 "${record.name}" 的 UI 扩展时异常: ${err instanceof Error ? err.message : String(err)}`);
    }
    record.uiDisposer = undefined;
    if (record.manifest.ui) {
      const webui = this.ctx.get('webui') as WebUiService | undefined;
      webui?.removeEntry(record.name);
      this.ctx.emit('webui/extensions-changed', { name: record.name, reason: 'unregister' });
    }

    this.stopWatcher(record);
    this.loaded.delete(record.name);
    try {
      await record.fiber.dispose();
    } catch (err: unknown) {
      this.ctx.logger.warn(`卸载插件 "${record.name}" 时 dispose 异常: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ============================================================
  // 开发期 watcher：轮询目录哈希，变化后自动重载（失败保留旧实例）
  // ============================================================

  private startWatcher(record: LoadedPlugin): void {
    let baseline = hashDir(record.dir);
    const timer = setInterval(() => {
      void (async () => {
        if (record.reloading) return;
        let current: string;
        try {
          current = hashDir(record.dir);
        } catch {
          return; // 目录瞬时不可读（编辑器写入中），下一次再试
        }
        if (current === baseline) return;
        record.reloading = true;
        baseline = current;
        try {
          const outcome = await this.reload(record.name);
          if (outcome.status === 'rejected') throw new Error(outcome.error);
          this.ctx.logger.info(`插件 "${record.name}" 源码变化，已自动重载`);
        } catch (err: unknown) {
          this.ctx.emit('plugin/reloaded', {
            name: record.name,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
          this.ctx.logger.warn(`插件 "${record.name}" 自动重载失败（保留旧版本）: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          record.reloading = false;
        }
      })();
    }, WATCH_INTERVAL_MS);
    timer.unref?.();
    record.watcher = timer;
  }

  private stopWatcher(record: LoadedPlugin): void {
    if (record.watcher) clearInterval(record.watcher);
    record.watcher = undefined;
  }
}

/** 目录内容哈希（watcher 用；排除产物目录） */
function hashDir(dir: string): string {
  const hash = createHash('sha256');
  const files: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (WATCH_EXCLUDE.has(entry.name)) continue;
        walk(path.join(d, entry.name));
      } else if (entry.isFile()) {
        files.push(path.join(d, entry.name));
      }
    }
  };
  walk(dir);
  files.sort();
  for (const file of files) {
    hash.update(path.relative(dir, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 插件注册中心（ac-plugin-registry 提供）：staging/approve/装载管道 */
    pluginRegistry: PluginRegistryService;
  }

  interface Events {
    /**
     * 插件装载前拦截（权限/契约 gate 的 seam——ac-plugin-gates 行消费）。
     * @mode waterfall
     * @scope host
     * 本 cordis 的 `next()` 不携带参数，三种姿势：
     *   · 拒绝（fail-closed）：不调 `next`，自返回 { status: 'rejected',
     *     name, error }——插件代码不进进程
     *   · 变异授予：`call.grants = [...call.grants, 'ui']` 后 `return next()`
     *   · 纯观察：直接 `return next()`（勿改 call）
     */
    'plugin/before-load'(
      call: PluginLoadCall,
      next: () => Promise<PluginLoadOutcome>,
    ): Promise<PluginLoadOutcome>;

    /**
     * 插件已安装（approve 完成文件域安装 + 装载后发出）。
     * @mode emit
     * @scope host
     * 载荷 = manifest 摘要（name/version/dir/permissions/source）。
     * 谁该订阅：WS 广播（前端刷新插件库）、审计。
     */
    'plugin/installed'(summary: {
      name: string;
      version: string;
      dir: string;
      permissions: PluginPermission[];
      source?: PluginSource;
    }): void;

    /**
     * 插件重载结果通知（watch 自动重载 / 同名替换 / 回滚恢复）。
     * @mode emit
     * @scope host
     * status：loaded 首次 · replaced 替换 · restored 回滚恢复 · failed 失败（error 附因）。
     */
    'plugin/reloaded'(info: {
      name: string;
      status: 'loaded' | 'replaced' | 'restored' | 'failed';
      error?: string;
    }): void;

    /**
     * 插件库目录变化（staging 暂存增删 / installed 安装卸载 / session 会话级装卸）。
     * @mode emit
     * @scope host
     * 前端插件管理页刷新的订阅面。
     */
    'plugin/catalog-changed'(payload: { kind: 'installed' | 'staging' | 'session' }): void;
  }
}
