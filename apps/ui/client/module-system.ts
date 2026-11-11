// ============================================================
// module-system.ts —— 浏览器模块运行时 ClientModuleSystem（cr-929 切片①；
// docs/design/webui/webui-v3.md §4.4）
//
// lazy CJS 模块表，Node 内部 ESM loader 的浏览器对位物：
//   import 'X' / require('X')
//     ① 种子词命中   → 壳活实例（不进表，不物化）——单例契约面
//     ② memo 命中    → 已物化 exports（物化一次恒等，副作用仅一次）
//     ③ wire 行命中  → 按 revision URL 取 bundle → 执行（只注册）→ ④
//     ④ factory 已注册 → 物化 factory(require) → 进 memo → 返回
//     其余            → throw（loud）——构建期纯度门的运行时镜像
// 分工：①管单例、②管惰性、③管到达、④管物化。装载序无需外部编排：
// wire 行序 = 宿主 inject 拓扑序，消费行物化时其依赖行已进 memo。
// 同步 require 无装载支（③）——未注册的 wire 行 require 即 throw（防绕过）。
//
// window.__ModuleLoader__ = 本系统的装载协议面（load({id, factory})——
// 非安全边界，§4.4 定界：安全边界 = isolated 档 + 资产 realpath 囚笼）。
// ============================================================
import type { WireRow } from 'ac-webui-core';

/** factory 注册形（bundle 执行唯一产物——模块体副作用全延迟首物化） */
export interface FactoryRegistration {
  id: string;
  factory: (require: (spec: string) => unknown) => unknown;
}

/** bundle 到达面（浏览器 = <script> 注入；测试 = fetch + eval） */
export type ScriptLoader = (url: string) => Promise<void>;

export interface ClientModuleSystemOptions {
  /** 种子词表（词 → 壳活实例——skeletonModuleHost 同源） */
  seeds: Record<string, unknown>;
  /** wire 行查询（装载支 ③ 的行寻址） */
  rowOf: (id: string) => WireRow | undefined;
  /** 深路径 → 行 id 归一面（<pkg>/client... → <pkg>；缺省 = 仅精确行 id） */
  rowsOf?: (spec: string) => string | undefined;
  /** bundle 到达注入点 */
  loadScript: ScriptLoader;
  /** 装载失败监听（console 面缺省） */
  onError?: (error: unknown) => void;
}

/** ESM 命名空间标注（CJS interop 协议面——crash-hardening 批）：模块表
 *  值（种子/深导出/memo）是 ESM 命名空间（import * 形），但规范命名空间
 *  不带 __esModule 旗标；rollup CJS 产物的默认导入解包依赖它
 *  （_interopDefault: e => e.__esModule ? e : { default: e }）。缺旗标 =
 *  命名空间整体被当作 default → 跨包 .vue 组件静默空渲染（2026-11-07
 *  会话面板空白事故根因的协议半边——另半边是构建器 interop:'auto'）。
 *  冻结命名空间（rollup 生产构建 Object.freeze 产物——vitest 态不冻结，
 *  真机才踩）：不可加旗标 → 可写浅拷贝替身（可枚举导出面全量复制 +
 *  旗标）；替身经 WeakMap 记忆——require 恒等性（module 单例契约）保持）。 */
const esmMarked = new WeakMap<object, unknown>();
export function markEsmNamespace(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if ((value as { __esModule?: boolean }).__esModule === true) return value;
  const cached = esmMarked.get(value);
  if (cached !== undefined) return cached;
  let marked: object;
  try {
    Object.defineProperty(value, '__esModule', { value: true, enumerable: false, configurable: true });
    marked = value;
  } catch {
    marked = { ...(value as Record<string, unknown>), __esModule: true };
  }
  esmMarked.set(value, marked);
  return marked;
}

/** 浏览器缺省：<script> 注入（classic script——factory 注册 bundle 非 ESM） */
function defaultScriptLoader(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('bundle 拉取失败：' + url));
    document.head.appendChild(script);
  });
}

export class ClientModuleSystem {
  private readonly factories = new Map<string, FactoryRegistration['factory']>();
  private readonly memo = new Map<string, unknown>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly materializing = new Set<string>();

