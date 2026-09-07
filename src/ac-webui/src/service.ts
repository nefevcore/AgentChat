// ============================================================
// ac-webui/src/service.ts —— UI 扩展资源服务（ctx.webui）
//
// src plugins/webui-service.ts 的 preview 形态（地图 §3.3）：
//   · entries 注册表：name → descriptor + 插件目录（同名替换先旧 disposer）
//   · 清单查询：/api/ui/extensions 直接读 listExtensions()
//   · 静态资源：/ui-plugin/<name>/* 从 entry 目录提供（安全路径解析）
//   · 变更通知：webui/extensions-changed(E)——前端宿主据此 sync
//     （拉清单 → diff → unload/reload，src ui.extensions.changed 同款）
// 静态路由经 ctx.webServer.route 注册（注册即归属——本行摘除即下线）。
// ============================================================
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { Service, type Context } from '@agentchat/cordis';

/** manifest.ui 的声明形状（插件作者在 manifest.json 里写的） */
export interface PluginUiManifest {
  /** UI 产物入口（相对插件目录；缺省 'ui/dist/index.js'） */
  entry?: string;
  /** 附加样式表（相对插件目录） */
  styles?: string[];
  /** 声明填充的 slot（宿主白名单校验在前端宿主 + ac-webui-extensions） */
  slots?: string[];
  /** 不信任档：sandbox iframe 隔离运行（src P5.5 原样语义） */
  isolated?: boolean;
}

/** 前端可见的扩展描述子（/api/ui/extensions 清单条目） */
export interface UiExtensionDescriptor {
  name: string;
  version: string;
  /** 入口 URL（/ui-plugin/<name>/<rel>） */
  entry: string;
  styles: string[];
  slots: string[];
  isolated: boolean;
  status: 'installed' | 'session';
  /** 授予的权限快照（前端徽章/降级展示） */
  permissions: string[];
}

interface WebUiEntry {
  descriptor: UiExtensionDescriptor;
  /** 插件目录绝对路径（静态路由解析用） */
  dir: string;
  disposer: () => void;
}

// ------------------------------------------------------------
// Boot graph（M27 S3/D7/D19）：行包 client/ 半边的装载清单
// ------------------------------------------------------------

/** 行声明的 client 半边（宿主行 apply 经 ctx.webui.declareClient 登记） */
export interface RowClientDescriptor {
  /** 行内稳定名（boot graph 键；与 cordis.yml 行 id 对齐） */
  name: string;
  /** client 半边源入口（绝对路径——dev 期 vite /@fs 直服；prod 期前端
   *  侧按静态 loader 映射取构建块） */
  entry: string;
  /** 平台（当前仅 'web'） */
  platform: 'web';
  /** 装载阶段提示（基础件=base 先于域件=domain；缺省 domain） */
  phase?: 'base' | 'domain';
}

const DEFAULT_UI_ENTRY = 'ui/dist/index.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function toUrlPath(rel: string): string {
  return rel.replace(/\\/g, '/');
}

export class WebUiService extends Service {
  private entries = new Map<string, WebUiEntry>();
  /** boot graph（M27 S3）：行 client 半边清单（行 apply 声明、卸载级联回收） */
  private rowClients = new Map<string, { def: RowClientDescriptor; dispose: () => void }>();

  constructor(ctx: Context) {
    super(ctx, 'webui');
  }

  /**
   * 声明行 client 半边（boot graph 登记——M27 D7/D19）。宿主行 apply 调用：
   * 卸载该行 → 声明级联回收 → 前端 boot graph 同步收缩（消费面一并消失）。
   * 返回 disposer（一般无需手动调用）。
   */
  declareClient(def: RowClientDescriptor): () => void {
    const old = this.rowClients.get(def.name);
    if (old) old.dispose();
    const record = {
      def,
      dispose: () => {
        if (this.rowClients.get(def.name)?.def === def) this.rowClients.delete(def.name);
      },
    };
    this.rowClients.set(def.name, record);
    return record.dispose;
  }

  /** boot graph 快照（/api/ui/boot-graph 响应体；base 阶段在前） */
  listBootGraph(): RowClientDescriptor[] {
    return [...this.rowClients.values()]
      .map((r) => r.def)
      .sort((a, b) => (a.phase ?? 'domain').localeCompare(b.phase ?? 'domain') || a.name.localeCompare(b.name));
  }

