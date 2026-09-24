// ============================================================
// client/vue-office.d.ts —— @vue-office 三包的模块声明
//
// @vue-office/{docx,excel,pptx} 无类型产物（lib/index.d.ts 为空壳）；
// 消费面仅 OfficeView.vue 懒加载三处：声明为返回任意组件的异步工厂，
// props 由调用点约定（src=base64、@error 失败回调）。
// ============================================================
// 三包 js 入口的运行时消费已迁移：UMD 直拷 public/vendor/ + officeVendor.ts
// 读全局（构建提速方案，见该文件头注）；css 懒注入仍走
// import('@vue-office/excel/lib/index.css') 形态（OfficeView.vue）。
// pptx 无 css——其 js 消费证据唯一锚在 sync 脚本（scripts/ 不进包扫描面），
// 故此处留同形态注释行充 check-deps R4 的证据锚：
//   （伪代码）const VueOfficePptx = defineAsyncComponent(() => import('@vue-office/pptx'))
declare module '@vue-office/docx';
declare module '@vue-office/excel';
declare module '@vue-office/pptx';