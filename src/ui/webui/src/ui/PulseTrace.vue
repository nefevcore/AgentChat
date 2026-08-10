<!--
  ui/PulseTrace.vue —— 思维链脉冲轨迹（折叠容器）
  工坊语言：渐变脉冲线 + 流光（streaming）+ 星色。
  用法：
  <PulseTrace title="思考过程" meta="共 3 步 · 12s" :color="starColor" :streaming="running">
    ...步骤内容...
  </PulseTrace>
-->
<script setup lang="ts">
import { ref } from 'vue';

const props = withDefaults(defineProps<{
  title?: string;
  meta?: string;
  /** 星色（hex/CSS 色） */
  color?: string;
  /** 流式中：脉冲线流光动画 */
  streaming?: boolean;
  /** 默认展开 */
  open?: boolean;
}>(), { title: '思考过程', streaming: false, open: false });

const isOpen = ref(props.open);
</script>

<template>
  <div class="ui-pulse" :style="{ '--tc': color || 'var(--primary)' }">
    <div class="ui-pulse-head" :class="{ open: isOpen }" @click="isOpen = !isOpen">
      <span class="ui-pulse-dot" />
      <span class="ui-pulse-title">{{ title }}</span>
      <div class="ui-pulse-line" :class="{ streaming }" />
      <span v-if="meta" class="ui-pulse-meta">{{ meta }}</span>
      <span class="ui-pulse-chev" />
    </div>
    <div v-show="isOpen" class="ui-pulse-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.ui-pulse {
  border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--bg-surface); overflow: hidden;
}
.ui-pulse-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; font-size: 12.5px; color: var(--text-2); }
.ui-pulse-dot { width: 10px; height: 10px; border-radius: var(--r-full); background: var(--tc); box-shadow: 0 0 10px var(--tc); flex-shrink: 0; }
.ui-pulse-title { flex-shrink: 0; }
.ui-pulse-line {
  flex: 1; height: 3px; border-radius: var(--r-full); overflow: hidden;
  background: color-mix(in srgb, var(--tc) 18%, transparent); position: relative;
}
.ui-pulse-line.streaming::after {
  content: ""; position: absolute; inset: 0; width: 40%;
  background: linear-gradient(90deg, transparent, var(--tc), transparent);
  animation: ui-flow 2.2s linear infinite;
}
@keyframes ui-flow { from { transform: translateX(-100%); } to { transform: translateX(350%); } }
.ui-pulse-meta { font-size: 11px; color: var(--text-3); flex-shrink: 0; }
.ui-pulse-chev {
  width: 8px; height: 8px; flex-shrink: 0;
  border-right: 2px solid var(--text-3); border-bottom: 2px solid var(--text-3);
  transform: rotate(-45deg); transition: transform 0.2s;
}
.ui-pulse-head.open .ui-pulse-chev { transform: rotate(45deg); }
.ui-pulse-body { border-top: 1px solid var(--line); padding: 10px 12px; }
</style>
