<!-- TaskDock.vue —— 任务追踪 dock 列席位宿主（composer 上方；DSH input dock 姿势）
  M27 S3：dock 卡列 = tracking:dock-widget list seat（slot-tree
  chat:composer-docks/tracking:dock-widget 收编首例）。M28 P1 起 dock
  卡全部为域行贡献：todo 卡 = ac-client-ui-todo（order 10）、goal 条 =
  ac-client-ui-goal（order 20）——DSH dock 序 Todo → Goal；本组件退化为
  纯席位宿主（owner props 透传 agentId/conversationId，D16-③）。零包裹
  纪律（D23-A）：无容器 div，dock 卡纵向节奏（6px 底距）由各卡自带。 -->
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
  <SlotOutlet name="tracking:dock-widget" :data="{ agentId: props.agentId, conversationId: props.conversationId }" />
</template>
