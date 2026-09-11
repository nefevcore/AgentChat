// ============================================================
// ac-client-ui-conversation/client/draftParking.ts —— 输入草稿暂存
//
// 会话级输入草稿位（模块级单例——生命周期独立于 ChatInput 组件实例）：
// ChatInput 随视角切换（talk ↔ single ↔ group 经 PerspectiveHost 的
// <component :is> 换 async wrapper）重挂载时，实例内的草稿会丢——
// 暂存位必须在组件外。键 = dialog 键（single:<id> / pair:<a>|<b> /
// group:<gid>——与 feed.activeDialogId 同源三形态统一）。
//
// 纯内存（页面刷新即弃——草稿是瞬态输入，不承诺持久化）；上限兜底
// 防长会话漂移（LRU 式淘汰：超出即删最旧）。
// ============================================================

const MAX_PARKED = 100;

const parked = new Map<string, string>();

/** 暂存草稿（空文本 = 清位——发送后/清空后调用同接口） */
export function parkDraft(key: string, text: string): void {
  if (!text) {
    parked.delete(key);
    return;
  }
  parked.delete(key); // 重插尾部 = LRU 新鲜度
  parked.set(key, text);
  if (parked.size > MAX_PARKED) {
    const oldest = parked.keys().next().value;
    if (oldest !== undefined) parked.delete(oldest);
  }
}

/** 取草稿（无 = 空串；不消费——切回同会话多次取同值） */
export function takeDraft(key: string): string {
  return parked.get(key) ?? '';
}
