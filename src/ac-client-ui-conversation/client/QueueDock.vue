<!-- QueueDock.vue —— next-turn 排队 dock（composer 上方；DSH QueueDock 姿势）
  纯展示组件：队列数据/插话/删除动作由父级（QueueDockHost 持 useQueuedMessages
  单一事实源）经 props 注入。展示规则（DSH 对齐）：队空隐藏；单条直渲染该行
  （无头卡——行首 lead 图标为卡族锚点）；两条及以上 = 可折叠卡（eyebrow 类别
  + 条数 title，header 整体可点展开，cr-186 同 TodoPanel），展开完整列表
  （180px 上限滚动；队列清空后下次出现恢复收起）。
  cr-186：外壳终迁 kit DockCard（原自建壳/表头退役——dock 卡族六卡同壳）。
  行 = 单行预览 + 立即发送（插话，仅运行中可用——转移到活跃 run 下一步）
  + 删除。输入框没有插话按钮，"着急立即发送"的唯一点击位在这里（DSH 同款）。 -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { DockCard, Icon, Tooltip } from '@agentchat/webui-kit';
import type { QueuedMessage } from './useQueuedMessages.ts';

const props = defineProps<{
  /** 排队条目（顺序 = 投递顺序；父级权威快照） */
  items: QueuedMessage[];
  /** 目标会话运行中（立即发送可用性——DSH：仅运行中可插话发送） */
  busy?: boolean;
  /** 行级立即发送（插话：转移到活跃 run 下一步；收敛竞态由父级按 DSH 不报失败） */
  onSteer: (item: QueuedMessage) => void;
  /** 行级删除 */
  onRemove: (id: string) => void;
}>();

const expanded = ref(false);
// 队列清空 → 恢复默认收起（DSH：下一次出现队列时回到收起态）
watch(() => props.items.length, (n) => { if (n === 0) expanded.value = false; });
</script>

<template>
  <!-- 多条 = 可折叠卡（header 整体可点）；单条 = 无头卡（行首 lead 图标锚点） -->
  <DockCard
    v-if="items.length > 0"
    class="queue-dock"
    :icon="items.length > 1 ? 'clock' : ''"
    :eyebrow="items.length > 1 ? '排队消息' : ''"
    :title="items.length > 1 ? `${items.length} 条` : ''"
    :collapsible="items.length > 1"
    :open="items.length === 1 || expanded"
    @toggle="(o) => (expanded = o)"
  >
    <div class="queue-list" :class="{ multi: items.length > 1 }">
      <div v-for="q in items" :key="q.id" class="queue-row">
        <!-- 单条形态无表头：行首补 lead 图标对齐 dock 卡族锚点（多条时表头已带） -->
        <span v-if="items.length === 1" class="queue-lead" aria-hidden="true"><Icon name="clock" :size="14" /></span>
        <span class="queue-preview" :title="q.preview">{{ q.preview || '（空消息）' }}</span>
        <span class="queue-actions">
          <Tooltip :text="busy ? '立即发送：插入当前运行（下一步生效）' : '仅运行中可立即发送'" placement="top">
            <button
              type="button"
              class="queue-act steer"
              :disabled="!busy"
              :aria-label="busy ? '立即发送：插入当前运行（下一步生效）' : '仅运行中可立即发送'"
              @click="onSteer(q)"
            >
              <Icon name="zap" :size="13" />
            </button>
          </Tooltip>
          <Tooltip text="删除排队消息" placement="top">
            <button
              type="button"
              class="queue-act"
              aria-label="删除排队消息"
              @click="onRemove(q.id)"
            >
              <Icon name="x" :size="13" />
            </button>
          </Tooltip>
        </span>
      </div>
    </div>
  </DockCard>
</template>

<style scoped>
/* cr-186：壳/表头归 kit DockCard（本行只留列表与行内动作编排） */
.queue-dock { flex-shrink: 0; }

/* 列表（TodoPanel list 同构：gap 分隔无分割线 · 180px 上限滚动）。
   尾部 4px 呼吸位仅在多条展开（可能滚动）形态给——单条直渲染时卡内
   上下对称、内容垂直居中（2026-09-12 反馈）。 */
.queue-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 180px;
  overflow-y: auto;
}
.queue-list.multi { padding: 0 0 4px; }
.queue-lead { display: grid; place-items: center; color: var(--text-3); flex: none; }
.queue-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--text-2);
}
.queue-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 行级动作（22px 图标钮 · radius-sm · dur-fast——InteractionBar 同款） */
.queue-actions { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
.queue-act {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.queue-act:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-1); }
.queue-act:disabled { opacity: 0.4; cursor: not-allowed; }

/* 立即发送（插话）：运行中着警示色——"着急"的主操作位（原输入框按钮移此） */
.queue-act.steer:not(:disabled) { color: var(--warn); }
.queue-act.steer:not(:disabled):hover {
  background: rgba(var(--warn-rgb), 0.12);
  color: var(--warn);
}
</style>
