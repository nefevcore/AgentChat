import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

export type ThemeMode = 'light' | 'dark';

function getInitialTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem('agentchat.theme');
    if (stored === 'dark' || stored === 'light') return stored;
  } catch { /* ignore */ }
  // 跟随系统偏好
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<ThemeMode>(getInitialTheme());

  function applyThemeClass() {
    if (theme.value === 'dark') {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    } else {
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
    }
  }

  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }

  // 持久化 + 应用
  watch(theme, (val) => {
    try { localStorage.setItem('agentchat.theme', val); } catch { /* ignore */ }
    applyThemeClass();
    // 触发 highlight.js 主题切换事件
    window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: val } }));
  }, { immediate: true });

  return {
    theme,
    toggleTheme,
    applyThemeClass,
  };
});
