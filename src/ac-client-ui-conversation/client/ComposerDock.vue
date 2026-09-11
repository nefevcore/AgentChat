<!-- ComposerDock.vue —— composer 上方 dock 列席位宿主（DSH input dock 姿势）
  原名 TaskDock（M27 S3 首版——当时列内是 todo/goal 任务卡）；M28 P1 起
  dock 卡全部为域行贡献（todo 10 / goal 20 / queue 30 / interaction 40），
  「Task」词根失准——会话区重构随核更名 ComposerDock（位置语义：composer
  上方；不预设列内容）。席位 conversation:dock-widget（M30 D5 改名——
  第一段 = 宿主件域）list 席，本组件为纯席位宿主（owner props 透传
  agentId/conversationId，D16-③）。零包裹纪律（D23-A）：无容器 div，
  dock 卡纵向节奏（6px 底距）由各卡自带。 -->
<script setup lang="ts">
import SlotOutlet from 'ac-client-ui-renderer/client/SlotOutlet.vue';

const props = defineProps<{
  /** 桶归属 Agent（直答 = 激活 Agent；独立会话 = 会话登记 Agent） */
  agentId: string | null | undefined;
  /** 会话桶键（直答 = pairKey(viewer, agent)；独立会话 = sid） */
  conversationId: string | null | undefined;
}>();
</script>

<template>
  <SlotOutlet name="conversation:dock-widget" :data="{ agentId: props.agentId, conversationId: props.conversationId }" />
</template>
