<script setup lang="ts">
// ============================================================
// PluginDevCard.vue —— 开发插件卡片（P3：manifest 摘要 + 会话注册/卸载/发布）
// ============================================================
import { computed } from 'vue';
import type { PluginInfo } from '../types';

const props = defineProps<{
  plugin: PluginInfo;
  /** 是否已作为会话级插件加载（PluginHost sessionOnly） */
  loaded: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{
  (e: 'register', plugin: PluginInfo): void;
  (e: 'unregister', name: string): void;
  (e: 'stage', plugin: PluginInfo): void;
}>();

/** 供给面摘要（M23 G4 对象形状安全渲染：tools/llmProviders/events 各段计数，
 *  为 0 或 undefined 的段不显示；全空 → 不渲染该行） */
const providesSummary = computed<string | null>(() => {
  const p = props.plugin.provides;
  if (!p) return null;
  const parts: string[] = [];
  const tools = p.tools?.length ?? 0;
  const providers = p.llmProviders?.length ?? 0;
  const events = p.events?.length ?? 0;
  if (tools > 0) parts.push(`${tools} 工具`);
  if (providers > 0) parts.push(`${providers} provider`);
  if (events > 0) parts.push(`${events} 事件`);
  return parts.length ? `提供 ${parts.join(' / ')}` : null;
});
</script>

<template>
  <div class="dev-card" :class="{ loaded }">
    <div class="dev-head">
      <span class="dev-name">{{ plugin.label || plugin.name }}</span>
      <span class="dev-version" v-if="plugin.version">v{{ plugin.version }}</span>
      <span class="dev-badge dev">开发中</span>
      <span v-if="loaded" class="dev-badge session">会话已加载</span>
    </div>
    <div class="dev-desc" v-if="plugin.description">{{ plugin.description }}</div>
    <div class="dev-meta">
      <span>owner: {{ plugin.owner || 'unknown' }}</span>
      <span v-if="providesSummary">{{ providesSummary }}</span>
    </div>
    <div class="dev-dir" :title="plugin.dir">{{ plugin.dir || '' }}</div>
    <div class="dev-badges">
      <span v-for="p in plugin.permissions ?? []" :key="p" class="perm-badge">{{ p }}</span>
      <span v-if="!(plugin.permissions?.length)" class="dev-no-perm">无额外权限声明</span>
    </div>
    <div class="dev-actions">
      <button v-if="!loaded" class="dev-btn primary" :disabled="busy" @click="emit('register', plugin)">注册会话</button>
      <button v-else class="dev-btn" :disabled="busy" @click="emit('unregister', plugin.name)">卸载会话</button>
      <button class="dev-btn primary" :disabled="busy" @click="emit('stage', plugin)">发布（stage）</button>
    </div>
  </div>
</template>

<style scoped>
.dev-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--bg-surface);
}
.dev-card.loaded { border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
.dev-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dev-name { font-size: 13px; font-weight: 600; color: var(--text-1); }
.dev-version { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.dev-badge { font-size: 10px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.dev-badge.dev { color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, transparent); }
.dev-badge.session { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.dev-desc { font-size: 12px; color: var(--text-2); }
.dev-meta { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--text-3); }
.dev-dir {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  background: var(--bg-hover); border-radius: var(--r-sm); padding: 4px 8px;
  word-break: break-all;
}
.dev-badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.perm-badge {
  font-size: 10px; line-height: 1; padding: 2px 7px; border-radius: 999px;
  color: var(--text-2); background: var(--bg-hover); font-family: var(--font-mono);
}
.dev-no-perm { font-size: 11px; color: var(--text-3); }
.dev-actions { display: flex; justify-content: flex-end; gap: 6px; }
.dev-btn {
  padding: 4px 12px; border: 1px solid var(--line-strong); border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer;
}
.dev-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-1); }
.dev-btn.primary { color: var(--primary); border-color: color-mix(in srgb, var(--primary) 40%, transparent); }
.dev-btn.primary:hover:not(:disabled) { background: var(--primary-light); }
.dev-btn:disabled { opacity: .5; cursor: not-allowed; }
</style>
