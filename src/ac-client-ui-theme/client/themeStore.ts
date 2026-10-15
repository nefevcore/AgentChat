// ============================================================
// ac-client-ui-theme/client/themeStore.ts —— 主题 pinia 门面
//（消费面：agents/singles/runview/subagent/usage 域行组件 + layout 壳）
//
// runtime 在场 → 绑 ctx.theme.core（单一事实源）；无 runtime（单测）
// → 独立 ThemeCore。pinia id 'theme' 全仓唯此一处定义。
// ============================================================

import { defineStore } from 'pinia';
import { clientRuntime } from 'ac-client-runtime';
import { ThemeCore } from './index.ts';

export const useThemeStore = defineStore('theme', () => {
  // theme 域行运行时可缺席——augment 必填仅表「装载后」
  const theme = clientRuntime()?.theme as { core: ThemeCore } | undefined;
  const core = theme?.core ?? new ThemeCore();

  return {
    theme: core.theme,
    preference: core.preference,
    toggleTheme: core.toggleTheme.bind(core),
    setTheme: core.setTheme.bind(core),
    followSystem: core.followSystem.bind(core),
  };
});
