<script setup lang="ts">
// ============================================================
// PluginCard.vue —— 已安装插件卡片（版本/owner/权限徽章/装载徽章/卸载）
// 装载徽章（M22 D6）：已装载 / 未装载 / 装载失败（附原因，plugin/loaded.failed）
// M23 G9 扩四态：'skipped' = 已熔断（连续装载失败，boot 跳过不再重试）
// ============================================================
import { computed } from 'vue';
import type { PluginInfo, PluginPermissionsView, PluginPermission } from '../types';

/** 四态装载状态（'skipped' = 熔断——plugin/loaded.skipped；G9） */
type LoadState = 'loaded' | 'unloaded' | 'skipped' | { error: string };

const props = defineProps<{
  plugin: PluginInfo;
  permissions: PluginPermissionsView | null;
  busy?: boolean;
  /** 四态装载状态（plugin/loaded × installed 交叉；缺省 = 不显示徽章） */
  loadState?: LoadState;
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

/** 四态装载徽章文案与悬浮说明 */
function loadBadge(s: LoadState): { text: string; cls: string; title: string } {
  if (s === 'loaded') return { text: '已装载', cls: 'ok', title: 'boot 扫描装载成功' };
  if (s === 'unloaded') return { text: '未装载', cls: 'idle', title: '已安装但当前未装载（重启后自动扫描装载）' };
  if (s === 'skipped') {
    return {
      text: '已熔断',
      cls: 'fail',
      title: '连续装载失败已熔断（boot 跳过不再重试）——复位 = bump version 重装 / 卸载 / 删 .load-health.json',
    };
  }
  return { text: '装载失败', cls: 'fail', title: `装载失败：${s.error}` };
}

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

/** admin 徽章语义 hint 触发：声明 shell/process 权限（M23 F7/F8 如实呈现） */
const shellLike = computed(() =>
  (props.plugin.permissions ?? []).some((p) => p === 'shell' || p === 'process'),
);
</script>

<template>
  <div class="plugin-card">
    <div class="plugin-card-head">
      <span class="plugin-card-name">{{ plugin.label || plugin.name }}</span>
      <span class="plugin-card-version" v-if="plugin.version">v{{ plugin.version }}</span>
      <span class="plugin-card-source">{{ plugin.source === 'installed' ? '已安装' : plugin.source }}</span>
      <span
        v-if="loadState"
        class="load-badge"
        :class="loadBadge(loadState).cls"
        :title="loadBadge(loadState).title"
      >{{ loadBadge(loadState).text }}</span>
      <span
        v-if="plugin.uiNonIsolated"
        class="ui-badge"
        title="可读会话流、以用户会话身份调全部 RPC（含写口）"
      >携带非隔离 UI</span>
    </div>
    <div class="plugin-card-desc" v-if="plugin.description">{{ plugin.description }}</div>
    <div v-if="loadState !== undefined && typeof loadState === 'object'" class="plugin-card-load-error">装载失败原因：{{ loadState.error }}</div>
    <div class="plugin-card-meta">
      <span v-if="plugin.owner">owner: {{ plugin.owner }}</span>
      <span v-if="plugin.installedAt">安装于 {{ plugin.installedAt.slice(0, 16).replace('T', ' ') }}</span>
      <span v-if="providesSummary">{{ providesSummary }}</span>
    </div>
    <div class="plugin-card-badges">
      <span v-for="p in plugin.permissions ?? []" :key="p" class="perm-badge" :class="badgeCls(p)" :title="badgeCls(p) === 'required' ? '声明但未授予' : badgeCls(p) === 'granted' ? '已授予' : '默认授予'">{{ p }}</span>
      <span v-if="declaredMissing.length" class="perm-missing">声明但未授予：{{ declaredMissing.join(', ') }}（重启后可能加载失败）</span>
      <span v-if="shellLike" class="perm-bash-hint" title="admin 徽章语义说明">门禁挡的是进程内工具调用，不挡 bash 持有者（bash 可改配置文件自授）</span>
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
.load-badge { font-size: 10px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.load-badge.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.load-badge.idle { color: var(--text-3); background: var(--bg-hover); }
.load-badge.fail { color: var(--err); background: color-mix(in srgb, var(--err) 12%, transparent); }
/* 非隔离 UI 徽章（M23 F7/F8：warn 呈现——用户会话身份全 RPC 面） */
.ui-badge {
  font-size: 10px; padding: 2px 8px; border-radius: 999px; white-space: nowrap;
  color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.plugin-card-load-error { font-size: 11px; color: var(--err); word-break: break-all; }
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
/* admin 门禁语义 hint（M23 F7/F8：shell/process 声明时如实呈现边界） */
.perm-bash-hint { font-size: 10px; color: var(--text-3); }
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
