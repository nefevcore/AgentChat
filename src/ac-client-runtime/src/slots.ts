// ============================================================
// ac-client-runtime/src/slots.ts —— SlotRegistry（cordis Service，M27 S0/S1.5）
//
// 纯核（SlotCore，ac-client-slots）之上的运行时面：
//   · register/declare 经 this.ctx.fiber.effect 路由进【调用方】fiber
//     ——插件卸载即级联回收其全部 slot 贡献（D5，与服务端注册中心
//     「注册即归属」同构；this.ctx 经 cordis tracker 指向调用方 ctx，
//     register 必须保持原型方法——DSH slots.d.ts 注释的坑原样规避）；
//   · 'slots/changed' 事件桥（载荷 = slot key；渲染面细粒度失效轴）；
//   · install(renderer) boot-once（D4 唯一渲染器安装口）+ render()
//     ctx 级渲染入口（§0.1 ⑥ app.mount(renderSlot('root')) 的委托面）；
//   · 声明账本 snapshot 调试面（BUILTIN_SLOTS 静态表的退役方向，D1）；
//   · S1.5 增强级：inject 面（声明存活期效应，D6）+ store 座位实例轴
//     （acquireStore/dropScope——引用计数/会话死即清）+ entry 崩溃监督
//     （reportEntryError → abdicate 退位 + onEntryError 钩子）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import {
  SlotCore,
  SlotStoreAxis,
  type SlotDecl,
  type SlotEntry,
  type SlotCoreSnapshot,
  type SlotStoreFactory,
  type SlotStoreHandle,
  type StoreSeat,
  type SlotKey,
} from 'ac-client-slots';

/**
 * 席位渲染器（框架中立接口；Vue 实现住 webui/src/runtime/vueRenderer.ts）。
 * 同轴 order 合并与 single 默认插槽回落由框架侧 Outlet 承担（D16）——
 * render 只回答「这个席位有哪些外部贡献要渲染」。
 */
export interface SlotRenderer {
  /** 渲染框架标识（诊断面：'vue'） */
  readonly framework: string;
  /** 渲染一个席位的外部贡献（不含宿主模板内容） */
  render(key: string, data?: unknown): unknown[];
}

/** entry 崩溃监督钩子（abdicate 退位的观察面：日志/遥测/重装策略） */
export type EntryErrorHandler = (key: string, entry: SlotEntry, error: unknown) => void;

export interface SlotsServiceOptions {
  /** entry 崩溃监督（abdicate 后回调；缺省仅 console.error） */
  onEntryError?: EntryErrorHandler;
}

export class SlotsService extends Service {
  private core = new SlotCore();
  /** store 座位实例轴（S1.5：handle × scope key / 引用计数 / 会话死即清） */
  readonly stores = new SlotStoreAxis();
  private renderer: SlotRenderer | undefined;
  /** 贡献条目 → 注册方 ctx（wrapComponent 隔离 ctx 的数据源，D17） */
  private owners = new WeakMap<SlotEntry, Context>();
  private onEntryError: EntryErrorHandler | undefined;
  /** inject 面（S1.5-4）：key → 声明存活期效应 */
  private injectEffects = new Map<string, { effect: () => (() => void) | void; dispose?: () => void }[]>();

  constructor(ctx: Context, options: SlotsServiceOptions = {}) {
    super(ctx, 'slots');
    this.onEntryError = options.onEntryError;
  }

  /**
   * 声明席位（写入声明账本）。经调用方 fiber effect——声明方（席位
   * owner 插件）卸载即席位消亡，其全部贡献一并消失（级联）。
   *
   * @returns effect disposer（一般无需手动调用——随声明方 fiber 卸载自动执行）
   */
  declare(decl: SlotDecl) {
    return this.ctx.fiber.effect(() => {
      this.core.declare(decl);
      this.bump(decl.key);
      this.runInjectEffects(decl.key, true);
      return () => {
        this.core.undeclare(decl.key);
        this.runInjectEffects(decl.key, false);
        this.bump(decl.key);
      };
    }, `slots.declare(${decl.key})`);
  }

