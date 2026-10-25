// ============================================================
// ac-client-ui-conversation/client/toolModeInherit.ts ——
// 工具调用模式「新会话跟随上次选择」的继承待写登记（跨组件单例）
//
// 背景（2026-09-17 恢复）：工具调用模式 = conv-settings toolMode 会话级
// 覆盖——**选择只落当前会话**，新会话回跟随态。用户口径：会话 1 选了
// 程序化，新会话 2 也默认程序化（与 effort/elevation 回放同族语义）。
// 程序化/无工具必须落存储才真正生效（router 收窄读的是 conv-settings，
// 只改 UI 初值不生效）——所以「跟随」不能只回放 UI，要写该会话。
//
// 两个接缝（本文件只做后端无关的登记，不引 rpc）：
//   ① ChatInput 会话切换 watch：会话无显式 toolMode 键 → 回放偏好并写
//      该会话 conv-settings（UI 校准 + 后端生效）；写入异步，登记待写
//      promise（persistToolMode）；
//   ② chat-core.deliver：投递前 await 同一会话的待写（settleToolMode）
//      ——新会话的"首条消息"不得抢在继承写之前出门（挂载 watch 的竞态
//      窗口极小但存在）。
//
// ChatInput 随视角切换重挂载（实例内状态不可依赖）→ 登记面必须是
// 模块级单例（与 draftParking 同款裁决）。写失败不阻塞发送：失败即
// 无声（保持跟随态，用户可手动再选——选择总是写会话）。
// ============================================================

/** 会话 → 待写 promise（settle 时键级清空；同会话重写覆盖旧登记） */
const pending = new Map<string, Promise<unknown>>();

/**
 * 登记一次「偏好 → 会话 conv-settings」的继承写（写入由调用方发起）。
 * 同会话重复登记以最后一次为准（会话切换/Agent 切换重算）。
 */
export function persistToolMode(conversationId: string, writing: Promise<unknown>): void {
  if (!conversationId) return;
  pending.set(conversationId, writing);
  void writing.then(
    () => drop(conversationId, writing),
    () => drop(conversationId, writing),
  );
}

/** 会话级清空（仅当登记项仍是本次写入——防清掉后登记者） */
function drop(conversationId: string, writing: Promise<unknown>): void {
  if (pending.get(conversationId) === writing) pending.delete(conversationId);
}

/**
 * 投递前等待：该会话若有未落定的继承写，等它收束（成功/失败都放行）。
 * 无登记（已选过/非继承态）= 立即返回——常态零开销。
 */
export async function settleToolMode(conversationId: string | null | undefined): Promise<void> {
  if (!conversationId) return;
  const writing = pending.get(conversationId);
  if (!writing) return;
  try {
    await writing;
  } catch {
    /* 写失败不阻塞投递（跟随态兜底） */
  }
  drop(conversationId, writing);
}

/** 测试/调试探针：当前待写会话数 */
export function pendingToolModeCount(): number {
  return pending.size;
}
