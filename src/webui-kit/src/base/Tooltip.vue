<!--
  webui-kit/src/base/Tooltip.vue —— 轻量提示（CSS hover）
  用法：<Tooltip text="发送"> <Icon name="send" /> </Tooltip>
 可达性：::after 提示读屏读不到——宿主控件必须自带 aria-label（title 会与本组件视觉
 提示同屏双显，内嵌控件不设 title）； 本组件只管视觉，:has(:focus-visible) 让键盘用户也能看到——只认键盘焦点，
 鼠标点击聚焦不匹配（cr-221：原 :focus-within 下点击后焦点留驻按钮，鼠标移开提示仍不散）。
布局约束（cr-226）：勿用于滚动容器（overflow auto/scroll）或 overflow:hidden 祖先内部——
::after 绝对定位 + nowrap，隐藏态也计入祖先滚动范围（未满也出滚动条）、显示态被祖先裁剪；
此场景用宿主原生 title（IconAction 的 title+aria-label 双通道同款）。
-->
<script setup lang="ts">
withDefaults(defineProps<{
  text?: string;
  placement?: 'top' | 'bottom';
}>(), { placement: 'top' });
</script>

<template>
  <span class="ui-tip" :data-tip="text" :class="`ui-tip--${placement}`">
    <slot />
  </span>
</template>

<style scoped>
.ui-tip { position: relative; display: inline-flex; }
.ui-tip::after {
  content: attr(data-tip); position: absolute; left: 50%;
  transform: translateX(-50%) translateY(4px);
  background: var(--bg-raised); color: var(--text-1); border: 1px solid var(--line);
  font-size: var(--fs-xs); padding: 4px 8px; border-radius: var(--r-sm); white-space: nowrap;
  box-shadow: var(--shadow-pop); opacity: 0; pointer-events: none; visibility: hidden;
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); z-index: 700;
}
.ui-tip--top::after { bottom: calc(100% + 6px); }
.ui-tip--bottom::after { top: calc(100% + 6px); }
/* hover 与键盘焦点同待遇：纯 CSS 提示对键盘用户原本不可达；键盘可达走
   :has(:focus-visible)（:focus-visible 只匹配键盘导航焦点——鼠标点击聚焦不算，cr-221） */
.ui-tip:hover::after, .ui-tip:has(:focus-visible)::after {
  opacity: 1; visibility: visible; transform: translateX(-50%) translateY(0);
}
</style>
