// ============================================================
// core/registry/perspectives.ts —— 视角注册表门面（re-export）
//
// owning = ac-client-ui-layout/client/perspectives.ts（M27.2-2 layout
// 件出包随件迁——main:perspective 席位 owning 件的解析面）。本模块
// re-export 维持旧路径（bridge 注册面 / PerspectiveHost〔已迁包〕/
// 测试导入面零改动——同一模块实例）。
// ============================================================
export * from 'ac-client-ui-layout/client/perspectives.ts';
