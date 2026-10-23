// ============================================================
// ac-rowset-core —— 行集推导器纯库（M2.3）
//
// 职责：AgentConfig（工具点名 ∨ 行引用）× 全局行集目录 → 壳行集派生
// 清单 + 行目录静态投影（per-agent 化）+ 宿主行集偏好派生。
// 消费面：宿主 boot 现算（argv 传清单引用）+ CLI 本地派生。
// ============================================================

export const name = 'ac-rowset-core';

export * from './rowset.ts';
export * from './disk.ts';
export * from './plugin-rows.ts';
