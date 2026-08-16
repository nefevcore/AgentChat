// ============================================================
// @agentchat/plugins/src/host.ts —— PluginHost（动态插件装载器，cordis Service）
//
// 职责：
//   · 作为 ctx.pluginHost 服务挂载（boot / 插件库扫描 / dev 工具共用同一实例）
//   · 动态 import 插件模块（cache-busting，dev 模式热更新）
//   · 权限边界：manifest.permissions 未授予 → import 前抛错（代码不进进程）
//   · ctx.plugin(module) 激活为 cordis Fiber，跟踪归属
//   · 同名重载：先回收旧 fiber 与该 owner 的 tools/hooks 注册，再挂新 fiber；
//     新模块 import/激活失败时回滚恢复旧实例
//   · watch：开发期轮询插件目录哈希，变化自动重载（失败保留旧实例）
//   · 事件：plugin.catalog.changed / plugin.reload / agent.assembly.changed
//     经 attachEventSink 接入 WebUI WS 广播（协议见 @agentchat/protocol）
//
// 安全边界（调用方必须遵守）：
//   · 动态 import = 插件代码进宿主进程执行；仅 admin 工具/启动装配可调用；
//   · sessionOnly 加载不落盘、重启即失；installed 加载由插件库 registry 驱动。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { Service, type Context, type Fiber } from '@agentchat/cordis';
import { PLUGIN_EVENT } from '@agentchat/protocol';
import type {
  AgentAssemblyChangedEvent,
  PluginCatalogChangedEvent,
  PluginReloadEvent,
  UIExtensionsChangedEvent,
} from '@agentchat/protocol';
import type { PluginManifest, PluginPermission } from '@agentchat/agent-config';
import { validatePluginManifest } from '@agentchat/agent-config';
import type { ToolsService } from '@agentchat/tools';
import type { HooksService } from '@agentchat/hooks';
import { DEFAULT_GRANTED_PERMISSIONS, assertPermissionsGranted } from './permissions';
import { getOrCreateWebUIService } from './webui-service';

/** cordis 插件模块最小形状（{ name?, inject?, apply }） */
export interface PluginModule {
  name?: string;
  inject?: string[];
  apply(ctx: Context, config?: Record<string, unknown>): unknown;
}

/** 已装载插件记录 */
export interface LoadedPlugin {
  /** manifest.name = preset id */
  name: string;
  manifest: PluginManifest;
  /** 插件目录 */
  dir: string;
  /** 入口文件绝对路径 */
  entry: string;
  /** cordis Fiber（dispose = 卸载） */
  fiber: Fiber;
  /** 已导入模块命名空间（HMR 回滚用） */
  module: PluginModule;
  /** 本次装载授予的权限（重载沿用） */
  allowedPermissions: PluginPermission[];
  /** 会话级加载归属 Agent（sessionOnly） */
  agentId?: string;
  /** false = 插件库安装记录（重启扫描可恢复）；true = 会话级（重启即失） */
  sessionOnly: boolean;
  /** 是否开启开发期文件监听 */
  watch: boolean;
  /** 文件监听轮询器 */
  watcher?: NodeJS.Timeout;
  /** 正在执行 watch 重载（防重入） */
  reloading?: boolean;
  /** UI 扩展卸载函数（manifest.ui 挂载成功后写入） */
  uiDisposer?: () => void;
  /** UI 扩展注册名（与 manifest.name 一致；审计用） */
  uiName?: string;
  loadedAt: number;
}

export interface PluginLoadSpec {
  manifest: PluginManifest;
  /** 插件目录（manifest.json 所在目录） */
  dir: string;
  /** 会话级加载归属 Agent */
  agentId?: string;
  sessionOnly: boolean;
  /** 授予的权限（缺省 = fs/network） */
  allowedPermissions?: PluginPermission[];
  /** 开发期监听目录变化并自动重载（缺省 false） */
  watch?: boolean;
}

export interface PluginLoadResult {
  name: string;
  status: 'loaded' | 'replaced' | 'restored';
  entry: string;
  fiberUid: number | null;
}

const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.staging', '.backup']);

/** 插件目录内容哈希（轮询 watcher 用；相对路径排序，确定性） */
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
        if (EXCLUDE_DIRS.has(entry.name)) continue;
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

export interface PluginHostOptions {
  /** 自定义模块导入器（默认 Node ESM import；测试/未来 loader 集成可注入） */
  importModule?: (url: string) => Promise<unknown>;
}

