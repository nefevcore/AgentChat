// ============================================================
// client/vue-office.d.ts —— @vue-office 三包的模块声明
//
// @vue-office/{docx,excel,pptx} 无类型产物（lib/index.d.ts 为空壳）；
// 消费面仅 OfficeView.vue 懒加载三处：声明为返回任意组件的异步工厂，
// props 由调用点约定（src=base64、@error 失败回调）。
// ============================================================
declare module '@vue-office/docx';
declare module '@vue-office/excel';
declare module '@vue-office/pptx';