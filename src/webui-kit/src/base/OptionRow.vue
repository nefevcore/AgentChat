<!--
  webui-kit/src/base/OptionRow.vue —— 选项行（单选/多选，cr-157）
  归一：InteractionBar .ib-option（提问选项：单选 radiogroup 即选即走、
  多选 checkbox 组停留勾选）。marker 位支持 radio 圆点 / checkbox 勾 / 序号。
-->
<script setup lang="ts">
import Icon from './Icon.vue';

withDefaults(defineProps<{
  selected?: boolean;
  /** 单选（radio 圆点）/ 多选（checkbox 勾） */
  multi?: boolean;
  /** 序号位（提问选项 1/2/3…）——优先于 marker */
  index?: number;
}>(), { selected: false, multi: false });

const emit = defineEmits<{ choose: [] }>();
</script>

<template>
  <button
    type="button"
    class="ui-opt"
    :class="{ 'is-selected': selected }"
    :role="multi ? 'checkbox' : 'radio'"
    :aria-checked="selected"
    @click="emit('choose')"
  >
    <span v-if="index !== undefined" class="ui-opt-num" aria-hidden="true">{{ index }}</span>
    <span v-else-if="multi" class="ui-opt-check" aria-hidden="true"><Icon v-if="selected" name="check" :size="12" /></span>
    <span v-else class="ui-opt-radio" aria-hidden="true" />
    <span class="ui-opt-label"><slot /></span>
  </button>
</template>

<style scoped>
.ui-opt {
  display: flex; align-items: center; gap: 8px;
  min-height: 30px; padding: 3px 8px;
  border: none; border-radius: var(--r-sm);
  background: none; color: var(--text-2);
  font-size: var(--fs-md); font-family: var(--font-ui);
  cursor: pointer; text-align: left; width: 100%;
}
.ui-opt:hover { background: var(--bg-hover); }
.ui-opt.is-selected { background: var(--role-selected-bg); color: var(--role-selected-text); }
.ui-opt:focus-visible { outline: var(--focus-ring-width) solid var(--focus-ring); outline-offset: var(--focus-ring-width); }
.ui-opt-radio {
  width: 14px; height: 14px; border-radius: 50%;
  border: 1.5px solid var(--text-3); flex-shrink: 0;
  display: grid; place-items: center;
}
.ui-opt.is-selected .ui-opt-radio { border-color: var(--primary); }
.ui-opt.is-selected .ui-opt-radio::after { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--primary); }
.ui-opt-check {
  width: 14px; height: 14px; border-radius: 4px;
  border: 1.5px solid var(--text-3); flex-shrink: 0;
  display: grid; place-items: center; color: var(--on-primary);
}
.ui-opt.is-selected .ui-opt-check { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
.ui-opt-num {
  width: 18px; height: 18px; flex-shrink: 0;
  display: grid; place-items: center;
  font-size: var(--fs-2xs); font-weight: 600; color: var(--text-3);
}
.ui-opt.is-selected .ui-opt-num { color: var(--primary); }
.ui-opt-label { min-width: 0; }
</style>