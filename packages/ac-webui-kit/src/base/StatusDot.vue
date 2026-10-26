<!--
  webui-kit/src/base/StatusDot.vue —— 状态灯（工坊语言）
  status: thinking（琥珀·呼吸）/ running（靛蓝·呼吸）/ idle / ok（绿）/ err（红）/ offline（灰）
  原则：状态必须文字+颜色双重表达（红绿色盲友好），本组件仅视觉点。
  分工（cr-121）：本组件管「状态的色轴」（琥珀/靛蓝/绿/红/灰），形状轴的
  忙指示归 BusyRing——同一屏不重复渲染「忙」；发光（glow）已随扁平化退役，
  故不再画外晕（旧实现内联 box-shadow 0 0 8px 与 goto 令牌相反）。
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
    /* 色点是图形件（WCAG 1.4.11 · 3.0 线）——取状态档（cr-123） */
    case 'thinking': return 'var(--warn-status)';
    case 'running': return 'var(--primary)';
    case 'idle':
    case 'ok': return 'var(--ok-status)';
    case 'offline': return 'var(--text-3)';
    case 'err': return 'var(--err-status)';
  }
});
const pulsing = computed(() => props.pulse || props.status === 'thinking' || props.status === 'running');
</script>

<template>
  <span
    class="ui-dot"
    :class="{ pulsing }"
    :style="{ width: size + 'px', height: size + 'px', background: color }"
  />
</template>

<style scoped>
.ui-dot { border-radius: var(--r-full); flex-shrink: 0; display: inline-block; }
/* cr-161：呼吸的「存在」是功能语义（reduce 下冻结在半透明帧会被读作熄灭）——
   经 --motion-scale 收敛时长，但关键帧锚定满强度帧（0% 即静止呈满亮实点） */
.ui-dot.pulsing { animation: ui-breathe calc(1.4s * var(--motion-scale)) ease-in-out infinite; }
@keyframes ui-breathe {
  0%, 100% { opacity: 1; transform: scale(1.08); }
  50% { opacity: 0.5; transform: scale(0.9); }
}
</style>