  constructor(private options: ClientModuleSystemOptions) {
    const self = this;
    // 装载协议面：bundle 执行只经 load 注册工厂（副作用延迟首物化）
    (globalThis as Record<string, unknown>).__ModuleLoader__ = {
      load(registration: FactoryRegistration) {
        if (typeof registration.id !== 'string' || typeof registration.factory !== 'function') {
          throw new Error('__ModuleLoader__.load 注册形非法（须 { id, factory }）');
        }
        self.factories.set(registration.id, registration.factory);
      },
    };
  }

/** 同步 require：①②④（③ 装载支缺席——未注册 wire 行 = loud） */
  require(spec: string): unknown {
    const seed = (this.options.seeds as Record<string, unknown | undefined>)[spec];
    if (seed !== undefined || spec in this.options.seeds) return markEsmNamespace(seed);
    if (this.memo.has(spec)) return markEsmNamespace(this.memo.get(spec));
    const row = this.normalize(spec);
    if (row !== undefined && row !== spec) {
      // 深路径说明符 → 行级物化（<id>/client 子路径族；cr-930 跨行共享裁决）
      const rowExports = this.require(row) as { __deep?: Record<string, unknown> } | undefined;
      const deep = (rowExports as { __deep?: Record<string, unknown> } | undefined)?.__deep;
      const mod = deep?.[spec];
      if (mod === undefined) throw new Error('行深路径缺席（__deep 面未导出——构建器深清单漂移）：' + spec);
      this.memo.set(spec, mod);
      return markEsmNamespace(mod);
    }
    const factory = this.factories.get(spec);
    if (factory === undefined) {
      throw new Error('模块不可解析（种子词/factory 双缺席——装载序或纯度门违例）：' + spec);
    }
    if (this.materializing.has(spec)) {
      throw new Error('模块环（A require B require A）——CJS 部分导出不可靠，须拆懒用：' + spec);
    }
    this.materializing.add(spec);
    try {
      const exports = factory((dep) => this.require(dep));
      this.memo.set(spec, exports);
      return markEsmNamespace(exports);
    } finally {
      this.materializing.delete(spec);
    }
  }

  /** 深路径 → 行 id 归一（<id>/client[/...] → <id>；非行说明符原样） */
  private normalize(spec: string): string | undefined {
    const hit = this.options.rowsOf?.(spec);
    if (hit !== undefined) return hit;
    return undefined;
  }

  /** 异步 import：③ 装载支在场（wire 行 → bundle 到达 → 注册 → 物化） */
  async import(spec: string): Promise<unknown> {
    const row = this.options.rowOf(this.normalize(spec) ?? spec);
    if (row !== undefined && row.entry !== undefined) await this.ensure(row.id);
    return this.require(spec);
  }

  /** bundle 到达支（仅注册 factory 不物化——boot 两段装载：全到达→按序物化） */
  async ensure(spec: string): Promise<void> {
    const seed = (this.options.seeds as Record<string, unknown | undefined>)[spec];
    if (seed !== undefined || spec in this.options.seeds) return;
    if (this.factories.has(spec)) return;
    const row = this.options.rowOf(spec);
    if (row?.entry === undefined) return;
    let pending = this.loading.get(spec);
    if (pending === undefined) {
      pending = this.options.loadScript(row.entry).catch((error: unknown) => {
        this.loading.delete(spec);
        throw error;
      });
      this.loading.set(spec, pending);
    }
    await pending;
  }

  /** 全弃（wire rev 变化行——factory/memo/loading 三清，重装载重物化） */
  forget(id: string): void {
    this.factories.delete(id);
    this.memo.delete(id);
    this.loading.delete(id);
  }

  /** 物化失效（wire/rebuilt 帧——bundle 重建后弃 memo 重物化） */
  invalidate(id?: string): void {
    if (id === undefined) {
      this.memo.clear();
      return;
    }
    this.memo.delete(id);
  }
}

/** 构造便捷（缺省 <script> 注入） */
export function createClientModuleSystem(options: Omit<ClientModuleSystemOptions, 'loadScript'> & { loadScript?: ScriptLoader }): ClientModuleSystem {
  return new ClientModuleSystem({
    ...options,
    loadScript: options.loadScript ?? (typeof document === 'undefined'
      ? async (url) => { throw new Error('无 document 环境（测试须注入 loadScript）：' + url); }
      : defaultScriptLoader),
  });
}