/** 事件汇聚点（bootstrap 注入 PluginEventBus，再转发给 WSHandler） */
export type PluginEventSink = (type: string, data: unknown) => void;

/** ctx → host 实例缓存：ctx.get 会返回 traceable 代理，这里保证同一身份复用 */
const hostCache = new WeakMap<object, PluginHost>();

/**
 * 动态插件装载器。继承 cordis Service，构造时即注册为 ctx.pluginHost。
 * 全进程应只有一个实例：插件库启动扫描 / register_plugin / HTTP 层共用。
 */
export class PluginHost extends Service {
  private loaded = new Map<string, LoadedPlugin>();
  private eventSink?: PluginEventSink;

  constructor(
    ctx: Context,
    private options: PluginHostOptions = {},
  ) {
    super(ctx, 'pluginHost');
  }

  /** 接入事件汇聚（可晚于构造调用；Loader 场景 dev 行可能先创建 host） */
  attachEventSink(sink: PluginEventSink): void {
    this.eventSink = sink;
  }

  has(name: string): boolean {
    return this.loaded.has(name);
  }

  get(name: string): LoadedPlugin | undefined {
    return this.loaded.get(name);
  }

  list(): LoadedPlugin[] {
    return [...this.loaded.values()];
  }

  /** 通知插件库目录变化（kind = installed / staging / session） */
  notifyCatalogChanged(kind: PluginCatalogChangedEvent['kind']): void {
    this.emitEvent(PLUGIN_EVENT.CATALOG_CHANGED, { kind });
  }

  /** 通知插件重载结果（watch / session reload / installed 替换） */
  notifyReload(data: PluginReloadEvent): void {
    this.emitEvent(PLUGIN_EVENT.RELOAD, data);
  }

  /** 通知 Agent 装配视图已变更（PUT assembly 后广播多端同步） */
  notifyAssemblyChanged(agentId: string): void {
    this.emitEvent(PLUGIN_EVENT.ASSEMBLY_CHANGED, { agentId } satisfies AgentAssemblyChangedEvent);
  }

  private emitEvent(type: string, data: unknown): void {
    try {
      this.eventSink?.(type, data);
    } catch {
      // 事件汇聚失败不影响插件生命周期
    }
  }

