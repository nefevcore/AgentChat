// ============================================================
// client/officeVendor.ts —— @vue-office UMD 运行时加载器
//
// 三包产物不走 vite 构建图（省每次 build 的 parse+minify，占构建
// 时间约 2/3），而由 scripts/sync-office-vendor.mjs 直拷到
// src/webui/public/vendor/（vite public 目录原样直拷零处理，
// dist 由 web-server 同源托管，CSP script-src 'self' 放行 /vendor/*）。
// 本模块按需注入 <script> 读全局（UMD 全局名 vue-office-{kind}），
// 并发去重、失败即抛（OfficeView @error 面板兜底）。
//
// UMD 头：...t(require("vue-demi"),require("vue"))...浏览器侧无 require，
// UMD wrapper 落到 (self.vue-office-xxx = t(self.VueDemi, self.Vue))——
// 故注入前先挂 window.Vue / window.VueDemi 垫片。vue3 档 UMD 对
// vue-demi 只消费 defineComponent + version（无 isVue2/isVue3 分支，
// 已对三包产物核实），垫片给 Vue 本体即等价。
// ============================================================

type OfficeKind = 'docx' | 'excel' | 'pptx';

declare global {
  interface Window {
    Vue?: unknown;
    VueDemi?: unknown;
    'vue-office-docx'?: unknown;
    'vue-office-excel'?: unknown;
    'vue-office-pptx'?: unknown;
  }
}

/** kind → UMD 全局名（@vue-office 出厂约定） */
const GLOBAL_NAME: Record<OfficeKind, string> = {
  docx: 'vue-office-docx',
  excel: 'vue-office-excel',
  pptx: 'vue-office-pptx',
};

const inflight = new Map<string, Promise<unknown>>();

/** UMD 依赖注入：浏览器全局 require 垫片（幂等） */
function ensureVueGlobals(): void {
  if (typeof window === 'undefined') return;
  // 惰性 import：加载器自身进主 chunk 后不立即拉 vue——首次 office 预览才触
  // （vue 本就在主 bundle，import() 只是取引用，无网络成本）
  import('vue').then((m) => {
    if (window.Vue === undefined) window.Vue = m;
    if (window.VueDemi === undefined) window.VueDemi = m;
  });
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onerror = () => reject(new Error(`加载失败：${src}`));
    s.onload = () => resolve();
    document.head.appendChild(s);
  });
}

/**
 * 按需加载 @vue-office 组件（UMD 全局产物）。
 * 返回组件对象（default 导出形态与 npm 包一致——UMD 产物全局即其 default）。
 * 并发调用去重；script 加载成功但全局未出现视为失败（产物损坏兜底）。
 */
export function loadOfficeComponent(kind: OfficeKind): Promise<any> {
  const g = GLOBAL_NAME[kind];
  const existing = inflight.get(g);
  if (existing) return existing as Promise<any>;
  const p = (async () => {
    ensureVueGlobals();
    await injectScript(`/vendor/vue-office-${kind}.js`);
    const comp = (window as any)[g];
    if (!comp) throw new Error(`全局 ${g} 未出现——vendor 产物异常`);
    return comp;
  })();
  inflight.set(g, p);
  // 失败后清缓存：下次预览可重试（成功则常驻——三包产物进程内不变）
  p.catch(() => inflight.delete(g));
  return p;
}
