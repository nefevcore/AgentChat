<!-- ============================================================
  webui-kit/src/base/DockCard.vue —— composer 上方 dock 外壳（cr-121 新原语）
  归一 5 处同 recipe 副本：ApprovalBar / InteractionBar / QueueDock /
  GoalDockCard / TodoDockCard（业务行只供内容与动作，壳不再各写一份）。

  设计要点：
  - 浮层分层：--shadow-dock（轻 composer 一档）+ --elev-hairline（暗色下
    暗影不可见，用 1px 顶缘高光分层）；
  - 手势条避让：底缘 margin 吃 --safe-bottom（移动端 dock 常是最底部浮层）；
  - 忙态双通道：BusyRing 表达「忙」，正文区在 tone=busy 时挂 role=status
    ——状态文案变化会播报，而颜色/转圈本身读屏读不到；
  - 动作按钮走 kit Button / ui-badge，焦点环由 L0 全局规则给，壳不另画。
  ============================================================ -->
<script setup lang="ts">
import BusyRing from './BusyRing.vue';

withDefaults(defineProps<{
  /** 小字眉标（如「提权审批」「排队消息」） */
  eyebrow?: string;
  /** 主标题（一行，超出省略） */
  title?: string;
  /** 语义：idle 常态 / busy 执行中 / warn 待确认 / error 失败 */
  tone?: 'idle' | 'busy' | 'warn' | 'error';
  /** 紧凑档（单行 dock：摘要类） */
  dense?: boolean;
}>(), { eyebrow: '', title: '', tone: 'idle', dense: false });
</script>

<template>
  <section
    class="dock"
    :class="[`tone-${tone}`, { min: dense }]"
    :aria-busy="tone === 'busy' || undefined"
  >
    <header class="dock-head">
      <span v-if="eyebrow" class="dock-eyebrow">{{ eyebrow }}</span>
      <BusyRing v-if="tone === 'busy'" :size="13" />
      <span class="dock-title">{{ title }}</span>
      <div v-if="$slots.actions" class="dock-actions"><slot name="actions" /></div>
    </header>
    <div v-if="$slots.default" class="dock-body" :role="tone === 'busy' ? 'status' : undefined">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.dock {
  margin: 0 10px calc(6px + var(--safe-bottom));
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--bg-raised);
  box-shadow: var(--shadow-dock), var(--elev-hairline);
  font-size: var(--fs-md);
  color: var(--text-1);
}
.dock.min { padding: 6px 12px; }
.dock.tone-warn { border-color: rgba(var(--warn-rgb), 0.45); }
.dock.tone-error { border-color: rgba(var(--err-rgb), 0.45); }

.dock-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.dock.min .dock-head { margin-bottom: 0; }
.dock-eyebrow {
  font-size: var(--fs-2xs); font-weight: 600; color: var(--text-3);
  letter-spacing: 0.4px; text-transform: uppercase; flex-shrink: 0;
}
.dock-title {
  font-size: var(--fs-md); font-weight: 600; color: var(--text-1);
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dock-actions { display: flex; gap: 6px; flex-shrink: 0; }
.dock-body { min-width: 0; }
</style>
