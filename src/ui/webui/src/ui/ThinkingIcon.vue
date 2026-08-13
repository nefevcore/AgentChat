<script setup lang="ts">
// ============================================================
// ui/ThinkingIcon.vue —— AgentChat 专属「思维链」图标
//
// 设计：脑电波式波浪折线 + 节点链（避开对称 V 形的"箭头"观感）：
//       · 波浪折线 = 思维活动 / 思考过程（脑电波隐喻）
//       · 4 个节点从左到右由浅到实 = 思考逐步深化
//       · 节点呼应 Logo 的"节点连线"品牌基因
// 颜色继承 currentColor，融入思维链 label 的次要文字配色。
// ============================================================

withDefaults(defineProps<{ size?: number }>(), { size: 14 });
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <!-- 脑电波式折线（低-高-低-高） -->
    <path
      d="M4 14l5.5-7 4.5 7 6-7"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <!-- 节点：左→右由浅到实，表示思考逐步深化 -->
    <circle cx="4" cy="14" r="2.2" fill="currentColor" opacity="0.35" />
    <circle cx="9.5" cy="7" r="2.2" fill="currentColor" opacity="0.55" />
    <circle cx="14" cy="14" r="2.2" fill="currentColor" opacity="0.75" />
    <circle cx="20" cy="7" r="2.2" fill="currentColor" />
  </svg>
</template>