  /** 加载（或同名重载）插件；同名替换失败时回滚旧实例 */
  async load(spec: PluginLoadSpec): Promise<PluginLoadResult> {
    const check = validatePluginManifest(spec.manifest);
    if (!check.ok) throw new Error(`manifest 非法: ${check.errors.join('；')}`);
    const manifest = check.manifest!;

    // 权限边界：import 之前拒绝未授予权限（插件代码不进进程）
    const allowedPermissions: PluginPermission[] = spec.allowedPermissions ?? [...DEFAULT_GRANTED_PERMISSIONS];
    assertPermissionsGranted(manifest, allowedPermissions);

    const dir = path.resolve(spec.dir);
    const entry = path.resolve(dir, manifest.entry ?? 'index.ts');
    if (!fs.existsSync(entry)) {
      throw new Error(`插件入口不存在: ${entry}`);
    }

    // inject 依赖缺失时 ctx.plugin 会停在 PENDING（await 永不返回）——
    // 装载前显式检查，给出可诊断错误而不是挂死调用方。
    for (const dep of manifest.inject ?? []) {
      const has = this.ctx.get?.(dep);
      if (has === undefined) {
        throw new Error(`插件 "${manifest.name}" 依赖的 ctx 服务 "${dep}" 未提供（inject 声明不可满足）`);
      }
    }

    // 会话级加载不得覆盖已安装插件（installed 的替换走发布工具/重启装配）
    const existing = this.loaded.get(manifest.name);
    if (existing && spec.sessionOnly && !existing.sessionOnly) {
      throw new Error(`插件 "${manifest.name}" 已作为全局插件安装，会话级加载被拒绝（请改用发布流程）`);
    }

    // cache-busting：dev 模式修改入口后重载可得新模块
    const url = pathToFileURL(entry).href + `?t=${Date.now()}`;
    let mod: unknown;
    try {
      const importModule = this.options.importModule ?? ((u: string) => import(u));
      mod = await importModule(url);
    } catch (err: any) {
      throw new Error(`动态 import 失败（${entry}）: ${err?.message ?? String(err)}。TS 插件需在 tsx/vitest 运行态加载，发布到插件库前请保证入口可被 Node ESM 解析。`);
    }
    const plugin = mod as PluginModule;
    if (!plugin || typeof plugin.apply !== 'function') {
      throw new Error(`插件模块缺少 apply(ctx, config)（${entry}）`);
    }
    if (typeof plugin.name === 'string' && plugin.name !== manifest.name) {
      throw new Error(`插件模块 name "${plugin.name}" 与 manifest.name "${manifest.name}" 不一致`);
    }

    // 旧实例暂存（用于新模块激活失败时回滚），然后回收旧 fiber
    const old = existing;
    if (old) await this.disposeRecord(old);

    let fiber: Fiber & PromiseLike<Fiber>;
    try {
      fiber = this.ctx.plugin(plugin as unknown as { apply(ctx: Context, config?: Record<string, unknown>): unknown }, manifest.config ?? {}) as Fiber & PromiseLike<Fiber>;
      await fiber;
    } catch (err) {
      // apply 抛错可能留下半注册：回收 owner；若存在旧实例则重新激活旧模块
      this.cleanupOwner(manifest.name);
      if (old) {
        try {
          const restored = await this.activate(old.module, old.manifest);
          this.mountRecord(old, restored);
          this.ctx.logger?.('plugins').warn(`插件 "${old.name}" 新版本激活失败，已回滚旧版本`);
          this.notifyReload({ name: old.name, status: 'failed', error: err instanceof Error ? err.message : String(err) });
          throw new Error(`插件 "${manifest.name}" 激活失败，已回滚旧版本：${err instanceof Error ? err.message : String(err)}`);
        } catch (restoreErr: any) {
          this.notifyReload({ name: old.name, status: 'failed', error: `新版本激活失败且旧版本回滚失败：${restoreErr?.message ?? String(restoreErr)}` });
          throw new Error(`插件 "${manifest.name}" 激活失败且旧版本回滚失败：${err instanceof Error ? err.message : String(err)}；restore: ${restoreErr?.message ?? String(restoreErr)}`);
        }
      }
      throw err;
    }

    const record: LoadedPlugin = {
      name: manifest.name,
      manifest,
      dir,
      entry,
      fiber,
      module: plugin,
      allowedPermissions,
      agentId: spec.agentId,
      sessionOnly: spec.sessionOnly,
      watch: spec.watch === true,
      loadedAt: Date.now(),
    };
    try {
      this.mountRecord(record, fiber, old ? 'reload' : 'register');
    } catch (err) {
      await this.disposeRecord(record);
      throw new Error(`插件 "${manifest.name}" UI 挂载失败：${err instanceof Error ? err.message : String(err)}`);
    }

    if (old) {
      this.notifyReload({ name: manifest.name, status: 'replaced' });
    } else {
      this.notifyCatalogChanged(record.sessionOnly ? 'session' : 'installed');
    }

    return {
      name: manifest.name,
      status: old ? 'replaced' : 'loaded',
      entry,
      fiberUid: fiber.uid,
    };
  }

  /**
   * 重载已装载插件（重读 manifest，沿用原授予权限/watch 设置）。
   * 仅会话级 reload/unload 端点与内部 watcher 使用。
   */
  async reload(name: string): Promise<PluginLoadResult> {
    const record = this.loaded.get(name);
    if (!record) throw new Error(`插件 "${name}" 未在 PluginHost 中装载`);
    const manifest = JSON.parse(fs.readFileSync(path.join(record.dir, 'manifest.json'), 'utf-8')) as PluginManifest;
    if (manifest.name !== name) {
      throw new Error(`插件 "${name}" 重载时 manifest.name 已变为 "${manifest.name}"（改名请先卸载后重新注册）`);
    }
    return this.load({
      manifest,
      dir: record.dir,
      agentId: record.agentId,
      sessionOnly: record.sessionOnly,
      allowedPermissions: record.allowedPermissions,
      watch: record.watch,
    });
  }

  /** 卸载插件：回收 owner 注册 + dispose fiber + 停 watcher；返回是否确有卸载 */
  async unload(name: string): Promise<boolean> {
    const record = this.loaded.get(name);
    if (!record) return false;
    await this.disposeRecord(record);
    this.notifyCatalogChanged(record.sessionOnly ? 'session' : 'installed');
    return true;
  }

  private async activate(module: PluginModule, manifest: PluginManifest): Promise<Fiber> {
    const fiber = this.ctx.plugin(module as unknown as { apply(ctx: Context, config?: Record<string, unknown>): unknown }, manifest.config ?? {}) as Fiber & PromiseLike<Fiber>;
    await fiber;
    return fiber;
  }

