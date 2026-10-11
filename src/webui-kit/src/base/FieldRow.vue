<!--
  webui-kit/src/base/FieldRow.vue —— 设置字段行标准件（cr-168）
  归一：AgentPane llm-item / NsFieldList ns-item 的「标签+描述+控件」行。
  is-non-default：非默认值态——左侧 4px 主色分栏条 + 容器左角收窄（cr-167 非对称圆角）。
  cr-327：原 Label 标准件（cr-173）散表单零消费退役，配方收回本件内联。
-->
<script setup lang="ts">
withDefaults(defineProps<{
  label: string;
  description?: string;
  /** 非默认值（继承面板里的 override 态）——左条点亮 */
  nonDefault?: boolean;
}>(), { description: '', nonDefault: false });
</script>

<template>
  <div class="ui-field" :class="{ 'is-non-default': nonDefault }">
    <div class="ui-field-main">
      <div class="ui-field-label">
        <div class="ui-field-label-name">{{ label }}</div>
        <div v-if="description" class="ui-field-label-desc">{{ description }}</div>
      </div>
    </div>
    <div class="ui-field-ctrl"><slot /></div>
  </div>
</template>

<style scoped>
.ui-field {
  display: flex; flex-direction: column; align-items: stretch; gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--line); border-radius: var(--r-sm);
  position: relative;
}
/* cr-164/167：非默认态 = 左 4px 分栏条 + 容器左角收窄（条区独立小圆角视觉） */
.ui-field.is-non-default { border-radius: 4px var(--r-sm) var(--r-sm) 4px; overflow: hidden; }
.ui-field.is-non-default::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0;
  width: 4px; background: var(--primary);
}
.ui-field-main { min-width: 0; }
/* cr-173 抽出的名/说明配方（原 .ui-label 族；cr-327 Label 退役后单消费方内联） */
.ui-field-label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ui-field-label-name { font-size: var(--fs-md); font-weight: 500; color: var(--text-1); }
.ui-field-label-desc { font-size: var(--fs-xs); color: var(--text-3); }
.ui-field-ctrl { display: flex; align-items: center; gap: 8px; min-width: 0; }
</style>