  /**
   * 挂载插件 UI 产物目录，返回 disposer。
   * 入口/样式文件须已存在（preview 缩水：不做 esbuild 构建——插件须
   * 预构建产物；src buildPluginUi 的发布期打包延后，见地图 M13 说明）。
   * 同名替换先调用旧 disposer（清单原子切换）。
   */
  async addEntry(
    name: string,
    version: string,
    dir: string,
    ui: PluginUiManifest,
    status: 'installed' | 'session',
    permissions: string[] = [],
  ): Promise<() => void> {
    const root = resolve(dir);
    const entryRel = ui.entry ?? DEFAULT_UI_ENTRY;
    const entryAbs = resolve(root, entryRel);
    if (entryAbs !== root && !entryAbs.startsWith(root + '\\') && !entryAbs.startsWith(root + '/')) {
      throw new Error(`UI 插件 "${name}" 入口路径逃逸: ${entryRel}`);
    }
    const entryStat = await stat(entryAbs).catch(() => undefined);
    if (!entryStat?.isFile()) {
      throw new Error(`UI 插件 "${name}" 入口文件不存在: ${entryAbs}（preview 不做发布期构建，请预构建产物）`);
    }
    for (const styleRel of ui.styles ?? []) {
      const styleStat = await stat(resolve(root, styleRel)).catch(() => undefined);
      if (!styleStat?.isFile()) {
        throw new Error(`UI 插件 "${name}" 样式文件不存在: ${resolve(root, styleRel)}`);
      }
    }

    const old = this.entries.get(name);
    if (old) old.disposer();

    const descriptor: UiExtensionDescriptor = {
      name,
      version,
      entry: `/ui-plugin/${name}/${toUrlPath(entryRel)}`,
      styles: (ui.styles ?? []).map((s) => `/ui-plugin/${name}/${toUrlPath(s)}`),
      slots: ui.slots ?? [],
      isolated: ui.isolated ?? false,
      status,
      permissions,
    };
    const entry: WebUiEntry = {
      descriptor,
      dir: root,
      disposer: () => {
        if (this.entries.get(name) === entry) this.entries.delete(name);
      },
    };
    this.entries.set(name, entry);
    return entry.disposer;
  }

  /** 当前全部 UI 扩展清单（/api/ui/extensions 响应体） */
  listExtensions(): UiExtensionDescriptor[] {
    return [...this.entries.values()]
      .map((e) => e.descriptor)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 按 name 取插件目录（/ui-plugin/:name/* 静态路由用） */
  getEntryDir(name: string): string | null {
    return this.entries.get(name)?.dir ?? null;
  }

  /** 按 name 移除（session unload / installed uninstall 用）；返回是否确有移除 */
  removeEntry(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;
    entry.disposer();
    return true;
  }

  /** /ui-plugin/<name>/* 静态服务（本行 apply 时经 webServer.route 挂载） */
  async serveUiAsset(name: string, rest: string, reply: (status: number, body: Buffer | string, type: string) => void): Promise<void> {
    const dir = this.getEntryDir(name);
    if (!dir) {
      reply(404, 'unknown ui extension', 'text/plain; charset=utf-8');
      return;
    }
    const full = normalize(join(dir, rest));
    if (full !== dir && !full.startsWith(dir + '\\') && !full.startsWith(dir + '/')) {
      reply(403, 'forbidden', 'text/plain; charset=utf-8');
      return;
    }
    try {
      const s = await stat(full);
      if (!s.isFile()) throw new Error('not a file');
      reply(200, await readFile(full), CONTENT_TYPES[extname(full)] ?? 'application/octet-stream');
    } catch {
      reply(404, 'not found', 'text/plain; charset=utf-8');
    }
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** UI 扩展资源服务（ac-webui 提供）：entries 清单 + /ui-plugin/ 静态 */
    webui: WebUiService;
  }

  interface Events {
    /**
     * UI 扩展清单变更通知（addEntry/removeEntry 后发出）。
     * 前端宿主订阅（经 ws-bridge 转 WS 帧）→ 拉清单 diff →
     * unload/reload（src ui.extensions.changed 同款 sync 语义）。
     * @mode emit
     * @scope host
     * 载荷：name + reason（register|unregister|reload）。
     */
    'webui/extensions-changed'(payload: { name: string; reason: 'register' | 'unregister' | 'reload' }): void;
  }
}
