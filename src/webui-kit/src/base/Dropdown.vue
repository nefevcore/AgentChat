<!--
  webui-kit/src/base/Dropdown.vue —— 下拉菜单族（cr-157）
  归一：ChatInput .dd-menu/.dd-option（Agent/工作区/模型/思考强度菜单）与
  TagChoice .tc-menu/.tc-option（档位弹层）——两处 recipe 本就同语系。

  无状态容器：trigger/menu 都是 slot（开合状态归业务）；本件只提供配方。
  menu 定位：默认向上（composer 场景）；up=false 向下。
-->
<script setup lang="ts">
withDefaults(defineProps<{
  /** 向上弹出（composer 场景缺省） */
  up?: boolean;
  minWidth?: number;
}>(), { up: true, minWidth: 160 });
</script>

<template>
  <div class="ui-dd">
    <slot name="trigger" />
    <div
      v-if="$slots.menu"
      class="ui-dd-menu"
      :class="{ up }"
      :style="{ minWidth: minWidth + 'px' }"
      @click.stop
    >
      <slot name="menu" />
    </div>
  </div>
</template>
<!-- 样式单源：base/dropdown.css（容器与选项族配方均在全局 css；
     业务自控 Transition 开合时可不经本组件直接消费 .ui-dd-* 类名） -->