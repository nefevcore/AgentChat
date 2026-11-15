// ============================================================
// ac-host-face-core —— 宿主能力面契约纯库（cr-886）
//
// 零 cordis 依赖：宿主行与壳 client 行共同消费的协议词汇 + client 实现。
// server 侧监听复用 ac-envelope-core listenIpc（每帧处理即回，无并发分发需求）。
// ============================================================
export const name = 'ac-host-face-core';

export * from './contract.ts';
export { HOST_FACE_TOOLS, HOST_FACE_SECTIONS, HOST_FACE_PROMISE_SECTIONS } from './promise.ts';
export { HostFaceClient } from './client.ts';