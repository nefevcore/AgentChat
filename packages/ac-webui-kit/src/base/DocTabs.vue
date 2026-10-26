<!--
  webui-kit/src/base/DocTabs.vue —— 可关闭文档页签（cr-157）
  归一：FilePreviewPanel .fpp-tab 与 WebSearchPanel .wsp-tab（两份同 recipe 副本）。
  结构：tabs 条（icon + title + close）+ 尾部 actions 钮位（+ / 全关）+ 内容 pane 区。
  pane 区经默认 slot 投影（宿主自带 v-show 切换）。
  根高度不设 100%（cr-190）：两消费方均把本组件当「一条」嵌入自家
  flex column——自足分栏的高度语义会挤塌宿主的兄弟 pane 区。
-->
<script setup lang="ts">
import Icon from './Icon.vue';

defineProps<{
  tabs: Array<{ key: string; title: string; icon?: string }>
  activeKey: string;
}>();

const emit = defineEmits<{
  select: [key: string];
  close: [key: string];
}>();
</script>

<template>
  <div class="ui-doc-tabs">
    <div class="ui-doc-tabs-strip" role="tablist">
      <div class="ui-doc-tabs-scroll">
        <button
          v-for="t in tabs" :key="t.key"
          type="button"
          class="ui-doc-tab"
          :class="{ on: t.key === activeKey }"
          role="tab"
          :aria-selected="t.key === activeKey"
          :title="t.title"
          @click="emit('select', t.key)"
        >
          <Icon v-if="t.icon" :name="t.icon" :size="13" />
          <span class="ui-doc-tab-title">{{ t.title }}</span>
          <span
            class="ui-doc-tab-close" role="button" aria-label="关闭"
            @click.stop="emit('close', t.key)"
          ><Icon name="x" :size="10" /></span>
        </button>
      </div>
      <div v-if="$slots.actions" class="ui-doc-tabs-actions"><slot name="actions" /></div>
    </div>
    <slot />
  </div>
</template>

<style scoped>
.ui-doc-tabs { display: flex; flex-direction: column; }
.ui-doc-tabs-strip { display: flex; align-items: stretch; border-bottom: 1px solid var(--line); flex-shrink: 0; }
.ui-doc-tabs-scroll { display: flex; gap: 2px; overflow-x: auto; flex: 1; min-width: 0; padding: 4px 4px 0; }
.ui-doc-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 8px; border: none;
  border-radius: var(--r-sm) var(--r-sm) 0 0;
  background: none; color: var(--text-2);
  font-size: var(--fs-sm); font-family: var(--font-ui);
  cursor: pointer; white-space: nowrap; flex-shrink: 0;
}
.ui-doc-tab:hover { background: var(--bg-hover); color: var(--text-1); }
/* 选中底 = role-selected-bg（全站选中角色色，承 cr-122；bg-surface 亮色下与宿主 bg-base 几不可辨且弱于 hover） */
.ui-doc-tab.on { color: var(--text-1); background: var(--role-selected-bg); box-shadow: inset 0 -2px 0 var(--primary); }
.ui-doc-tab:focus-visible { outline: var(--focus-ring-width) solid var(--focus-ring); outline-offset: calc(-1 * var(--focus-ring-width)); }
.ui-doc-tab-title { max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.ui-doc-tab-close {
  position: relative; display: grid; place-items: center;
  width: 16px; height: 16px; border-radius: var(--r-sm);
  color: var(--text-3);
}
.ui-doc-tab-close::after { content: ''; position: absolute; inset: -4px; } /* 命中区 */
.ui-doc-tab-close:hover { background: var(--bg-hover); color: var(--text-1); }
.ui-doc-tabs-actions { display: flex; align-items: center; gap: 2px; padding: 0 6px; flex-shrink: 0; }
</style>