  private mountRecord(record: LoadedPlugin, fiber: Fiber, uiReason: 'register' | 'reload' = 'register'): void {
    record.fiber = fiber;
    this.loaded.set(record.name, record);
    if (record.watch) this.startWatcher(record);
    this.mountUi(record, uiReason);
  }

  /** 挂载 manifest.ui 声明的 UI 扩展（新装 / 重载 / 回滚恢复共用） */
  private mountUi(record: LoadedPlugin, reason: 'register' | 'reload'): void {
    if (!record.manifest.ui) return;
    const webui = getOrCreateWebUIService(this.ctx);
    record.uiDisposer = webui.addEntry(
      record.name,
      record.manifest.version,
      record.dir,
      record.manifest.ui,
      record.sessionOnly ? 'session' : 'installed',
      record.allowedPermissions,
    );
    record.uiName = record.name;
    this.emitEvent(PLUGIN_EVENT.UI_EXTENSIONS_CHANGED, { name: record.name, reason } satisfies UIExtensionsChangedEvent);
  }

  private async disposeRecord(record: LoadedPlugin): Promise<void> {
    // UI 扩展先卸载（前端注册表撤销），再回收后端注册与 fiber
    const hadUi = typeof record.uiDisposer === 'function';
    try {
      record.uiDisposer?.();
    } catch (err: any) {
      this.ctx.logger?.('plugins').warn(`卸载插件 "${record.name}" 的 UI 扩展时异常: ${err?.message ?? String(err)}`);
    }
    record.uiDisposer = undefined;
    if (hadUi) {
      this.emitEvent(PLUGIN_EVENT.UI_EXTENSIONS_CHANGED, { name: record.name, reason: 'unregister' } satisfies UIExtensionsChangedEvent);
    }

    this.stopWatcher(record);
    this.cleanupOwner(record.name);
    this.loaded.delete(record.name);
    try {
      await record.fiber.dispose();
    } catch (err: any) {
      // 回收注册已先行完成；dispose 异常仅记录，不阻断后续装载
      this.ctx.logger?.('plugins').warn(`卸载插件 "${record.name}" 时 dispose 异常: ${err?.message ?? String(err)}`);
    }
  }

  /** 回收该 owner 在 ToolsService/HooksService 的全部注册（注册归属制的卸载半边） */
  private cleanupOwner(owner: string): void {
    const tools = this.ctx.get?.('tools') as ToolsService | undefined;
    if (tools) tools.unregister(owner);
    const hooks = this.ctx.get?.('hooks') as HooksService | undefined;
    if (hooks) hooks.unregister(owner);
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
          // 重新读 manifest（可能改了 name/version/permissions），沿用原授予权限
          const manifest = JSON.parse(fs.readFileSync(path.join(record.dir, 'manifest.json'), 'utf-8')) as PluginManifest;
          if (manifest.name !== record.name) {
            throw new Error(`manifest.name 已变为 "${manifest.name}"（自动重载不处理改名，请卸载后重新注册）`);
          }
          await this.load({
            manifest,
            dir: record.dir,
            agentId: record.agentId,
            sessionOnly: record.sessionOnly,
            allowedPermissions: record.allowedPermissions,
            watch: true,
          });
          this.ctx.logger?.('plugins').info(`插件 "${record.name}" 源码变化，已自动重载`);
        } catch (err: any) {
          this.notifyReload({ name: record.name, status: 'failed', error: err?.message ?? String(err) });
          this.ctx.logger?.('plugins').warn(`插件 "${record.name}" 自动重载失败（保留旧版本）: ${err?.message ?? String(err)}`);
        } finally {
          record.reloading = false;
        }
      })();
    }, 750);
    timer.unref?.();
    record.watcher = timer;
  }

  private stopWatcher(record: LoadedPlugin): void {
    if (record.watcher) clearInterval(record.watcher);
    record.watcher = undefined;
  }
}

/** 取 ctx 上已注册的 PluginHost；没有则新建并注册（全进程单实例约定由调用方保证） */
export function getOrCreatePluginHost(ctx: Context, options: PluginHostOptions = {}): PluginHost {
  const cached = hostCache.get(ctx as object);
  if (cached) return cached;
  const existing = ctx.get?.('pluginHost') as PluginHost | undefined;
  if (existing) {
    hostCache.set(ctx as object, existing);
    return existing;
  }
  const created = new PluginHost(ctx, options);
  hostCache.set(ctx as object, created);
  return created;
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 动态插件装载器（@agentchat/plugins 提供；boot/扫描/dev 工具共用） */
    pluginHost?: PluginHost;
  }
}