  /**
   * 注册贡献（装载校验失败同步抛 SlotCoreError：未声明 / 出厂封印 /
   * 形状非法）。经调用方 fiber effect——插件卸载即级联回收。
   *
   * @returns effect disposer（一般无需手动调用——随注册方 fiber 卸载自动执行）
   */
  register(key: SlotKey, entry: SlotEntry) {
    return this.ctx.fiber.effect(() => {
      const dispose = this.core.register(key, entry); // 校验先行，失败即抛
      this.owners.set(entry, this.ctx);
      this.bump(key);
      return () => {
        dispose();
        this.bump(key);
      };
    }, `slots.register(${key}:${entry.id})`);
  }

  /** 席位条目（disabled/退位过滤 + 排序；纯核读取面） */
  entries(key: SlotKey): readonly SlotEntry[] {
    return this.core.entries(key);
  }

  /** single 型选举（cell shadow；无贡献 → undefined——回落交渲染面默认插槽，D16-②） */
  single(key: SlotKey): SlotEntry | undefined {
    return this.core.single(key);
  }

  /** 声明账本读取 */
  declOf(key: SlotKey): Readonly<SlotDecl> | undefined {
    return this.core.declOf(key);
  }

  /** 席位版本计数（渲染面响应式失效轴：key 级，D14） */
  version(key: SlotKey): number {
    return this.core.version(key);
  }

  /** 贡献的注册方 ctx（无记录 → undefined）；wrapComponent 的隔离 ctx 来源 */
  ownerOf(entry: SlotEntry): Context | undefined {
    return this.owners.get(entry);
  }

  /**
   * inject 面（S1.5-4，D6）：依赖【席位声明存活期】的效应——
   * 声明在场即执行（立即或下一次 declare 时），声明塌缩即回收。
   * 效应可返回清理函数；监听本身随调用方 fiber 卸载撤销。
   *
   * @returns 撤销监听的 disposer
   */
  inject(key: SlotKey, effect: () => (() => void) | void): () => void {
    const record = { effect, dispose: undefined as (() => void) | undefined };
    const off = this.ctx.fiber.effect(() => {
      const list = this.injectEffects.get(key) ?? [];
      this.injectEffects.set(key, list);
      list.push(record);
      if (this.core.has(key)) this.runInjectEffects(key, true);
      return () => {
        const arr = this.injectEffects.get(key) ?? [];
        const i = arr.indexOf(record);
        if (i >= 0) arr.splice(i, 1);
        record.dispose?.();
        record.dispose = undefined;
      };
    }, `slots.inject(${key})`);
    return () => void off();
  }

  private runInjectEffects(key: string, declared: boolean): void {
    for (const record of this.injectEffects.get(key) ?? []) {
      if (declared) {
        if (record.dispose) continue; // 已在声明存活期（重声明不重启）
        record.dispose = record.effect() ?? undefined;
      } else {
        record.dispose?.();
        record.dispose = undefined;
      }
    }
  }

  // ---- store 座位实例轴（S1.5-3）----

  /**
   * store 座位获取（引用计数 +1；scope:'root' 席位 scopeKey 恒 'root'，
   * 'session' 席位由调用方传会话键）。配套 entry.store 工厂；
   * release() 归零即 dispose + 摘除（持久化态随清）。
   */
  acquireStore(key: SlotKey, entryId: string, scopeKey = 'root'): StoreSeat {
    const fromVisible = this.core.entries(key).find((e) => e.id === entryId) ?? this.core.single(key);
    const entry = fromVisible && fromVisible.id === entryId
      ? fromVisible
      : (this.core.snapshot().slots[key] ?? []).find((e) => e.id === entryId); // 退位条目也可读座位
    const factory: SlotStoreFactory = entry?.store ?? (() => undefined);
    const handle: SlotStoreHandle = { slotKey: key, entryId, scopeKey };
    return this.stores.acquire(handle, factory);
  }

