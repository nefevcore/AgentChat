<!--
  webui-kit/src/base/Input.vue —— 文本输入标准件（cr-168）
  归一：全仓表单原生 input 配方（gallery fx-input / AgentPane info-input /
  NsFieldList ns-search-input 同语系）——焦点光晕 3px、边框转主色。
  type 透传原生（text/number/url…）；密码与搜索有专用件 PasswordInput/SearchInput。
-->
<script setup lang="ts">
withDefaults(defineProps<{
  modelValue?: string | number;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
}>(), { modelValue: '', type: 'text', placeholder: '', disabled: false });
const emit = defineEmits<{ 'update:modelValue': [v: string] }>();
</script>

<template>
  <input
    class="ui-input"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  >
</template>

<style scoped>
.ui-input {
  width: 100%; box-sizing: border-box;
  height: var(--ctl-h-md); padding: 0 10px;
  border: 1px solid var(--line); border-radius: var(--r-sm);
  background: transparent; color: var(--text-1); /* cr-181：去填充底——边框形态即输入语义，填充块反读作非输入项 */
  font-size: var(--fs-md); font-family: var(--font-ui);
  outline: none;
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.ui-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-light); }
.ui-input:disabled { opacity: 0.55; cursor: not-allowed; }
.ui-input::placeholder { color: var(--text-3); }
</style>
