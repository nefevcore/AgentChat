// ============================================================
// ac-client-runtime/src/vue.ts —— Vue 组件级 fiber 生命周期（M27 D17）
//
// Koishi 采纳（webui-koishi-console-research §1.1/§3.1-3）：
//   · useContext() —— 组件内 inject ctx → fork（空插件 fiber）→
//     组件卸载即 dispose——组件生命周期 = fiber 生命周期，组件内
//     注册的一切 effect/contribution 随组件卸载回收；
//   · wrapComponent —— 贡献组件包一层 provide 隔离 ctx——Vue 组件树
//     与 fiber 树对齐（渲染器对每个贡献条目经 ownerOf(entry) 取注册方
//     ctx 包裹，贡献组件内部 useContext() 拿到的是其插件自己的 ctx）。
//
// ctx 注入键 = CLIENT_CONTEXT_KEY（app.provide 于装配序列 mount 前）。
// ============================================================
import { h, inject, onBeforeUnmount, provide, defineComponent, type Component, type InjectionKey } from 'vue';
import type { ClientContext } from './context.ts';

/** 客户端 ctx 的 Vue 注入键（app.provide(CLIENT_CONTEXT_KEY, ctx)——应用级，全树可见） */
export const CLIENT_CONTEXT_KEY: InjectionKey<ClientContext> = Symbol('agentchat-client-context');

/**
 * 贡献条目 owner ctx 注入键（D17）：wrapComponent 经它向贡献组件声明
 * 「你住在哪个插件的 fiber 里」——useContext() 优先从 owner fork（组件
 * 内注册的 contribution 随组件卸载回收、随 owner 卸载级联）。
 * 【不覆盖 CLIENT_CONTEXT_KEY】：宿主内容（如 root 占据者的整棵子树）
 * 仍按应用级 provide 解析跨域服务——owner 隔离只作用于显式 useContext()。
 */
export const SLOT_OWNER_KEY: InjectionKey<ClientContext> = Symbol('agentchat-slot-owner');

/** 组件树内取客户端 ctx（应用级；未提供 → undefined） */
export function useClientContext(): ClientContext | undefined {
  return inject(CLIENT_CONTEXT_KEY, undefined);
}

/**
 * 组件级 fiber（D17）：在组件 setup 内调用——fork 一个空插件 fiber
 * （预注入 'slots'——组件级贡献的主面；更多依赖经 owner 插件面声明），
 * 组件卸载即 dispose。组件内经返回的 fork ctx 注册的 slot 贡献/事件
 * 监听随组件卸载自动回收。
 *
 * 优先从 SLOT_OWNER_KEY（贡献条目的 owner 插件 ctx）fork——组件树与
 * fiber 树对齐；宿主内容回落应用级 CLIENT_CONTEXT_KEY。
 *
 * @param parent 显式父 ctx（组件树外/测试用；缺省按注入链解析）
 */
export function useContext(parent?: ClientContext): ClientContext {
  const base = parent ?? inject(SLOT_OWNER_KEY, undefined) ?? inject(CLIENT_CONTEXT_KEY, undefined);
  if (!base) {
    throw new Error(
      'useContext(): 组件树外调用且未传 parent——app 需先 provide(CLIENT_CONTEXT_KEY, ctx)（M27 D17）',
    );
  }
  // fork：空插件 fiber；inject ['slots'] 让 fork ctx 可解析 ctx.slots
  //（本 cordis 属性解析按 fiber 链 walk——依赖一律 inject 声明，D6）
  const fiber = base.plugin({ name: 'vue-component-fork', inject: ['slots'], apply() {} });
  onBeforeUnmount(() => void fiber.dispose());
  // fiber.ctx 运行时即客户端上下文（base 为 ClientContext 子链）
  return fiber.ctx as unknown as ClientContext;
}

/**
 * 贡献组件包裹（D17）：provide owner ctx（SLOT_OWNER_KEY）后渲染原组件
 * ——零 DOM 包裹（D23-A）。只标记 owner 身份，不劫持子树的应用级
 * CLIENT_CONTEXT_KEY（宿主内容的跨域服务解析不受贡献边界影响）。
 * 渲染器侧按 (entry → wrapped) 缓存，避免每次渲染重建组件。
 */
export function wrapComponent(component: Component, ctx: ClientContext): Component {
  return defineComponent({
    name: 'AcSlotWrapped',
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      provide(SLOT_OWNER_KEY, ctx);
      // attrs/slots 原样透传（包裹层零语义：只补 provide，不加 DOM）
      return () => h(component, attrs, slots);
    },
  });
}
