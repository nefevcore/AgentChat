// ============================================================
// client/onboardingBus.ts —— 向导重播通道（模块级轻量事件面）
//
// 重播入口（更多菜单「新手引导」）与向导壳分属不同组件树位置，
// 经模块级回调注册解耦（无 pinia 依赖——向导域状态本就局部，不值得
// 建 store）。批 4 接入 activity-bar:more-menu 数据席位后，菜单项
// action 仍调用 openOnboarding()——本通道是向导域内部词汇。
// ============================================================

type OpenListener = () => void;

const listeners = new Set<OpenListener>();

/** 注册「打开向导」监听（组件挂载期调用；返回注销函数） */
export function onOpenOnboarding(fn: OpenListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 请求打开向导（重播入口调用——重置到第 1 步） */
export function openOnboarding(): void {
  for (const fn of listeners) fn();
}

import { onBeforeUnmount } from 'vue';

/** 组合式包装：挂载期注册 + 卸载期注销 */
export function useOnboardingBus(onOpen: OpenListener): { offBus: () => void } {
  const off = onOpenOnboarding(onOpen);
  onBeforeUnmount(off);
  return { offBus: off };
}
