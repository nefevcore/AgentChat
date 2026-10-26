// ============================================================
// ac-client-ui-layout/client/registerView.ts —— 视角挂载公开入口
//（B3 批，design-plugin-client-channel.md §2.1 ③——layout 骨架在
// 该设计内唯一新增的 API：main/aux 两轴选举解析面的包外注册门面）
//
// 消费面两档：非隔离档模块 apply 内自注册（插件 client 通道经
// channelImports 引本包 client——moduleHost 单例契约）；隔离档由
// 宿主装载器代挂 iframe 容器承载（§1 隔离档粒度：容器整块 = 宿主
// 能给的唯一承载，组件在 iframe 内宿主拿不到细粒度）。
//
// 缺省值取向 = 不抢占出厂视图：order 缺省 100——main 轴与 chat 兜底
// 平局、chat 先注册恒胜（第三方主区视角须显式 active()/order 才
// 当选）；aux 轴谓词选举让位出厂选区（order 小者先），显式选区
// 路径（rail 按钮点击置 ui.auxPanel）恒可达。active 缺省恒真。
// ============================================================
import type { Component } from 'vue';
import type { ClientContext } from 'ac-client-runtime';
import type { MainViewDef } from './mainViews.ts';
import type { AuxSidebarPanelDef } from './auxSidebarViews.ts';

/** 视角挂载注册（manifest seats[].view 的注册面同形——region/id/label） */
export interface ViewRegistration {
  /** 挂载区域：main = 主区视角（MainViewDef 选举）；aux = 辅栏选区（AuxSidebarPanelDef 选举） */
  region: 'main' | 'aux';
  /** 视角 id（param-case——选举键；aux 域同时是显式选区 ui.auxPanel 的值域） */
  id: string;
  /** 显示名（aux rail 按钮提示文案；缺省 = id） */
  label?: string;
  /** 渲染组件 */
  component: Component;
  /** 选举序（缺省 100——不抢占出厂视图，见模块头注） */
  order?: number;
  /** 当选谓词（缺省恒真；安全求值住解析面——抛错只失去选举资格） */
  active?: () => boolean;
}

/**
 * 注册视角（main/aux 选举席贡献门面——entry id 词形 view.<id>）。
 * 返回 disposer（撤销注册）。坏形状 fail-loud 抛错。
 */
export function registerView(ctx: ClientContext, view: ViewRegistration): () => void {
  if (typeof view.id !== 'string' || view.id === '' || !/^[a-z0-9-]+$/.test(view.id)) {
    throw new Error(`[registerView] id 非法（非空 param-case 小写连字符词）：${String(view.id)}`);
  }
  // component 缺席由 SlotCore register 面 fail-closed（非数据席位必填）
  const active = view.active ?? (() => true);
  const entryId = `view.${view.id}`;
  if (view.region === 'main') {
    const def: MainViewDef = { id: view.id, order: view.order, active, component: view.component };
    return ctx.slots.register('main', { id: entryId, component: view.component, order: view.order, meta: { def } });
  }
  const def: AuxSidebarPanelDef = {
    id: view.id,
    order: view.order,
    active,
    component: view.component,
    rail: { icon: 'app-window', title: view.label ?? view.id },
  };
  return ctx.slots.register('aux-sidebar', { id: entryId, component: view.component, order: view.order, meta: { def } });
}
