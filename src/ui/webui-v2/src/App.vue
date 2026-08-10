<script setup lang="ts">
// App.vue —— 极薄根组件：主题初始化 + 组装 AppShell
import { onMounted } from 'vue';
import AppShell from '@/shell/AppShell.vue';
import { useThemeStore } from '@/stores/theme';
import { useChatStore } from '@/stores/chat';

const themeStore = useThemeStore();
const chatStore = useChatStore();

onMounted(() => {
  themeStore.init();
  chatStore.init();
});
</script>

<template>
  <AppShell />
</template>
