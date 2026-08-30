<script setup lang="ts">
// ============================================================
// ui/ThoughtIcon.vue —— 思考内容 label 专属图标（区别于思维链折叠栏）
//
// 设计：涟漪波纹 —— 中心节点 + 两道扩散弧，表达"单个思考的展开/发散"。
//       · 中心实心点 = 思考焦点（延续 Logo 节点基因）
//       · 两道弧 = 思考向外扩散
//       · 与 ThinkingIcon（脑电波节点链 = 整体过程）形成呼应又区分：
//         链式 = 步骤串联；涟漪 = 单步展开
// 颜色继承 currentColor，融入思维链 label 的次要文字配色。
// ============================================================

withDefaults(defineProps<{ size?: number }>(), { size: 14 });
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <!-- 扩散弧（思考展开） -->
    <path
      d="M12 6.5a5.5 5.5 0 0 1 5.5 5.5"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
    />
    <path
      d="M12 17.5a5.5 5.5 0 0 1-5.5-5.5"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      opacity="0.55"
    />
    <!-- 中心节点（思考焦点） -->
    <circle cx="12" cy="12" r="2.2" fill="currentColor" />
  </svg>
</template>
