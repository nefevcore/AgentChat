// ============================================================
// framework/messageViews.ts —— 消息渲染插槽
//
// 按"消息展示类型"分发渲染组件。TurnDisplayItem 只负责选择
// 插槽，不写死分支；新增消息类型 = 注册一个视图组件。
//
// 展示类型（kind）：
//   - 'user'       用户气泡
//   - 'assistant'  Agent 回复气泡
//   - 'tool'       工具调用/结果
//   - 'trigger'    系统触发分隔符
// ============================================================

import type { Component } from 'vue';
import { SlotRegistry, type RegistryEntry } from './registry';

export type MessageViewKind = 'user' | 'assistant' | 'tool' | 'trigger';

export interface MessageViewEntry extends RegistryEntry {
  kind: MessageViewKind;
  component: Component;
}

const messageViewRegistry = new SlotRegistry<MessageViewEntry>();

/** 注册消息视图（同名覆盖：插件可替换默认实现） */
export function registerMessageView(kind: MessageViewKind, component: Component): void {
  messageViewRegistry.register({ id: kind, kind, component });
}

export function getMessageView(kind: MessageViewKind): Component | undefined {
  return messageViewRegistry.get(kind)?.component;
}

export function getMessageViews(): MessageViewEntry[] {
  return messageViewRegistry.all();
}
