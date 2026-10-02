<!-- ============================================================
  webui-kit/src/base/BusyRing.vue —— 忙指示唯一源（形状轴，cr-121）
  归一 5 处副本：ToolMessage / AssistantMessage / TurnDisplayItem /
  ToolResultRunCode 各自的 spin-ring + main.css 全局 + toast 与
  FeedbackNotice 的 loader-circle 旋转。

  轴约定（与 StatusDot 分工，避免同一屏两种「忙」）：
  - 本组件 = 「忙 / 进行中」的形状语言（环形缺口旋转）；
  - 色轴恒主色靛蓝（cr-122 合并原 busy 琥珀/running 靛蓝两档——
    消费侧无规律支撑二分：同为「进行中」的归档反馈与命令执行各执一色，
    属意外分裂而非设计；且与 StarAvatar 运行光环同语言）。
  文本语义由宿主承担——故默认 aria-hidden（不进可达性树，避免与
  宿主文案重复播报）；独立等待位传 label 才以 role=status 播报。
  动效经 --motion-scale 归一（系统「减少动态效果」下静止）。
  ============================================================ -->
<script setup lang="ts">

const props = withDefaults(defineProps<{
  /** 外径 px（行内 13 / 独立等待位 18） */
  size?: number;
  /** 有独立语义时给可读标签（否则视作装饰） */
  label?: string;
}>(), { size: 13, label: '' });

</script>

<template>
  <span
    class="busy-ring"
    :style="{ width: size + 'px', height: size + 'px' }"
    :role="label ? 'status' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
  />
</template>

<style scoped>
.busy-ring {
  display: inline-block;
  flex-shrink: 0;
  /* CSS 侧兜底尺寸（组件用 :size 以内联样式覆盖）；无内联时也不塌成 0 */
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid rgba(var(--primary-rgb), 0.18);
  border-top-color: var(--primary);
  animation: busy-ring-spin calc(0.8s * var(--motion-scale)) linear infinite;
}
@keyframes busy-ring-spin { to { transform: rotate(360deg); } }
</style>
