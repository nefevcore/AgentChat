/// <reference lib="dom" />
// ============================================================
// ac-client-ui-theme/client/index.ts —— theme 基础件 client 半边
//（M27.2-2 出包首件；原 webui/src/clients/base/theme.ts 原样迁入）
//
// ctx.theme（服务名与服务端占名无碰撞，D22）：
//   · 视图状态（明暗主题）归本件私有（§0.3 层 1）——不跨插件暴露
//     store 本体；他件影响主题走服务方法（toggle/set）；
//   · 持久化 localStorage('agentchat.theme') + html class 应用 +
//     highlight.js 主题切换事件（theme-changed）原样继承；
//   · 双模门面：webui stores/theme.ts 转发 ctx.theme.core（runtime
//     在场）/ 独立 Core（无 runtime 单测）——roster 门面同款。
// 行 client 不 import webui 内部模块（依赖一律 inject 声明，D6）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { ref, watch, type Ref } from 'vue';

export type ThemeMode = 'light' | 'dark';

/** 主题核心（纯 reactive；门面独立模式复用） */
export class ThemeCore {
  readonly theme: Ref<ThemeMode> = ref(getInitialTheme());

  constructor() {
    // 持久化 + 应用（immediate：构造即应用当前主题；sync：toggle 后
    // html class 同步生效——直读 DOM class 的消费面确定性）
    watch(this.theme, (val) => {
      try { localStorage.setItem('agentchat.theme', val); } catch { /* ignore */ }
      this.applyThemeClass();
      // 触发 highlight.js 主题切换事件
      window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: val } }));
    }, { immediate: true, flush: 'sync' });
  }

  toggleTheme(): void {
    this.theme.value = this.theme.value === 'dark' ? 'light' : 'dark';
  }

  applyThemeClass(): void {
    if (this.theme.value === 'dark') {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    } else {
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
    }
  }
}

function getInitialTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem('agentchat.theme');
    if (stored === 'dark' || stored === 'light') return stored;
  } catch { /* ignore */ }
  // 跟随系统偏好
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export interface ThemeClientOptions {
  /** 预留（对齐 cordis Service 构造签名形态） */
}

export class ThemeService extends Service {
  readonly core = new ThemeCore();

  constructor(ctx: Context, options: ThemeClientOptions = {}) {
    super(ctx, 'theme');
    void options;
  }

  get theme(): Ref<ThemeMode> { return this.core.theme; }
  toggleTheme(): void { this.core.toggleTheme(); }
  applyThemeClass(): void { this.core.applyThemeClass(); }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** theme 基础件（视图状态私有 + 方法面）：theme/toggleTheme/applyThemeClass */
    theme: ThemeService;
  }
}

/** theme 基础件 client 半边插件（boot graph base 阶段装载；宿主半边见 src/index.ts） */
export const themeClientPlugin = clientPlugin({
  name: 'ac-client-ui-theme.client',
  async apply(ctx: ClientContext) {
    await ctx.plugin(ThemeService);
  },
});

export default themeClientPlugin;
