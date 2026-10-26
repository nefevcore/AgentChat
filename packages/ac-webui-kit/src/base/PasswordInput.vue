<!--
  webui-kit/src/base/PasswordInput.vue —— 密码/令牌输入标准件（cr-168）
  mono 字体 + 按住眼睛显隐（API key / token 配置位）。
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import Input from './Input.vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  modelValue?: string;
  placeholder?: string;
  disabled?: boolean;
}>(), { modelValue: '', placeholder: '', disabled: false });
const emit = defineEmits<{ 'update:modelValue': [v: string] }>();

const shown = ref(false);
const type = computed(() => (shown.value ? 'text' : 'password'));
function setShown(v: boolean) { shown.value = v; }
</script>

<template>
  <span class="ui-secret">
    <Input
      :model-value="modelValue"
      :type="type"
      :placeholder="placeholder"
      :disabled="disabled"
      class="ui-secret-in"
      @update:model-value="emit('update:modelValue', $event)"
    />
    <button
      type="button"
      class="ui-secret-eye"
      :aria-label="shown ? '隐藏' : '显示'"
      :aria-pressed="shown"
      @pointerdown="setShown(true)"
      @pointerup="setShown(false)"
      @pointerleave="setShown(false)"
    >
      <Icon :name="shown ? 'eye-off' : 'eye'" :size="14" />
    </button>
  </span>
</template>

<style scoped>
.ui-secret { position: relative; display: flex; align-items: center; flex: 1; }
.ui-secret :deep(.ui-input) { padding-right: 34px; font-family: var(--font-mono); }
.ui-secret-eye {
  position: absolute; right: 4px;
  width: 26px; height: 26px;
  display: grid; place-items: center;
  border: none; background: none; border-radius: var(--r-sm);
  color: var(--text-3); cursor: pointer;
}
.ui-secret-eye:hover { background: var(--bg-hover); color: var(--text-1); }
</style>
