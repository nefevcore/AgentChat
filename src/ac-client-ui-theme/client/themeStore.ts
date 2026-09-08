// ============================================================
// ac-client-ui-theme/client/themeStore.ts —— 主题 pinia 门面
//（包内消费面：sidebar 面板壳等组件用）
//
// runtime 在场 → 绑 ctx.theme.core（单一事实源）；无 runtime（单测）
// → 独立 ThemeCore。与 webui stores/theme.ts 同 pinia id 'theme'：
// app 内两定义均绑 runtime core = 同一 store 实例（先注册者生效）。
// ============================================================

import { defineStore } from 'pinia';
import { clientRuntime } from 'ac-client-runtime';
import { ThemeCore } from './index.ts';

export const useThemeStore = defineStore('theme', () => {
  const core = clientRuntime()?.theme?.core ?? new ThemeCore();

  return {
    theme: core.theme,
    toggleTheme: core.toggleTheme.bind(core),
    applyThemeClass: core.applyThemeClass.bind(core),
  };
});
