<!-- OfficeView.vue —— Office 文档预览渲染组件（docx/xlsx/pptx 家族）
  @vue-office 三组件按需懒加载（vue3 产物，异步分量——不进主 bundle，
  首次打开 office 文件才拉解析器；excel 解析器 ~1.6MB）。src = raw 直链
  URL（三组件的 string src 统一按 URL 取数——excel 侧 XHR arraybuffer、
  docx 侧 fetch；base64 载荷会被当 URL 请求，不可传）。
  CSS 随组件引入（excel 的 x-spreadsheet 画布/工具栏必需——漏引则
  画布尺寸塌陷为不可见）；样式表经懒路径动态 import，与 KaTeX 懒注入
  同一手法。@rendered 计数做加载态，解析失败（损坏文件/网络）走
  @error → 错误面板（本地打开兜底提示）。 -->
<script setup lang="ts">
import { computed, ref, onBeforeUnmount, defineAsyncComponent } from 'vue';

const props = defineProps<{
  /** 文件名（扩展名选组件 + alt 兜底） */
  name: string;
  /** raw 直链 URL（空 = 不渲染，模板分支前置守卫） */
  src: string;
}>();

// 懒加载（首次渲染才拉对应解析器——不进主 bundle）
const VueOfficeDocx = defineAsyncComponent(() => import('@vue-office/docx'));
const VueOfficeExcel = defineAsyncComponent(() => import('@vue-office/excel'));
const VueOfficePptx = defineAsyncComponent(() => import('@vue-office/pptx'));

// 样式随行（excel 的 x-spreadsheet 画布必需；docx/pptx 无独立 css 文件
//——vite 对不存在文件的动态 import 在 build 期直接失败，按包分守卫）
import('@vue-office/excel/lib/index.css');
import('@vue-office/docx/lib/index.css');

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

// 渲染成功计数（@rendered；切换 src 重置——加载态依据）
const renderedTick = ref(0);
function onRendered() { renderedTick.value++; }

// 解析失败态（@error；守卫 pane 已卸载的迟到信号）
const parseError = ref('');
let isDead = false;
onBeforeUnmount(() => { isDead = true; });
function onError(err: unknown) {
  if (isDead) return;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  parseError.value = '文档解析失败' + (msg ? '（' + msg + '）' : '');
}
function resetState() { parseError.value = ''; renderedTick.value = 0; }
</script>

<template>
  <div v-if="src && comp" :key="src" class="ov-wrap">
    <div v-if="parseError" class="ov-error">
      <span>{{ parseError }}</span>
      <span class="ov-error-hint">可尝试「本地打开」用系统程序查看</span>
    </div>
    <div v-else class="ov-doc-holder">
      <component :is="comp" :src="src" @rendered="onRendered" @error="onError" class="ov-doc" />
    </div>
  </div>
</template>

<style scoped>
.ov-wrap {
  height: 100%;
  min-height: 200px;
  overflow: auto;
  background: var(--color-bg-page, #fff);
}
.ov-doc-holder {
  height: 100%;
  min-height: 200px;
}
:deep(.ov-doc) {
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