// ============================================================
// stores/theme.ts —— 主题切换 + 持久化
// ============================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';

const THEME_KEY = 'agentchat.v2.theme';

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<'dark' | 'light'>('dark');

  function applyThemeClass(): void {
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.classList.add(theme.value);
  }

  function init(): void {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') theme.value = saved;
    } catch { /* ignore */ }
    applyThemeClass();
    window.dispatchEvent(new CustomEvent('theme-changed', { detail: theme.value }));
  }

  function toggleTheme(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, theme.value); } catch { /* ignore */ }
    applyThemeClass();
    window.dispatchEvent(new CustomEvent('theme-changed', { detail: theme.value }));
  }

  return { theme, toggleTheme, init };
});
