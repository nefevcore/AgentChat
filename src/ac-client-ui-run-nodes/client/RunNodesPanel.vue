<!-- RunNodesPanel.vue —— 会话 run 骨架面板（cr-230）
  结构对齐 RunTrackingPanel 的树面板形态：标题栏（toolbar-label 同款）+
  滚动区（tree-scroll 同款）。节点行 = 正序时间线（旧→新，与消息流同构），
  两行主从（pool-entry 配方：主行摘要 + 从行时间/状态——侧栏高度充裕不挤
  一行）。行底座 = .ui-row（hover 亮底）；运行态 = 从行呼吸点 + 文字双通道
  （行首不做状态位——干净）；时间 = kit formatRelativeTime；点击 = reveal
  意图（主区定位该消息居中）。计数徽章 = .ui-badge info。 -->
<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { StatusDot, formatRelativeTime } from '@agentchat/webui-kit';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { useFeedStore } from 'ac-client-ui-conversation/client/feedStore.ts';
import type { DialogId } from 'ac-client-ui-conversation/client/feed.ts';
import { runNodesOf } from './runNodes.ts';

const ui = useUiStore();
const feed = useFeedStore();

// 活跃分区的 turns → 节点（旧→新正序——run 骨架与消息流同构读作时间线）
const nodes = computed(() => {
  const id = feed.activeDialogId as DialogId | null;
  if (!id) return [];
  return [...runNodesOf(feed.getTurns(id).value)].reverse();
});

// 正序时间线：新节点（运行中）在底部——自动滚到底跟随（聊天流同款语义：
// 用户上翻时不打扰，新 run 到来时贴底跟随）。切会话归零重贴底。
const bodyRef = ref<HTMLElement | null>(null);
watch(() => [nodes.value.length, feed.activeDialogId], async () => {
  await nextTick();
  const el = bodyRef.value;
  if (!el) return;
  // 距底 < 40px 视为贴底态（跟随）；上翻阅读历史节点时不打断
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) el.scrollTop = el.scrollHeight;
});

function onClickNode(id: string) {
  // 当前分区节点：直接 reveal（会话切换零开销路径）。宽屏不动 aux 区
  //（主区与右栏并存——收右栏会让布局跳变）；窄屏 aux 是全屏 Sheet，收掉
  // + push 主区，定位结果才可见
  const dialogId = feed.activeDialogId as DialogId | null;
  if (!dialogId) return;
  ui.sendRevealIntent(dialogId, id);
  if (ui.narrow) {
    ui.closeAux();
    ui.pushMainIfNarrow();
  }
}
</script>

<template>
  <div class="rnp-panel">
    <div class="rnp-toolbar">
      <span class="toolbar-label">会话节点</span>
      <span v-if="nodes.length > 0" class="ui-badge info rnp-badge">{{ nodes.length }}</span>
    </div>
    <div ref="bodyRef" class="rnp-scroll">
      <div v-if="nodes.length === 0" class="rnp-empty">当前会话暂无消息</div>
      <button
        v-for="n in nodes"
        :key="n.id"
        class="ui-row rnp-row"
        :title="`${formatRelativeTime(n.ts)} · ${n.text || '（无文字内容）'}`"
        @click="onClickNode(n.id)"
      >
        <span class="rnp-info">
          <span class="rnp-text">{{ n.text || '（无文字内容）' }}</span>
          <span class="rnp-meta">
            {{ formatRelativeTime(n.ts) }}
            <template v-if="n.running">· <StatusDot status="running" :size="6" /> 运行中</template>
          </span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 面板骨架（标题栏 + 滚动区）：底色归宿主 aux 容器（aux 选区惯例——面板
   自身透明，不叠表面底/基底层） */
.rnp-panel { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }

/* 标题栏（RunTrackingPanel panel-toolbar 同款） */
.rnp-toolbar { display: flex; align-items: center; gap: 6px; padding: 10px 14px 6px; flex-shrink: 0; }
.toolbar-label { font-size: 12px; font-weight: 600; letter-spacing: 0.5px; color: var(--text-3); user-select: none; }
.rnp-badge { flex-shrink: 0; font-variant-numeric: tabular-nums; }

/* 滚动区（隐藏滚动条——tree-scroll 同款）；行距由 flex gap 承担
   （.ui-row 无 margin——清单行间距归容器） */
.rnp-scroll {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: var(--space-1);
  display: flex; flex-direction: column; gap: 2px;
  scrollbar-width: none; scrollbar-color: transparent transparent;
}
.rnp-scroll::-webkit-scrollbar { width: 0; height: 0; }

/* 节点行：两行主从（pool-entry 配方——侧栏高度充裕，摘要与元信息分行）。
   盒模型/padding/圆角/hover 亮底全归 .ui-row（row.css 头注：scoped 只留
   专属修饰）——本地只声明按钮语义、列间距与主从列。 */
.rnp-row {
  gap: 10px;
  width: 100%; text-align: left;
  cursor: pointer; user-select: none;
}

/* 主从列（pool-entry-info 同款：column + 2px 行距） */
.rnp-info { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }

/* 主行 = 摘要（pool-entry-name 档：fs-sm 500 text-1） */
.rnp-text {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--fs-sm); font-weight: 500; line-height: 20px; color: var(--text-1);
}

/* 从行 = 元信息（pool-entry-detail 档：fs-xs text-3；运行中附呼吸点 +
   文字双通道——状态色铁律 cr-140） */
.rnp-meta {
  display: flex; align-items: center; gap: 4px;
  font-size: var(--fs-2xs); color: var(--text-3);
  font-variant-numeric: tabular-nums; line-height: 16px;
}

.rnp-empty { padding: 24px 14px; font-size: var(--fs-sm); color: var(--text-3); text-align: center; }
</style>
