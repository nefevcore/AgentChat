/// <reference lib="dom" />
// ============================================================
// ac-client-ui-theme/client/index.ts —— theme 基础件 client 半边
//（M27.2-2 出包首件；原 webui/src/clients/base/theme.ts 原样迁入）
//
// ctx.theme（服务名与服务端占名无碰撞，D22）：
//   · 视图状态（明暗主题）归本件私有（§0.3 层 1）——不跨插件暴露
//     store 本体；他件影响主题走服务方法（toggle/set/followSystem）；
//   · 持久化 localStorage('agentchat.theme') + html class 应用 +
//     highlight.js 主题切换事件（theme-changed）原样继承；
//   · 偏好三档 system|light|dark（cr-43 ②）：缺省 system 实时跟随
//     prefers-color-scheme（含运行时 change 监听——安卓下拉切深色即跟），
//     toggle/set 从 system 切出时落定生效值为固定档；
//   · 双模门面：webui stores/theme.ts 转发 ctx.theme.core（runtime
//     在场）/ 独立 Core（无 runtime 单测）——roster 门面同款。
// 行 client 不 import webui 内部模块（依赖一律 inject 声明，D6）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { ref, watch, type Ref } from 'vue';

export type ThemeMode = 'light' | 'dark';
/** 主题偏好档位：system = 跟随系统（缺省），light/dark = 固定档 */
export type ThemePreference = 'system' | ThemeMode;

const STORAGE_KEY = 'agentchat.theme';

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'system' || stored === 'dark' || stored === 'light') return stored;
  } catch { /* ignore */ }
  return 'system';
}

function systemTheme(): ThemeMode {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 主题核心（纯 reactive；门面独立模式复用） */
export class ThemeCore {
  /** 生效主题（system 档 = 系统当前值） */
  readonly theme: Ref<ThemeMode>;
  /** 用户偏好档位（持久化对象） */
  readonly preference: Ref<ThemePreference>;

  /** 系统主题变化 → system 档实时跟随（固定档不受扰） */
  private readonly onMediaChange = (e: MediaQueryListEvent) => {
    if (this.preference.value === 'system') this.theme.value = e.matches ? 'dark' : 'light';
  };

  private readonly media: MediaQueryList | null;

  constructor() {
    this.preference = ref(readStoredPreference());
    this.theme = ref(this.preference.value === 'system' ? systemTheme() : this.preference.value);
    this.media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (this.media) {
      if (typeof this.media.addEventListener === 'function') this.media.addEventListener('change', this.onMediaChange);
      else if (typeof this.media.addListener === 'function') this.media.addListener(this.onMediaChange); // 旧 WebView 兜底
    }
    // 持久化（偏好档位）+ 应用（immediate：构造即应用当前主题；sync：切换后
    // html class 同步生效——直读 DOM class 的消费面确定性）
    watch(this.theme, (val) => {
      this.applyThemeClass();
      // 触发 highlight.js 主题切换事件
      window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: val } }));
    }, { immediate: true, flush: 'sync' });
    watch(this.preference, (val) => {
      try { localStorage.setItem(STORAGE_KEY, val); } catch { /* ignore */ }
    }, { immediate: true, flush: 'sync' });
  }

  toggleTheme(): void {
    this.setTheme(this.theme.value === 'dark' ? 'light' : 'dark');
  }

  setTheme(mode: ThemeMode): void {
    this.preference.value = mode;
    this.theme.value = mode;
  }

  /** 回到跟随系统档（立即对齐当前系统主题） */
  followSystem(): void {
    this.preference.value = 'system';
    this.theme.value = systemTheme();
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
  get preference(): Ref<ThemePreference> { return this.core.preference; }
  toggleTheme(): void { this.core.toggleTheme(); }
  setTheme(mode: ThemeMode): void { this.core.setTheme(mode); }
  followSystem(): void { this.core.followSystem(); }
  applyThemeClass(): void { this.core.applyThemeClass(); }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** theme 基础件（视图状态私有 + 方法面）：theme/preference/toggleTheme/setTheme/followSystem/applyThemeClass */
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
