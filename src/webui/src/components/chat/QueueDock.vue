<!-- QueueDock.vue —— next-turn 排队 dock（composer 上方；DSH QueueDock 姿势）
  纯展示组件：队列数据/插话/删除动作由父级（DialogView 持 useQueuedMessages
  单一事实源）经 props 注入。展示规则（DSH 对齐）：队空隐藏；单条直渲染该
  行；两条及以上默认收起为表头（标题 + 计数摘要），点击展开完整列表
  （180px 上限滚动；队列清空后下次出现恢复收起）。
  外壳与密度对齐 dock 卡族规范（TodoPanel/GoalBar/InteractionBar）：
  radius-lg 扁平卡 · bg-secondary · margin 0 10px 6px（6px 下距 = dock 列
  纵向节奏）· 12px 横向内距 · 表头 = 14px lead + 13px/500 标题 + 12px
  计数摘要 + 14px chevron（TodoPanel header 同构）· 列表 gap 分隔无分割
  线（TodoPanel list 同构）· 13px 行文 · 22px 图标钮。
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
    <div class="queue-body">
      <!-- 表头（TodoPanel header 同构）：lead + 标题 + 计数摘要 + chevron；
           单条直渲染行，无表头 -->
      <button
        v-if="items.length > 1"
        type="button"
        class="queue-header"
        :aria-expanded="expanded"
        aria-controls="queue-dock-list"
        @click="expanded = !expanded"
      >
        <span class="queue-lead" aria-hidden="true"><Icon name="clock" :size="14" /></span>
        <span class="queue-title">排队消息</span>
        <span class="queue-count">{{ items.length }} 条</span>
        <span class="queue-chevron" :class="{ open: expanded }" aria-hidden="true">
          <Icon name="chevron-down" :size="14" />
        </span>
      </button>

      <div
        v-if="items.length === 1 || expanded"
        id="queue-dock-list"
        class="queue-list"
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
  </div>
</template>

<style scoped>
/* ── 外壳（dock 卡族规范：radius-lg 扁平卡 · bg-secondary · 无阴影；
      6px 下距 = dock 列纵向节奏，TaskDock/InteractionBar 同款） ── */
.queue-dock {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  margin: 0 10px 6px;
  border: 1px solid var(--color-border-secondary);
  border-radius: var(--radius-lg);
  background: var(--color-bg-secondary, var(--color-bg-page));
  overflow: hidden;
}

.queue-body { display: flex; flex-direction: column; gap: 6px; padding: 6px 12px; }

/* ── 表头（TodoPanel header 同构：flush 按钮 · gap 10 · 13px/500 标题
      + 12px 计数摘要 · 14px lead/chevron） ── */
.queue-header {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  cursor: pointer;
}
.queue-lead { display: grid; place-items: center; color: var(--color-text-tertiary); flex: none; }
.queue-title { color: var(--color-text-primary); font-size: 13px; font-weight: 500; line-height: 24px; flex: none; }
.queue-count {
  min-width: 0;
  flex: auto;
  color: var(--color-text-tertiary);
  font-size: 12px;
  line-height: 20px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.queue-chevron { display: grid; place-items: center; color: var(--color-text-tertiary); flex: none; transition: transform 0.2s ease; }
.queue-chevron.open { transform: rotate(180deg); }

/* ── 列表（TodoPanel list 同构：gap 分隔无分割线 · 180px 上限滚动） ── */
.queue-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 180px;
  padding: 0 0 4px;
  overflow-y: auto;
}
.queue-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--color-text-secondary);
}
.queue-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 行级动作（22px 图标钮 · radius-sm · dur-fast——InteractionBar 同款） ── */
.queue-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.queue-act {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.queue-act:hover:not(:disabled) { background: var(--color-bg-hover, rgba(0,0,0,.06)); color: var(--color-text-primary); }
.queue-act:disabled { opacity: 0.4; cursor: not-allowed; }

/* 立即发送（插话）：运行中着警示色——"着急"的主操作位（原输入框按钮移此） */
.queue-act.steer:not(:disabled) { color: var(--color-warning, #e67e22); }
.queue-act.steer:not(:disabled):hover {
  background: color-mix(in srgb, var(--color-warning, #e67e22) 12%, transparent);
  color: var(--color-warning, #e67e22);
}
</style>
