// ============================================================
// ac-host-face-core —— 宿主能力面契约纯库（cr-886 → cr-1121）
//
// 零 cordis 依赖：宿主行与壳 client 行共同消费的协议词汇 + client 实现。
// server 侧监听复用 ac-envelope-core listenIpc（每帧处理即回，无并发分发
// 需求）。cr-1121 起契约内容 = 宿主注册面聚合 + 壳侧契约缓存——本包
// 不再承载工具/段常量（承诺面常量随真动态化退役）。
// ============================================================
export const name = 'ac-host-face-core';

export * from './contract.ts';
export { HostFaceClient } from './client.ts';
