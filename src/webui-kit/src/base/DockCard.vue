<!-- ============================================================
  webui-kit/src/base/DockCard.vue —— composer 上方 dock 外壳（cr-121 新原语）
  归一 dock 卡族同 recipe 副本：ApprovalBar / InteractionBar / QueueDock /
  GoalDockCard / TodoDockCard（cr-186：QueueDock 自建壳终迁入，六卡同壳）。

  设计要点：
  - 头部轻量（cr-186）：纯图标 lead + 不加粗文本——eyebrow = 类别/状态
    （text-3）、title = 内容主体（text-1），替代旧「大写粗眉标 + 粗标题」；
  - 可折叠（cr-186）：collapsible 时 header 整体是折叠开关（不再挤行尾
    小钮），aria 范式对齐 CollapseRow——真 button + aria-expanded/
    aria-controls、命中区 --hit-min，行尾自动 chevron；折叠态自动取
    紧凑档（dense 语义保留——不可折叠卡仍显式传）；
  - 浮层分层：--shadow-dock（轻 composer 一档）+ --elev-hairline（暗色下
    暗影不可见，用 1px 顶缘高光分层）；
  - 手势条避让：底缘 margin 吃 --safe-bottom（移动端 dock 常是最底部浮层）；
  - 忙态双通道：BusyRing 表达「忙」，正文区在 tone=busy 时挂 role=status
    ——状态文案变化会播报，而颜色/转圈本身读屏读不到；
  - 动作按钮走 kit Button / ui-badge，焦点环由 L0 全局规则给，壳不另画。
  ============================================================ -->
<script setup lang="ts">
import { computed } from 'vue';
import BusyRing from './BusyRing.vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  /** 类别/状态说明（如「任务」「决策请求 · Agent」） */
  eyebrow?: string;
  /** lead 图标名（icons.ts 注册表；busy 时让位 BusyRing） */
  icon?: string;
  /** 主标题（一行，超出省略） */
  title?: string;
  /** 语义：idle 常态 / busy 执行中 / warn 待确认 / error 失败 */
  tone?: 'idle' | 'busy' | 'warn' | 'error';
  /** 紧凑档（单行 dock：摘要类；collapsible 折叠态自动取，无需另传） */
  dense?: boolean;
  /** 可折叠：header 整体可点切换折叠，正文显隐归壳（v-show） */
  collapsible?: boolean;
  /** 展开态（collapsible 时配合 toggle 受控使用——CollapseRow 同款范式） */
  open?: boolean;
}>(), { eyebrow: '', icon: '', title: '', tone: 'idle', dense: false, collapsible: false, open: false });

const emit = defineEmits<{ (e: 'toggle', open: boolean): void }>();

/** 进程内自增 id：aria-controls 关联用（useId 需 Vue 3.5+，本包基线 3.4） */
let seq = 0;
const bodyId = `dock-body-${++seq}`;

/** 头部是否渲染（全空 + 无动作位 = 无头卡：QueueDock 单条形态） */
const hasHead = computed(() =>
  !!(props.icon || props.eyebrow || props.title || props.tone === 'busy' || props.collapsible));
</script>

<template>
  <section
    class="dock"
    :class="[`tone-${tone}`, { min: dense || (collapsible && !open) }]"
    :aria-busy="tone === 'busy' || undefined"
  >
    <header v-if="hasHead || $slots.actions" class="dock-head">
      <!-- cr-186：可折叠卡 header 整体可点（折叠开关不再挤行尾小钮） -->
      <button
        v-if="collapsible"
        type="button"
        class="dock-toggle"
        :aria-expanded="open"
        :aria-controls="bodyId"
        @click="emit('toggle', !open)"
      >
        <BusyRing v-if="tone === 'busy'" :size="14" />
        <Icon v-else-if="icon" :name="icon" :size="14" class="dock-icon" />
        <span v-if="eyebrow" class="dock-eyebrow">{{ eyebrow }}</span>
        <span v-if="title" class="dock-title">{{ title }}</span>
      </button>
      <div v-else class="dock-static">
        <BusyRing v-if="tone === 'busy'" :size="14" />
        <Icon v-else-if="icon" :name="icon" :size="14" class="dock-icon" />
        <span v-if="eyebrow" class="dock-eyebrow">{{ eyebrow }}</span>
        <span v-if="title" class="dock-title">{{ title }}</span>
      </div>
      <Icon v-if="collapsible" name="chevron-down" :size="14" class="dock-chev" :class="{ open }" />
      <div v-if="$slots.actions" class="dock-actions"><slot name="actions" /></div>
    </header>
    <div
      v-if="$slots.default"
      v-show="!collapsible || open"
      :id="collapsible ? bodyId : undefined"
      class="dock-body"
      :role="tone === 'busy' ? 'status' : undefined"
    >
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
  /* cr-144：底与页面同层（base）——dock 长驻浮层与消息流同底，
     靠边线+影分层（surface 与输入卡错面，raised 又过浮——base 恰中） */
  background: var(--bg-base);
  box-shadow: var(--shadow-dock), var(--elev-hairline);
  font-size: var(--fs-md);
  color: var(--text-1);
}
.dock.min { padding: 6px 12px; }
.dock.tone-warn { border-color: rgba(var(--warn-rgb), 0.45); }
.dock.tone-error { border-color: rgba(var(--err-rgb), 0.45); }

.dock-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.dock.min .dock-head { margin-bottom: 0; }
/* 头部左区：可折叠 = 整体可点开关（命中区 --hit-min，CollapseRow 家法），
   否则静态流。cr-186 减重：纯图标 lead + 不加粗文本（eyebrow 弱色类别 ·
   title 本色主体），替代旧「大写粗眉标 + 粗标题」双重视觉重量 */
.dock-toggle, .dock-static { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.dock-toggle {
  min-height: var(--hit-min);
  padding: 0; border: 0; background: transparent;
  font-family: inherit; color: inherit; text-align: left; cursor: pointer;
}
.dock-toggle:hover .dock-icon, .dock-toggle:hover .dock-eyebrow { color: var(--text-2); }
.dock-icon { color: var(--text-3); flex: none; }
.dock-eyebrow { font-size: var(--fs-md); color: var(--text-3); flex-shrink: 0; }
.dock-title {
  font-size: var(--fs-md); color: var(--text-1);
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dock-chev {
  flex: none; color: var(--text-3);
  transition: transform calc(0.12s * var(--motion-scale)) var(--ease-out);
}
.dock-chev.open { transform: rotate(180deg); }
.dock-actions { display: flex; gap: 6px; flex-shrink: 0; }
.dock-body { min-width: 0; }
</style>
