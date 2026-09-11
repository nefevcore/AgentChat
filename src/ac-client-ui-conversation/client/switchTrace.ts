// ============================================================
// client/switchTrace.ts —— 会话切换追踪门面（re-export）
// owning = ac-client-runtime/src/switchTrace.ts（2026-11 下沉共享纯库
// ——事件链横切 conversation/agents/runview/singles 四行，单源住
// runtime 消 .ts 层跨行环；VIEWER_ID 同款姿势）。
// ============================================================
export { traceSwitch, histReqSentAt } from 'ac-client-runtime';
