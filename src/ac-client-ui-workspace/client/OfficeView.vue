<!-- OfficeView.vue —— Office 文档预览渲染组件（docx/xlsx/pptx 家族）
  @vue-office 三组件按需懒加载（vue3 产物，异步分量——不进主 bundle，
  首次打开 office 文件才拉解析器）；src = fetchWorkspaceFile 返回的
  base64 字符串（组件直接消费）。解析失败（损坏文件/超限）走 error 插槽。
  组件挂载后守卫 isDead：解析完成前 pane 切走（v-show 卸载组件）时，
  迟到的失败提示不再冒泡（Modal/pane 双形态共用）。 -->
<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue';

const props = defineProps<{
  /** 文件名（扩展名选组件 + alt 兜底） */
  name: string;
  /** base64 载荷（空 = 不渲染，模板分支前置守卫） */
  src: string;
}>();

// 懒加载（首次渲染才拉对应解析器——xlsx 内嵌解析器 ~1.6MB，不值得预载）
const VueOfficeDocx = defineAsyncComponent(() => import('@vue-office/docx'));
const VueOfficeExcel = defineAsyncComponent(() => import('@vue-office/excel'));
const VueOfficePptx = defineAsyncComponent(() => import('@vue-office/pptx'));

// 扩展名（小写）
const ext = computed(() => {
  const i = props.name.lastIndexOf('.');
  return i > 0 ? props.name.slice(i + 1).toLowerCase() : '';
});

const kind = computed<'docx' | 'excel' | 'pptx' | null>(() => {
  if (ext.value === 'docx') return 'docx';
  if (ext.value === 'xlsx' || ext.value === 'xlsm') return 'excel';
  if (ext.value === 'pptx') return 'pptx';
  return null;
});

const comp = computed(() => {
  if (kind.value === 'docx') return VueOfficeDocx;
  if (kind.value === 'excel') return VueOfficeExcel;
  if (kind.value === 'pptx') return VueOfficePptx;
  return null;
});

// 解析失败态（@vue-office 抛错无错误回调——error 插槽 + 本地守卫）
const parseError = ref('');
let isDead = false;
onBeforeUnmount(() => { isDead = true; });
function onError(err: unknown) {
  if (isDead) return;
  parseError.value = err instanceof Error ? err.message : '文档解析失败';
}
</script>

<template>
  <div v-if="src && comp" class="ov-wrap">
    <div v-if="parseError" class="ov-error">
      <span>{{ parseError }}</span>
      <span class="ov-error-hint">可尝试「本地打开」用系统程序查看</span>
    </div>
    <component v-else :is="comp" :src="src" @error="onError" class="ov-doc" />
  </div>
</template>

<style scoped>
.ov-wrap {
  height: 100%;
  overflow: auto;
  background: var(--color-bg-page, #fff);
}
.ov-doc {
  width: 100%;
  height: 100%;
}
.ov-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--color-text-secondary, rgba(255,255,255,0.6));
  font-size: 13px;
}
.ov-error-hint {
  font-size: 12px;
  color: var(--color-text-tertiary, rgba(255,255,255,0.35));
}
</style>