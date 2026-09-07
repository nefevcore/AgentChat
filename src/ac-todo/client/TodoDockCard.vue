<!-- TodoDockCard.vue —— todo 域 dock 卡（tracking:dock-widget 贡献）
  会话级任务清单面板：数据自理（域投影归域插件——M27 §0.3 层 3）。
  刷新时机全事件化（对齐 slot-tree dock 契约的 tool/after-execute ·
  loop/after-run 模式）：
    · 会话上下文切换（agentId/conversationId watch，immediate）
    · tool/after-execute 帧（name=todo 且 conversationId 命中本桶）
    · loop/after-run 帧（同桶收束兜底——后台过滤抑制的帧之后仍能对齐）
  三态契约：undefined = 服务不可用（行摘除/RPC 失败）静默；null|[] = 无
  清单不渲染。RPC 与事件帧均经 ctx（useContext fork 本行插件 fiber——
  D17：组件卸载即订阅回收；rpc 依赖由行 client 插件 inject 声明）。 -->
<script setup lang="ts">
import { ref, watch, onUnmounted, toRef } from 'vue';
import { useContext } from 'ac-client-runtime';
import TodoPanel from './TodoPanel.vue';
import { fetchTodos, type TaskTodo } from './tasks.ts';

const props = defineProps<{
  /** 席位 owner 上下文透传（D16-③：TaskDock 经 SlotOutlet data 传入） */
  data: { agentId?: string | null; conversationId?: string | null };
}>();

const agentId = toRef(() => props.data.agentId);
const conversationId = toRef(() => props.data.conversationId);

const todos = ref<TaskTodo[] | undefined>(undefined);

const ctx = useContext();
const rpc = ctx.rpc;

async function refresh(): Promise<void> {
  const a = agentId.value;
  const c = conversationId.value;
  if (!a || !c) {
    todos.value = undefined;
    return;
  }
  const t = await fetchTodos(rpc, a, c);
  // 拉取期间会话已切换 → 丢弃过期结果（防串台）
  if (agentId.value !== a || conversationId.value !== c) return;
  todos.value = t === undefined || t === null ? undefined : t;
}

watch([agentId, conversationId], () => void refresh(), { immediate: true });

const off = rpc.onEvent((type, args) => {
  const c = conversationId.value;
  if (!c) return;
  if (type === 'tool/after-execute') {
    const [call] = args as Array<{ name?: string; conversationId?: string } | undefined>;
    if (call?.name === 'todo' && call?.conversationId === c) void refresh();
    return;
  }
  if (type === 'loop/after-run') {
    const [request] = args as Array<{ conversationId?: string } | undefined>;
    if (request?.conversationId === c) void refresh();
  }
});
onUnmounted(() => off());
</script>

<template>
  <TodoPanel v-if="todos !== undefined" :todos="todos" />
</template>
