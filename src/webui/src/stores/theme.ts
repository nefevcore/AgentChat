// ============================================================
// stores/theme.ts —— 主题门面（M27 S2：兼容桥接 ctx.theme）
//
// D13 bridge 同款：runtime 在场 → 绑 ctx.theme.core（单一事实源，
// theme 基础件私有视图状态 + 方法面）；无 runtime（单测）→ 独立
// ThemeCore。消费面组件暂经门面（零 churn），S4 薄壳收口时退役。
// ============================================================

import { defineStore } from 'pinia';
import { clientRuntime } from '../runtime/clientRuntime';
import { ThemeCore } from '../clients/base/theme';

export type { ThemeMode } from '../clients/base/theme';

export const useThemeStore = defineStore('theme', () => {
  const core = clientRuntime()?.theme?.core ?? new ThemeCore();

  return {
    theme: core.theme,
    toggleTheme: core.toggleTheme.bind(core),
    applyThemeClass: core.applyThemeClass.bind(core),
  };
});
