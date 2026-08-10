<!-- ModalLayer.vue —— 弹窗层（插槽：渲染当前视角挂载的全局弹窗）
     视角注册的 modals 在此统一挂载，组件内部自管可见性（注入 ui store）。 -->
<script setup lang="ts">
import type { Component } from 'vue';

defineProps<{ modals: Component[] }>();
</script>

<template>
  <component :is="m" v-for="(m, i) in modals" :key="i" />
</template>
