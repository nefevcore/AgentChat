<!--
  ui/StatusDot.vue —— 状态灯（工坊语言）
  status: thinking（琥珀·呼吸）/ running（靛蓝·呼吸）/ idle / ok（绿）/ err（红）/ offline（灰）
  原则：状态必须文字+颜色双重表达（红绿色盲友好），本组件仅视觉点。
-->
<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  status: 'thinking' | 'running' | 'idle' | 'offline' | 'ok' | 'err';
  /** 强制呼吸动画（默认 thinking/running 自动呼吸） */
  pulse?: boolean;
  size?: number;
}>(), { pulse: false, size: 8 });

const color = computed(() => {
  switch (props.status) {
    case 'thinking': return 'var(--warn)';
    case 'running': return 'var(--primary)';
    case 'idle':
    case 'ok': return 'var(--ok)';
    case 'offline': return 'var(--text-3)';
    case 'err': return 'var(--err)';
  }
});
const pulsing = computed(() => props.pulse || props.status === 'thinking' || props.status === 'running');
</script>

<template>
  <span
    class="ui-dot"
    :class="{ pulsing }"
    :style="{ width: size + 'px', height: size + 'px', background: color, boxShadow: `0 0 8px ${color}` }"
  />
</template>

<style scoped>
.ui-dot { border-radius: var(--r-full); flex-shrink: 0; display: inline-block; }
.ui-dot.pulsing { animation: ui-breathe 1.4s ease-in-out infinite; }
@keyframes ui-breathe {
  0%, 100% { opacity: 0.45; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.08); }
}
</style>
