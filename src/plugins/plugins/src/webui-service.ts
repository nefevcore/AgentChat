// ============================================================
// @agentchat/plugins/src/webui-service.ts —— ctx.webui Service（P5 深度 UI 扩展）
//
// 职责：
//   · 把插件 UI 产物目录挂到 /ui-plugin/<name>/ 语义下
//   · 维护当前全部 UI 扩展清单（HTTP /api/ui/extensions 直接读）
//   · 同名替换时先调用旧 disposer；removeEntry 供 session unload /
//     installed uninstall 使用
//
// 生命周期接线见 host.ts：PluginHost.load 成功后调用 addEntry，
// disposeRecord 首先调用 uiDisposer，保证后端工具与前端 UI 同生命周期。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { Service, type Context } from '@agentchat/cordis';
import type { UIExtensionDescriptor, UISlotId } from '@agentchat/protocol';
import type { PluginPermission, PluginUIManifest } from '@agentchat/agent-config';

interface WebUIEntry {
  descriptor: UIExtensionDescriptor;
  /** 插件目录绝对路径（/ui-plugin/:name/* 静态路由解析用） */
  dir: string;
  /** 移除本 entry 的 disposer（由 addEntry 返回，也可被 removeEntry 调用） */
  disposer: () => void;
}

const DEFAULT_UI_ENTRY = 'ui/dist/index.js';

/** 相对路径 → URL path（统一 posix 分隔符） */
function toUrlPath(rel: string): string {
  return rel.replace(/\\/g, '/');
}

/**
 * UI 扩展资源服务。继承 cordis Service，构造时注册为 ctx.webui。
 * 全进程应只有一个实例：PluginHost 在首个 manifest.ui 插件装载时创建；
 * HTTP 层与静态路由按请求读取 ctx.webui。
 */
export class WebUIService extends Service {
  private entries = new Map<string, WebUIEntry>();

  constructor(ctx: Context) {
    super(ctx, 'webui');
  }

  /**
   * 挂载插件 UI 产物目录，返回 disposer。
   * 同名替换时先调用旧 disposer（旧 entry 从清单移除），再登记新 entry。
   */
  addEntry(
    name: string,
    version: string,
    dir: string,
    ui: PluginUIManifest,
    status: 'installed' | 'session',
    grantedPermissions: PluginPermission[],
  ): () => void {
    const entryRel = ui.entry ?? DEFAULT_UI_ENTRY;
    const entryAbs = path.resolve(dir, entryRel);
    if (!fs.existsSync(entryAbs) || !fs.statSync(entryAbs).isFile()) {
      throw new Error(`UI 插件 "${name}" 入口文件不存在: ${entryAbs}`);
    }
    for (const styleRel of ui.styles ?? []) {
      const styleAbs = path.resolve(dir, styleRel);
      if (!fs.existsSync(styleAbs) || !fs.statSync(styleAbs).isFile()) {
        throw new Error(`UI 插件 "${name}" 样式文件不存在: ${styleAbs}`);
      }
    }

    const old = this.entries.get(name);
    if (old) old.disposer();

    const descriptor: UIExtensionDescriptor = {
      name,
      version,
      entry: `/ui-plugin/${name}/${toUrlPath(entryRel)}`,
      styles: (ui.styles ?? []).map((s) => `/ui-plugin/${name}/${toUrlPath(s)}`),
      slots: (ui.slots ?? []) as UISlotId[],
      isolated: ui.isolated ?? false,
      status,
      grantedPermissions,
    };

    const entry: WebUIEntry = {
      descriptor,
      dir: path.resolve(dir),
      disposer: () => {},
    };
    entry.disposer = () => {
      if (this.entries.get(name) === entry) this.entries.delete(name);
    };
    this.entries.set(name, entry);
    return entry.disposer;
  }

  /** 当前全部 UI 扩展清单（HTTP 层直接读） */
  listExtensions(): UIExtensionDescriptor[] {
    return [...this.entries.values()]
      .map((entry) => entry.descriptor)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 按 name 取插件目录（/ui-plugin/:name/* 静态路由用） */
  getEntryDir(name: string): string | null {
    return this.entries.get(name)?.dir ?? null;
  }

  /** 按 name 移除（session unload / installed uninstall）；返回是否确有移除 */
  removeEntry(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;
    entry.disposer();
    return true;
  }
}

/** 取 ctx 上已注册的 WebUIService；没有则新建并注册（PluginHost 装载 UI 插件时调用） */
export function getOrCreateWebUIService(ctx: Context): WebUIService {
  const existing = ctx.get('webui') as WebUIService | undefined;
  if (existing) return existing;
  return new WebUIService(ctx);
}

declare module '@agentchat/cordis' {
  interface Context {
    /** UI 扩展资源服务（@agentchat/plugins 提供；首个 manifest.ui 插件装载时创建） */
    webui?: WebUIService;
  }
}
