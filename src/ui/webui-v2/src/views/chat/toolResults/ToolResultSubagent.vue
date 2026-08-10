<!-- ToolResultSubagent.vue —— subAgent 系列工具结果 -->
<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ data: any; raw?: string }>();

const agentName = computed(() => props.data?.agentName ?? props.data?.name ?? props.data?.agent_id ?? '');
const status = computed(() => props.data?.status ?? '');
const summary = computed(() => props.data?.summary ?? props.data?.result ?? props.data?.output ?? props.raw ?? '');
</script>

<template>
  <div class="tool-subagent">
    <div class="subagent-header">
      <span class="subagent-label">🛠 子代理</span>
      <span v-if="agentName" class="subagent-name">{{ agentName }}</span>
      <span v-if="status" class="subagent-status">{{ status }}</span>
    </div>
    <pre v-if="summary" class="subagent-summary">{{ summary }}</pre>
  </div>
</template>

<style scoped>
.tool-subagent {
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
}
.subagent-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.subagent-label { font-size: 12px; font-weight: 600; color: #9b59b6; }
.subagent-name { font-size: 12.5px; color: var(--color-text-secondary); }
.subagent-status { font-size: 11px; color: var(--color-text-tertiary, #a8abb2); }
.subagent-summary {
  font-size: 12.5px;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  margin-top: 6px;
  max-height: 200px;
  overflow-y: auto;
  font-family: inherit;
}
</style>
