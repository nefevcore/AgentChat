<!-- ToolResultTerminal.vue —— bash 工具结果（终端质感） -->
<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ data: any; raw?: string }>();

const output = computed(() => {
  return props.data?.output ?? props.data?.result ?? props.data?.stdout ?? props.raw ?? '';
});
const command = computed(() => props.data?.command ?? props.data?.cmd ?? '');
</script>

<template>
  <div class="tool-terminal">
    <div v-if="command" class="term-command">$ {{ command }}</div>
    <pre class="term-output">{{ output }}</pre>
  </div>
</template>

<style scoped>
.tool-terminal {
  background: #0d1117;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  overflow: hidden;
}
.term-command {
  padding: 8px 12px;
  font-size: 12.5px;
  font-family: 'Cascadia Code', Consolas, monospace;
  color: #7ee787;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.term-output {
  padding: 10px 12px;
  font-size: 12.5px;
  font-family: 'Cascadia Code', Consolas, monospace;
  color: #c9d1d9;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
  margin: 0;
}
</style>
