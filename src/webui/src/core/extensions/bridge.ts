// ============================================================
// core/extensions/bridge.ts —— install(ctx) 桥接实现
//
// M27 D8 收窄（S3）：组件贡献类六项（perspective / tool-result /
// message-view / settings-tab×2 / sidebar-action）纯转发 slots.register
//（经各解析面——数据面 = SlotRegistry）；非视觉缝不走 slot：
// registerGlobalStyle 维持样式消毒通道、wsOn/registerEventHandler 维持
// 常设事件通道。调用前经 slotCatalog 校验 manifest.ui.slots 声明 ∈
// 永久目录 + 公开子集（D13 开口策略）。每个注册返回的 disposer 都会被
// 记录，卸载时由 host 统一逆序执行。
// ============================================================

import * as vue from 'vue';
import type { Component } from 'vue';
import type { UIExtensionDescriptor, UISlotId } from '@agentchat/protocol';
import { registerPerspective } from '@/core/registry/perspectives';
import { registerMessageView } from '@/core/registry/messageViews';
import { registerToolResultView } from '@/core/registry/toolResultViews';
import { request as apiRequest } from '@/core/api/client';
import { wireRpc } from '@/api/wire';
import { registerSettingsTab, registerAgentSettingsTab, registerActivityBarAction } from './slots';
import { assertDeclarableSlot } from './slotCatalog';
import { rewriteGlobalStyle } from './p5.5-policy';
import type { UiExtensionContext, Disposer } from './types';

const bridgeDisposers = new WeakMap<UiExtensionContext, Disposer[]>();

function assertSlot(descriptor: UIExtensionDescriptor, slot: UISlotId): void {
  assertDeclarableSlot(descriptor, slot);
}

/** 创建插件桥接上下文。返回 ctx；桥接记录的 disposers 通过 getBridgeDisposers(ctx) 取出。 */
export function createBridge(descriptor: UIExtensionDescriptor): UiExtensionContext {
  const disposers: Disposer[] = [];
  const record = (d: Disposer): Disposer => {
    disposers.push(d);
    return d;
  };

  const ctx: UiExtensionContext = {
    name: descriptor.name,
    vue: {
      h: vue.h,
      defineComponent: vue.defineComponent,
      ref: vue.ref,
      computed: vue.computed,
      watch: vue.watch,
    },

    registerPerspective(p) {
      assertSlot(descriptor, 'perspective');
      return record(registerPerspective(p));
    },

    registerToolResultView(match: string | RegExp, component: Component, opts?: { priority?: number }) {
      assertSlot(descriptor, 'tool-result');
      return record(registerToolResultView(match, component, opts));
    },

    registerMessageView(def, renderer?) {
      assertSlot(descriptor, 'message-view');
      return record(registerMessageView(def, renderer));
    },

    registerEventHandler(type, fn) {
      assertSlot(descriptor, 'ws-event');
      // Port B：ws-event 扩展点 = wire 事件订阅（preview 事件名；载荷=args[0]）
      return record(wireRpc.onWireEvent((t, args) => {
        if (t === type) fn(args[0]);
      }));
    },

    registerSettingsTab(tab) {
      assertSlot(descriptor, 'settings-tab:global');
      // 加插件名前缀，保证多插件间页签 id 不冲突；同插件同 id 仍然替换
      return record(registerSettingsTab({ ...tab, id: `${descriptor.name}-${tab.id}` }));
    },

    registerAgentSettingsTab(tab) {
      assertSlot(descriptor, 'settings-tab:agent');
      return record(registerAgentSettingsTab({ ...tab, id: `${descriptor.name}-${tab.id}` }));
    },

    registerActivityBarAction(action) {
      assertSlot(descriptor, 'sidebar-action');
      return record(registerActivityBarAction({ ...action, id: `${descriptor.name}-${action.id}` }));
    },

    registerGlobalStyle(def) {
      assertSlot(descriptor, 'global-style');
      // P5.5：宿主重写选择器前缀 + 禁 url() 外链；失败抛错由 host 隔离回滚
      const css = rewriteGlobalStyle(descriptor.name, def);
      const style = document.createElement('style');
      style.dataset.uiGlobalStyle = descriptor.name;
      style.textContent = css;
      document.head.appendChild(style);
      return record(() => style.remove());
    },

    request<T>(path: string, init?: RequestInit): Promise<T> {
      return apiRequest<T>(path, init);
    },

    wsOn(type, handler) {
      // 记录 disposer：插件即使忽略返回值，卸载时也能撤销 WS 订阅
      // （Port B：preview 事件帧；handler 收到 args 数组解包后的首参载荷）
      return record(wireRpc.onWireEvent((t, args) => {
        if (t === type) handler(args[0]);
      }));
    },

    onUnload(fn) {
      disposers.push(fn);
    },
  };

  bridgeDisposers.set(ctx, disposers);
  return ctx;
}

export function getBridgeDisposers(ctx: UiExtensionContext): Disposer[] {
  return bridgeDisposers.get(ctx) ?? [];
}
