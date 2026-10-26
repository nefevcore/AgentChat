<!-- OfficeView.vue —— Office 文档预览渲染组件（docx/xlsx/pptx 家族）
  @vue-office 三组件按需懒加载（vue3 产物，异步分量——不进主 bundle，
  首次打开 office 文件才拉解析器；excel 解析器 ~1.6MB）。src = raw 直链
  URL（三组件的 string src 统一按 URL 取数——excel 侧 XHR arraybuffer、
  docx 侧 fetch；base64 载荷会被当 URL 请求，不可传）。
  CSS 随组件引入（excel 的 x-spreadsheet 画布/工具栏必需——漏引则
  画布尺寸塌陷为不可见）；样式表经懒路径动态 import，与 KaTeX 懒注入
  同一手法。解析失败（损坏文件/网络）走 @error → 错误面板（本地打开
  兜底提示）。 -->
<script setup lang="ts">
import { computed, ref, onBeforeUnmount, defineAsyncComponent } from 'vue';
import { loadOfficeComponent } from './officeVendor.ts';
import { extOf } from './filePreviewContent.ts';

const props = defineProps<{
  /** 文件名（扩展名选组件 + alt 兜底） */
  name: string;
  /** raw 直链 URL（空 = 不渲染，模板分支前置守卫） */
  src: string;
}>();

// 懒加载（首次渲染才拉对应解析器——不进主 bundle）。
// 三包 UMD 产物不进 vite 构建图（省每次 build 约 2/3 时间的 parse+minify），
// 由 sync-office-vendor 直拷 public/vendor/ + officeVendor.ts 注入 <script>
// 读全局（构建提速方案见 client/officeVendor.ts 头注）。
const VueOfficeDocx = defineAsyncComponent(() => loadOfficeComponent('docx'));
const VueOfficeExcel = defineAsyncComponent(() => loadOfficeComponent('excel'));
const VueOfficePptx = defineAsyncComponent(() => loadOfficeComponent('pptx'));

// 样式随行（excel 的 x-spreadsheet 画布必需；docx/pptx 无独立 css 文件
//——vite 对不存在文件的动态 import 在 build 期直接失败，按包分守卫）
import('@vue-office/excel/lib/index.css');
import('@vue-office/docx/lib/index.css');

// 扩展名（extOf 单源——与 filePreviewContent 同语义，点文件不误判）
const ext = computed(() => extOf(props.name));

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

// 解析失败态（@error；守卫 pane 已卸载的迟到信号；src 切换经 :key
// 重挂整棵子树——状态自然归零，无需手动重置）
const parseError = ref('');
let isDead = false;
onBeforeUnmount(() => { isDead = true; });
function onError(err: unknown) {
  if (isDead) return;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  parseError.value = '文档解析失败' + (msg ? '（' + msg + '）' : '');
}
</script>

<template>
  <div v-if="src && comp" :key="src" class="ov-wrap">
    <div v-if="parseError" class="ov-error">
      <span>{{ parseError }}</span>
      <span class="ov-error-hint">可尝试「本地打开」用系统程序查看</span>
    </div>
    <div v-else class="ov-doc-holder">
      <component :is="comp" :src="src" @error="onError" class="ov-doc" />
    </div>
  </div>
</template>

<style scoped>
.ov-wrap {
  height: 100%;
  min-height: 200px;
  overflow: auto;
  background: var(--bg-base);
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
  color: var(--text-2);
  font-size: 13px;
}
.ov-error-hint {
  font-size: 12px;
  color: var(--text-3);
}
</style>