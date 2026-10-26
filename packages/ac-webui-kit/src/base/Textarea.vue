<!--
  webui-kit/src/base/Textarea.vue —— 多行文本标准件（cr-168）
  code 变体：等宽字体 + 代码底（AGENT.md / SYSTEM.md 编辑位）。
-->
<script setup lang="ts">
const props = withDefaults(defineProps<{
  modelValue?: string;
  placeholder?: string;
  rows?: number;
  /** 代码态：mono + code-bg */
  code?: boolean;
  disabled?: boolean;
}>(), { modelValue: '', placeholder: '', rows: 4, code: false, disabled: false });
const emit = defineEmits<{ 'update:modelValue': [v: string] }>();
</script>

<template>
  <textarea
    class="ui-textarea"
    :class="{ code }"
    :value="modelValue"
    :placeholder="placeholder"
    :rows="rows"
    :disabled="disabled"
    :spellcheck="code ? false : undefined"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  ></textarea>
</template>

<style scoped>
.ui-textarea {
  width: 100%; box-sizing: border-box;
  height: auto; min-height: 76px; padding: 8px 10px;
  border: 1px solid var(--line); border-radius: var(--r-sm);
  background: transparent; color: var(--text-1); /* cr-181：去填充底（code 变体的 --code-bg 是代码编辑语义，保留） */
  font-size: var(--fs-md); font-family: var(--font-ui);
  line-height: 1.6; resize: vertical;
  outline: none;
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.ui-textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-light); }
.ui-textarea.code { font-family: var(--font-mono); font-size: var(--fs-sm); background: var(--code-bg); color: var(--code-text); }
.ui-textarea:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
