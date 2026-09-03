<!-- QueueDock.vue —— next-turn 排队 dock（composer 上方；DSH QueueDock 姿势）
  纯展示组件：队列数据/插话/删除动作由父级（DialogView 持 useQueuedMessages
  单一事实源）经 props 注入。展示规则（DSH 对齐）：队空隐藏；单条直渲染该
  行；两条及以上默认收起为「n 条排队消息」表头，点击展开完整列表（180px
  上限滚动；队列清空后下次出现恢复收起）。
  行 = 单行预览 + 立即发送（插话，仅运行中可用——转移到活跃 run 下一步）
  + 删除。输入框没有插话按钮，"着急立即发送"的唯一点击位在这里（DSH 同款）。 -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { Icon } from '../../ui';
import type { QueuedMessage } from '../../composables/useQueuedMessages';

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
  <div v-if="items.length > 0" class="queue-dock">
    <!-- 表头：多条时折叠态入口（单条直渲染行，无表头） -->
    <button
      v-if="items.length > 1"
      type="button"
      class="queue-header"
      :aria-expanded="expanded"
      aria-controls="queue-dock-list"
      @click="expanded = !expanded"
    >
      <Icon name="clock" :size="13" class="queue-header-icon" />
      <span>{{ items.length }} 条排队消息</span>
      <Icon name="chevron-down" :size="13" class="queue-chevron" :class="{ open: expanded }" />
    </button>

    <div
      v-if="items.length === 1 || expanded"
      id="queue-dock-list"
      class="queue-list"
      :class="{ single: items.length === 1 }"
    >
      <div v-for="q in items" :key="q.id" class="queue-row">
        <span class="queue-preview" :title="q.preview">{{ q.preview || '（空消息）' }}</span>
        <span class="queue-actions">
          <button
            type="button"
            class="queue-act steer"
            :disabled="!busy"
            :title="busy ? '立即发送：插入当前运行（下一步生效）' : '仅运行中可立即发送'"
            @click="onSteer(q)"
          >
            <Icon name="zap" :size="13" />
          </button>
          <button
            type="button"
            class="queue-act"
            title="删除排队消息"
            @click="onRemove(q.id)"
          >
            <Icon name="x" :size="13" />
          </button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.queue-dock {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  margin: 0 10px;
  border: 1px solid var(--color-border-secondary);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle, var(--color-bg-page));
  overflow: hidden;
}

.queue-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  background: none;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.queue-header:hover { background: var(--color-bg-hover, rgba(0,0,0,.04)); color: var(--color-text-primary); }
.queue-header-icon { color: var(--color-text-tertiary, #a8abb2); }
.queue-chevron { margin-left: auto; color: var(--color-text-tertiary, #a8abb2); transition: transform .15s ease; }
.queue-chevron.open { transform: rotate(180deg); }

.queue-list {
  display: flex;
  flex-direction: column;
  max-height: 180px;
  overflow-y: auto;
}

.queue-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  font-size: 12px;
  border-top: 1px solid var(--color-border-secondary);
}

.queue-list.single .queue-row { border-top: 0; }

.queue-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
}

.queue-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.queue-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-tertiary, #a8abb2);
  cursor: pointer;
}

.queue-act:hover:not(:disabled) { background: var(--color-bg-hover, rgba(0,0,0,.06)); color: var(--color-text-primary); }
.queue-act:disabled { opacity: .4; cursor: not-allowed; }

/* 立即发送（插话）：运行中着警示色——"着急"的主操作位（原输入框按钮移此） */
.queue-act.steer:not(:disabled) { color: var(--color-warning, #e67e22); }
.queue-act.steer:not(:disabled):hover {
  background: color-mix(in srgb, var(--color-warning, #e67e22) 12%, transparent);
  color: var(--color-warning, #e67e22);
}
</style>