  /** 会话死即清：清空该 scopeKey 的全部 store 座位实例（会话服务调用） */
  dropScope(scopeKey: string | ((scopeKey: string) => boolean)): number {
    return this.stores.dropScope(scopeKey);
  }

  // ---- entry 崩溃监督 + 退位（S1.5-5）----

  /**
   * 动态 chunk 加载失败判定（资源性瞬时错误——非 entry 代码缺陷）：
   * webui:build 重建后 chunk hash 全变，旧页面挂着的 defineAsyncComponent
   * loader 请求旧 URL → 404 → TypeError: Failed to fetch dynamically
   * imported module。此类错误与 entry 组件实现无关（刷新即恢复），且
   * 出厂条目（layout 注册）永不重注册——退位 = 永久消失（「让位后主栏
   * 再也看不到」事故根因）。判据：错误消息含 'dynamically imported
   * module'（Vite/浏览器标准措辞；Chrome/Firefox/Safari 一致）。
   */
  private isChunkLoadError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes('dynamically imported module')
      || msg.includes('Importing a module script failed');
  }

  /**
   * entry 崩溃上报（渲染边界捕获后调用）：abdicate 退位（让出选举位，
   * 同 id 重注册复位）+ onEntryError 监督钩子 + 事件桥失效。
   * 资源性 chunk 加载失败不退位（见 isChunkLoadError）——记录后放行，
   * 下次渲染重试（刷新页面加载新 manifest 即恢复）。
   */
  reportEntryError(key: SlotKey, entry: SlotEntry, error: unknown): void {
    if (this.isChunkLoadError(error)) {
      console.warn(`[slots] entry 动态 chunk 加载失败（不退位，刷新页面恢复）：${key}#${entry.id}`, error);
      return;
    }
    const abdicated = this.core.abdicate(key, entry.id);
    if (abdicated) this.bump(key);
    if (this.onEntryError) {
      this.onEntryError(key, entry, error);
    } else {
      console.error(`[slots] entry 崩溃退位：${key}#${entry.id}`, error);
    }
  }

  /**
   * 出厂装配封印（D3）：此后 factory 席位（root 等）的动态注册一律拒绝。
   * 装配序列在「基础插件集合装配完成」后调用（main.ts）。
   */
  sealFactory(): void {
    this.core.sealFactory();
  }

  /** 声明账本 + 各席位条目 + 封印状态（调试面） */
  snapshot(): SlotCoreSnapshot {
    return this.core.snapshot();
  }

  /**
   * 渲染器安装（boot-once，D4）：装配序列第②步，先于一切渲染。
   * 重复安装抛错——一个运行时只有一个渲染器。
   */
  install(renderer: SlotRenderer): void {
    if (this.renderer) {
      throw new Error(
        `slot 渲染器已安装（${this.renderer.framework}）——install 是 boot-once 契约（M27 D4），一个运行时只装一个渲染器`,
      );
    }
    this.renderer = renderer;
  }

  /** 已安装渲染器（未安装 → undefined；诊断面） */
  get installedRenderer(): SlotRenderer | undefined {
    return this.renderer;
  }

  /** ctx 级渲染入口：委托已安装渲染器（未安装 → 可诊断抛错） */
  render(key: SlotKey, data?: unknown): unknown[] {
    if (!this.renderer) {
      throw new Error('slot 渲染器未安装——装配序列第②步 install(renderer) 必须先于渲染（M27 D4）');
    }
    return this.renderer.render(key, data);
  }

  private bump(key: string): void {
    this.ctx.emit('slots/changed', key);
  }
}

declare module './context.ts' {
  interface ClientContext {
    /** slot 注册中心（ac-client-runtime 提供）：declare/register/entries + store 座位 + inject 面 + 渲染器安装 */
    slots: SlotsService;
  }
}
