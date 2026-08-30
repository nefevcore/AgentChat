// ============================================================
// core/extensions/types.ts —— UiExtensionHost 桥接类型（P5.3）
//
// 插件入口模块约定：
//   export function install(ctx: UiExtensionContext): void | (() => void) | Promise<void | (() => void)>;
// ============================================================

import type { Component } from 'vue';
import type { Perspective } from '@/core/registry/perspectives';
import type { MessageViewDef } from '@/core/registry/messageViews';
import type { SettingsTabDef, SidebarActionDef } from './slots';
import type { GlobalStyleDef } from './p5.5-policy';

/** ws-event 扩展点回调（Port B：preview 事件帧载荷 = args[0]） */
export type EventHandler = (data: unknown) => void;

export type Disposer = () => void;

export type { UIExtensionDescriptor, UISlotId } from '@agentchat/protocol';

/** 插件入口模块（动态 import 的 /ui-plugin/<name>/<entry>） */
export interface UiExtensionModule {
  install?: (ctx: UiExtensionContext) => void | Disposer | Promise<void | Disposer>;
}

export interface UiExtensionContext {
  /** 插件名（与 manifest.name 一致） */
  name: string;
  /** 宿主注入的 Vue 工具（h/defineComponent/ref/computed/watch），插件不再自行 import 'vue' */
  vue: Pick<typeof import('vue'), 'h' | 'defineComponent' | 'ref' | 'computed' | 'watch'>;

  // —— 既有扩展点桥接 ——
  registerPerspective(p: Perspective): Disposer;
  registerToolResultView(match: string | RegExp, component: Component, opts?: { priority?: number }): Disposer;
  registerMessageView(def: MessageViewDef, renderer?: Component): Disposer;
  registerEventHandler(type: string, fn: EventHandler): Disposer;

  // —— 新增 slot ——
  registerSettingsTab(tab: SettingsTabDef): Disposer; // 全局设置页签
  registerAgentSettingsTab(tab: SettingsTabDef): Disposer; // Agent 设置页签
  registerSidebarAction(action: SidebarActionDef): Disposer; // 侧边栏动作
  registerGlobalStyle(def: GlobalStyleDef): Disposer; // P5.5 scoped CSS / CSS 变量（前缀重写 + 禁 url()）

  // —— 与后端交互 ——
  request<T>(path: string, init?: RequestInit): Promise<T>; // 同 origin fetch（复用现有 client）
  wsOn(type: string, handler: EventHandler): Disposer; // 现有 WS 通道
  onUnload(fn: () => void): void;
}
