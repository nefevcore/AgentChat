// ============================================================
// ac-client-runtime/src/slots.ts —— SlotRegistry（cordis Service，M27 S0）
//
// 纯核（SlotCore，ac-client-slots）之上的最小运行时面：
//   · register/declare 经 this.ctx.fiber.effect 路由进【调用方】fiber
//     ——插件卸载即级联回收其全部 slot 贡献（D5，与服务端注册中心
//     「注册即归属」同构；this.ctx 经 cordis tracker 指向调用方 ctx，
//     register 必须保持原型方法——DSH slots.d.ts 注释的坑原样规避）；
//   · 'slots/changed' 事件桥（载荷 = slot key；渲染面细粒度失效轴）；
//   · install(renderer) boot-once（D4 唯一渲染器安装口）+ render()
//     ctx 级渲染入口（§0.1 ⑥ app.mount(renderSlot('root')) 的委托面）；
//   · 声明账本 snapshot 调试面（BUILTIN_SLOTS 静态表的退役方向，D1）。
//
// S0 不含：store 实例轴与 onEntryError 监督（S1.5 门，复核 §3.2）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import {
  SlotCore,
  type SlotDecl,
  type SlotEntry,
  type SlotCoreSnapshot,
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

export class SlotsService extends Service {
  private core = new SlotCore();
  private renderer: SlotRenderer | undefined;
  /** 贡献条目 → 注册方 ctx（wrapComponent 隔离 ctx 的数据源，D17） */
  private owners = new WeakMap<SlotEntry, Context>();

  constructor(ctx: Context) {
    super(ctx, 'slots');
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
      return () => {
        this.core.undeclare(decl.key);
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
  register(key: string, entry: SlotEntry) {
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

  /** 席位条目（disabled 过滤 + order 排序；纯核读取面） */
  entries(key: string): readonly SlotEntry[] {
    return this.core.entries(key);
  }

  /** single 型解析（首条贡献或 undefined；回落交渲染面默认插槽，D16-②） */
  single(key: string): SlotEntry | undefined {
    return this.core.single(key);
  }

  /** 声明账本读取 */
  declOf(key: string): Readonly<SlotDecl> | undefined {
    return this.core.declOf(key);
  }

  /** 席位版本计数（渲染面响应式失效轴：key 级，D14） */
  version(key: string): number {
    return this.core.version(key);
  }

  /** 贡献的注册方 ctx（无记录 → undefined）；wrapComponent 的隔离 ctx 来源 */
  ownerOf(entry: SlotEntry): Context | undefined {
    return this.owners.get(entry);
  }

  /**
   * 出厂装配封印（D3）：此后 factory 席位（root 等）的动态注册一律拒绝。
   * 装配序列在「基础插件集合装配完成」后调用（main.ts）。
   */
  sealFactory(): void {
    this.core.sealFactory();
  }

  /** 声明账本 + 各席位贡献 + 封印状态（调试面） */
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
  render(key: string, data?: unknown): unknown[] {
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
    /** slot 注册中心（ac-client-runtime 提供）：declare/register/entries + 渲染器安装 */
    slots: SlotsService;
  }
}
