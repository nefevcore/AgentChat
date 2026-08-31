<!--
  ui/StarAvatar.vue —— 扁平头像（中性化；保留身份色首字底色，无光晕/呼吸）
  用法：<StarAvatar :src="avatar" :name="name" :color="idColor" fallback-icon="bot" />

  running=true 时在头像外圈显示「不断流转的有色线条」光环（Agent 正在回复）：
    · 底环 —— 身份色低透明度，安静提示占用状态
    · 主流光 —— 身份色渐隐尾巴的圆弧，绕圈匀速旋转
    · 副流光 —— 主题强调色短弧，不同转速错相流转，形成层次
  实现为 SVG stroke（dasharray 截弧 + transform 旋转），无 @property 依赖；
  运动为功能语义（不可静止降级），已在 main.css 全局 reduce 规则中豁免。
-->
<script lang="ts">
/** 渐变 id 种子：模块级递增（<script setup> 每实例执行，放那里会重复） */
let gidSeed = 0;
</script>

<script setup lang="ts">
import { computed } from 'vue';
import Avatar from './Avatar.vue';

const props = withDefaults(defineProps<{
  src?: string | null;
  name?: string;
  /** 身份色（hex/CSS 色），用于无图时首字底色 */
  color?: string;
  size?: number;
  /** 无图回退图标（透传 Avatar；小尺寸下替代首字更清晰） */
  fallbackIcon?: string;
  /** 运行中：头像边框生成不断流转的有色线条（该 Agent 正在回复）。
   *  仅用于 direct / single 会话（有可靠的 per-dialog 流式信号）；
   *  群聊不适用——是否发言由 Agent 自行调用 send_group 决定，无法预判运行态。 */
  running?: boolean;
}>(), { size: 32, running: false });

/** 光环线宽随头像尺寸缩放（15px 列表小头像用细环，避免糊成一团） */
const ringWidth = computed(() => (props.size <= 18 ? 1.5 : props.size <= 28 ? 2 : 2.5));
/** 光环外径（SVG 视口尺寸，含两侧溢出） */
const ringSize = computed(() => props.size + ringWidth.value * 2);

// SVG viewBox 100×100 内的圆参数：r=46 + stroke-width 7 → 外缘 49.5，不裁边
const R = 46;
const CIRC = 2 * Math.PI * R;
/** 主流光弧长（约 38% 周长；剩余用整周长补齐 dash 空隙） */
const mainDash = `${(CIRC * 0.38).toFixed(1)} ${CIRC.toFixed(1)}`;
/** 副流光弧长（约 16% 周长，短促点缀） */
const subDash = `${(CIRC * 0.16).toFixed(1)} ${CIRC.toFixed(1)}`;

/** 渐变 id 需全局唯一（同页多个 running 头像并存） */
const gradId = `star-run-grad-${++gidSeed}`;
</script>

<template>
  <span class="ui-star" :class="{ running }" :style="color ? { '--sc': color } : undefined">
    <!-- 运行光环：absolute 外溢，不占布局；仅环体有颜色，不遮头像内容 -->
    <svg v-if="running" class="run-ring" :width="ringSize" :height="ringSize" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <!-- 主流光渐变：亮头 → 渐隐尾（userSpaceOnUse：随旋转组一起转动，尾巴始终贴弧） -->
        <linearGradient :id="gradId" gradientUnits="userSpaceOnUse" x1="96" y1="50" x2="6" y2="58">
          <stop offset="0" class="run-grad-head" />
          <stop offset="0.55" class="run-grad-mid" />
          <stop offset="1" class="run-grad-tail" />
        </linearGradient>
      </defs>
      <!-- 底环：身份色低透明 -->
      <circle cx="50" cy="50" :r="R" fill="none" class="run-track" stroke-width="7" />
      <!-- 主流光：渐隐尾巴长弧，顺时针流转 -->
      <g class="run-spin">
        <circle cx="50" cy="50" :r="R" fill="none" :stroke="`url(#${gradId})`" stroke-width="7"
          stroke-linecap="round" :stroke-dasharray="mainDash" />
      </g>
      <!-- 副流光：主题强调色短弧，慢速错相流转 -->
      <g class="run-spin run-spin--sub">
        <circle cx="50" cy="50" :r="R" fill="none" class="run-sub" stroke-width="7"
          stroke-linecap="round" :stroke-dasharray="subDash" />
      </g>
    </svg>
    <Avatar :src="src" :name="name" :size="size" :fallback-icon="fallbackIcon" />
  </span>
</template>

<style scoped>
.ui-star { display: inline-flex; border-radius: var(--r-full); position: relative; flex-shrink: 0; vertical-align: middle; }
.ui-star :deep(.ui-avatar-fallback) {
  background: color-mix(in srgb, var(--sc, var(--primary)) 14%, transparent);
  color: var(--sc, var(--primary));
}

/* ── 运行光环 ── */
.run-ring {
  position: absolute;
  left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  overflow: visible;
}
/* 底环：身份色（回退主题主色）低透明 */
.run-track { stroke: var(--sc, var(--primary)); opacity: 0.16; }
/* 主流光渐变 stops：亮头（主题主色提亮身份色）→ 身份色 → 渐隐尾 */
.run-grad-head { stop-color: var(--color-primary, var(--primary)); }
.run-grad-mid { stop-color: var(--sc, var(--primary)); }
.run-grad-tail { stop-color: var(--sc, var(--primary)); stop-opacity: 0; }
/* 副流光：主题强调色短弧 */
.run-sub { stroke: var(--accent, #f472b6); opacity: 0.85; }
/* 旋转：transform-box 对齐 viewBox，绕圆心匀速流转 */
.run-spin {
  transform-box: view-box;
  transform-origin: center;
  animation: star-run-spin 1.15s linear infinite;
}
.run-spin--sub { animation-duration: 1.9s; animation-delay: -0.6s; }
@keyframes star-run-spin { to { transform: rotate(360deg); } }

/* 减少动态偏好下不做静止降级：光环是功能性状态指示（「正在回复」），
 * 运动即语义；main.css 全局 reduce 规则已用 *:not(.run-spin) 豁免本组件
 * （@layer base 内的 !important 会压过组件内任何 important 豁免，
 * 必须在源头排除）。 */
</style>
