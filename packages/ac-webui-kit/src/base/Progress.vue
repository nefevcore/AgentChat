<!--
  webui-kit/src/base/Progress.vue —— 细进度条（cr-157）
  归一：TokenUsage .progress-track、AgentList 用量条、PluginLibraryPane 读取进度等。
  tone：ok（缺省，完成向）/ primary（进行向）。
-->
<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  /** 0-100，越界钳制 */
  value: number;
  tone?: 'ok' | 'primary';
}>(), { tone: 'ok' });

const pct = computed(() => Math.max(0, Math.min(100, props.value)));
</script>

<template>
  <div class="ui-progress" role="progressbar" :aria-valuenow="Math.round(pct)" aria-valuemin="0" aria-valuemax="100">
    <i class="ui-progress-fill" :class="tone" :style="{ width: pct + '%' }" />
  </div>
</template>

<style scoped>
.ui-progress {
  width: 100%; height: 8px; border-radius: var(--r-full);
  background: var(--bg-hover); overflow: hidden;
}
.ui-progress-fill { display: block; height: 100%; border-radius: var(--r-full); }
.ui-progress-fill.ok { background: var(--ok); }
.ui-progress-fill.primary { background: var(--primary); }
</style>