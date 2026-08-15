<script setup lang="ts">
// ============================================================
// PluginCard.vue —— 已安装插件卡片（P3：版本/owner/权限徽章/卸载）
// ============================================================
import { computed } from 'vue';
import type { PluginInfo, PluginPermissionsView, PluginPermission } from '../types';

const props = defineProps<{
  plugin: PluginInfo;
  permissions: PluginPermissionsView | null;
  busy?: boolean;
}>();
const emit = defineEmits<{ (e: 'uninstall', name: string): void }>();

const defaultGranted = computed(() => new Set(props.permissions?.defaultGranted ?? ['fs', 'network']));
const granted = computed(() => new Set(props.plugin.grantedPermissions ?? []));
const declaredMissing = computed(() =>
  (props.plugin.permissions ?? []).filter((p) => !granted.value.has(p) && !defaultGranted.value.has(p)),
);

function badgeCls(p: PluginPermission): string {
  if (defaultGranted.value.has(p)) return 'default';
  return granted.value.has(p) ? 'granted' : 'required';
}
</script>

<template>
  <div class="plugin-card">
    <div class="plugin-card-head">
      <span class="plugin-card-name">{{ plugin.label || plugin.name }}</span>
      <span class="plugin-card-version" v-if="plugin.version">v{{ plugin.version }}</span>
      <span class="plugin-card-source">{{ plugin.source === 'installed' ? '已安装' : plugin.source }}</span>
    </div>
    <div class="plugin-card-desc" v-if="plugin.description">{{ plugin.description }}</div>
    <div class="plugin-card-meta">
      <span v-if="plugin.owner">owner: {{ plugin.owner }}</span>
      <span v-if="plugin.installedAt">安装于 {{ plugin.installedAt.slice(0, 16).replace('T', ' ') }}</span>
      <span v-if="plugin.provides">提供 {{ plugin.provides.tools.length }} 工具 / {{ plugin.provides.hooks.length }} 钩子</span>
    </div>
    <div class="plugin-card-badges">
      <span v-for="p in plugin.permissions ?? []" :key="p" class="perm-badge" :class="badgeCls(p)" :title="badgeCls(p) === 'required' ? '声明但未授予' : badgeCls(p) === 'granted' ? '已授予' : '默认授予'">{{ p }}</span>
      <span v-if="declaredMissing.length" class="perm-missing">声明但未授予：{{ declaredMissing.join(', ') }}（重启后可能加载失败）</span>
    </div>
    <div class="plugin-card-actions">
      <button class="plugin-card-btn danger" :disabled="busy" @click="emit('uninstall', plugin.name)">{{ busy ? '处理中…' : '卸载' }}</button>
    </div>
  </div>
</template>

<style scoped>
.plugin-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--bg-surface);
}
.plugin-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.plugin-card-name { font-size: 13px; font-weight: 600; color: var(--text-1); }
.plugin-card-version { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.plugin-card-source { font-size: 10px; padding: 2px 8px; border-radius: 999px; color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.plugin-card-desc { font-size: 12px; color: var(--text-2); }
.plugin-card-meta { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.plugin-card-badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.perm-badge {
  font-size: 10px; line-height: 1; padding: 2px 7px; border-radius: 999px;
  font-family: var(--font-mono); white-space: nowrap;
}
.perm-badge.default { color: var(--text-2); background: var(--bg-hover); }
.perm-badge.granted { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.perm-badge.required { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.perm-missing { font-size: 11px; color: var(--warn); }
.plugin-card-actions { display: flex; justify-content: flex-end; gap: 6px; }
.plugin-card-btn {
  padding: 4px 12px; border: 1px solid var(--line-strong); border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer;
}
.plugin-card-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-1); }
.plugin-card-btn.danger { color: var(--err); }
.plugin-card-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--err) 10%, transparent); }
.plugin-card-btn:disabled { opacity: .5; cursor: not-allowed; }
</style>
