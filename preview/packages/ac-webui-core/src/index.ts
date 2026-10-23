// ============================================================
// ac-webui-core —— webui 历史读纯库（M7.1；宿主 webui 只读投影）
//
// 裁决簿〈webui 读投影〉三拆之一：历史读 = 宿主文件直读
//（JSONL 追加式天然支持增量 tail）+ fs watch；不设常驻读服务行
//（= ac-session 宿主侧复活，与 D4 写权=所有权相悖）。
// 残留仅 watch 选型 / 列表索引等实现细节。
// ============================================================

export const name = 'ac-webui-core';

export * from './history.ts';
export * from './manifest.ts';
export * from './isolated-policy.ts';
