// ============================================================
// core/registry/perspectives.ts —— 视角注册表 ★顶层扩展点
//
// 设计哲学："视图即筛选" —— 主界面是统一状态下的视角容器，
// 每个视角 = { active 判定 + 渲染组件 + props }。
// 当前注册：talk（direct 会话）/ group（群聊）—— 二者共享 DialogView 内核，
// 只是数据 selector（group prop）不同。未来社区流/星图/过程工作台 = 新增注册项。
// ============================================================

import type { Component } from 'vue';

export interface Perspective {
  id: string;
  label: string;
  icon?: string;
  /** 当前是否激活（主界面同时只有一个视角激活） */
  active: () => boolean;
  /** 渲染组件 */
  component: Component;
  /** 传给组件的 props（惰性求值，保证取到最新 store 状态） */
  props?: () => Record<string, unknown>;
}

const views: Perspective[] = [];

export function registerPerspective(p: Perspective): void {
  views.push(p);
}

/** 当前激活的视角（按注册顺序取第一个 active） */
export function activePerspective(): Perspective | null {
  for (const p of views) {
    if (p.active()) return p;
  }
  return null;
}

/** 全部视角（供切换器/调试） */
export function allPerspectives(): readonly Perspective[] {
  return views;
}
