<!-- ============================================================
  webui-kit/src/base/ListCard.vue —— 清单卡（cr-765 批次A §1.3 + #18）
  目录条目 / 子 Agent / 浏览器步骤 / 搜索结果 / 待办条目的统一渲染体。
  行首图标一律取 icons.ts 注册名（§1.7 禁自绘几何 glyph）；着色规则：
  默认 --text-3 中性，仅语义需要时染（目录 --primary-strong / 成功
  --ok-status / 失败 --err-status / 运行 --primary）。
  ============================================================ -->
<script setup lang="ts">
import { ref } from 'vue';
import Icon from './Icon.vue';
import type { ListCardItem } from './listCardTypes.ts';

withDefaults(defineProps<{
  items: ListCardItem[];
  /** 行密度：normal 常规 / dense 紧凑（多行场景） */
  density?: 'normal' | 'dense';
  /** 限高（缺省会话卡统一限高） */
  maxHeight?: string;
}>(), { density: 'normal', maxHeight: 'var(--card-viewport-max)' });

const emit = defineEmits<{ (e: 'item-click', key: string | number): void }>();

/** 行内详情展开态（单开——同屏只展开一行详情） */
const expandedKey = ref<string | number | null>(null);

const toneColor: Record<string, string> = {
  '': 'var(--text-3)',
  primary: 'var(--primary-strong)',
  ok: 'var(--ok-status)',
  err: 'var(--err-status)',
  warn: 'var(--warn)',
  run: 'var(--primary)',
};
</script>

<template>
  <div class="list-card" :class="{ dense: density === 'dense' }" :style="{ maxHeight }">
    <div
      v-for="item in items"
      :key="item.key"
      class="lc-row"
      :class="{ 'is-failed': item.failed, clickable: !!item.detail }"
      @click="item.detail && (expandedKey = expandedKey === item.key ? null : item.key)"
    >
      <Icon v-if="item.icon" :name="item.icon" :size="14" class="lc-icon" :style="{ color: toneColor[item.iconTone || ''] }" />
      <div class="lc-main">
        <div class="lc-title" :title="item.title">{{ item.title }}</div>
        <div v-if="item.sub" class="lc-sub" :title="item.sub">{{ item.sub }}</div>
        <div v-if="item.detail && expandedKey === item.key" class="lc-detail">{{ item.detail }}</div>
      </div>
      <span v-if="item.meta" class="lc-meta">{{ item.meta }}</span>
      <Icon v-if="item.status" :name="item.status" :size="13" class="lc-status" :style="{ color: toneColor[item.statusTone || ''] }" />
    </div>
  </div>
</template>

<style scoped>
.list-card { display: flex; flex-direction: column; min-width: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
.lc-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; min-width: 0; }
.lc-row.clickable { cursor: pointer; }
.lc-row.is-failed { background: color-mix(in srgb, var(--err) 8%, transparent); border-radius: var(--r-sm); padding: 4px 6px; margin: 0 -6px; }
.lc-icon { flex-shrink: 0; }
.lc-main { flex: 1; min-width: 0; }
.lc-title { font-size: var(--fs-sm); color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lc-sub { font-size: var(--fs-2xs); color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lc-detail { font-size: var(--fs-2xs); color: var(--text-2); margin-top: 4px; white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono); }
.lc-meta { font-size: var(--fs-2xs); color: var(--text-3); font-family: var(--font-mono); flex-shrink: 0; }
.lc-status { flex-shrink: 0; }
</style>