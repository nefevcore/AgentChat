// ============================================================
// ac-client-runtime/src/context.ts —— 客户端 Context 类型身份（M27 D22）
//
// 裁决（m27 计划 D22，二次评审 §4.1）：客户端 Context 的类型身份是
// 本包导出的 ClientContext（extends vendor Context）；客户端服务与
// 事件的声明合并目标 = 'ac-client-runtime'（本文件的 ClientContext
// 接口 / events.ts 的 ClientEvents），**不 augment '@agentchat/cordis'**——
// 服务端 ac-jobs 等已对 '@agentchat/cordis' 的 Context 声明 jobs 等
// 扁平命名空间，客户端同名同目标 augment 会 TS2717 撞型（S3 行包双
// 半边同包后必然显形）。
//
// 客户端服务命名纪律：新增客户端服务名前查重服务端占名
// （tests/client-context-identity.test.ts 静态锁定交集为空）。
// ============================================================
import { Context, type Plugin } from '@agentchat/cordis';
import { SlotsService } from './slots.ts';
import { ObjectsService } from './objects.ts';

/**
 * 客户端 Context 类型身份（D22）。
 *
 * 浏览器侧一切客户端服务声明合并到本接口：
 *   declare module 'ac-client-runtime' {
 *     interface ClientContext { myService: MyService; }
 *   }
 */
export interface ClientContext extends Context {}

/** 客户端 cordis 根（运行时类；服务经 ctx.plugin 装载，同服务端形态） */
export class ClientContext extends Context {}

/**
 * 客户端插件对象形态：apply 的 ctx 参数收 ClientContext（服务面类型
 * 可见）。cordis Plugin.apply 的形参按 Context 类型严格检查，本形态
 * 经 clientPlugin() 适配——运行时同一对象，只补类型。
 */
export interface ClientPluginObject<P = any> {
  /** 显示名（fiber 诊断/日志） */
  name?: string;
  /** 依赖服务（D6：一律 inject 声明；'slots' 等） */
  inject?: string[];
  /** 提供的服务名 */
  provide?: string | string[];
  apply(ctx: ClientContext, config: P): void;
}

/** 客户端插件类型垫片：ClientPluginObject → cordis Plugin（零运行时变换） */
export function clientPlugin<P = any>(def: ClientPluginObject<P>): Plugin<P> {
  return def as unknown as Plugin<P>;
}

/**
 * 建立客户端运行时：ClientContext + 内置服务（slots / objects——
 * 运行时基建，非行附属；Koishi 同款：client Context 构造即装内置服务）。
 *
 * 装配序列（m27 §0.1）：① await createClient() → ② install(renderer) →
 * ③ 装配基础插件集合 → ④ 按 boot graph 装配域插件 → ⑤ 第三方 UI 插件 →
 * ⑥ app.mount(renderSlot('root'))。
 *
 * async：插件装载是 fiber 生命周期（await 后内置服务才可解析——
 * 消费方 fiber 一律 inject 声明依赖，D6）。
 */
export async function createClient(): Promise<ClientContext> {
  const ctx = new ClientContext();
  await ctx.plugin(SlotsService);
  await ctx.plugin(ObjectsService);
  return ctx;
}
