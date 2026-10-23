// ============================================================
// ac-credentials-core —— 凭据注入纯库（R-11 ③；开发期避让名，cutover
// 随主线旧行退役回收 ac-credentials 名）
//
// 职责：数据根物理单副本两侧共用——加密算法半边（crypto.ts）+
// credentials/ 目录直读（store.ts）。写者面 = 宿主 auth-registry 行（M4）。
// ============================================================

export const name = 'ac-credentials-core';

export * from './crypto.ts';
export * from './store.ts';
