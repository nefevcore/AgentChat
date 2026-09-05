<!-- ============================================================
     ui/RingProgress.vue —— 环形进度条（SVG 圆环）
     进度弧自 12 点方向顺时针增长；中心内容经默认插槽注入（如百分比文字）。
     颜色 tone 复用 Token 仪表盘语义色（low/moderate/high/critical），
     空值 = 主题主色。
     ============================================================ -->

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  /** 进度值 0–100（越界自动钳制） */
  value: number;
  /** 圆环外尺寸（px） */
  size?: number;
  /** 描边宽度（px） */
  stroke?: number;
  /** 语义色：low 绿 / moderate 黄 / high 橙 / critical 红；空 = 主题主色 */
  tone?: '' | 'low' | 'moderate' | 'high' | 'critical';
}>(), { size: 28, stroke: 3, tone: '' });

const clamped = computed(() => Math.max(0, Math.min(100, props.value || 0)));
const radius = computed(() => Math.max(0.5, (props.size - props.stroke) / 2));
const circumference = computed(() => 2 * Math.PI * radius.value);
/** 弧长按周长比例取值（stroke-dashoffset 增大 = 可见弧变短） */
const dashOffset = computed(() => circumference.value * (1 - clamped.value / 100));
</script>

<template>
  <span
    class="ring-progress"
    :class="tone ? `tone-${tone}` : ''"
    :style="{ width: size + 'px', height: size + 'px' }"
    role="progressbar"
    :aria-valuenow="Math.round(clamped)"
    aria-valuemin="0"
    aria-valuemax="100"
  >
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" aria-hidden="true">
      <!-- 底轨（剩余量） -->
      <circle class="ring-track" :cx="size / 2" :cy="size / 2" :r="radius" fill="none" :stroke-width="stroke" />
      <!-- 进度弧（rotate -90° 从 12 点起画） -->
      <circle
        class="ring-fill"
        :cx="size / 2" :cy="size / 2" :r="radius" fill="none" :stroke-width="stroke"
        stroke-linecap="round"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="dashOffset"
      />
    </svg>
    <span class="ring-center"><slot /></span>
  </span>
</template>

<style scoped>
.ring-progress {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.ring-progress svg { display: block; transform: rotate(-90deg); }
.ring-track { stroke: var(--color-bg-hover, rgba(127, 127, 127, 0.18)); }
.ring-fill { stroke: var(--color-primary, #6366f1); transition: stroke-dashoffset 0.4s ease; }
.tone-low .ring-fill { stroke: #22c55e; }
.tone-moderate .ring-fill { stroke: #eab308; }
.tone-high .ring-fill { stroke: #f97316; }
.tone-critical .ring-fill { stroke: #ef4444; }
.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
  line-height: 1;
}
</style>
