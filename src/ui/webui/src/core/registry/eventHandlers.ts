// ============================================================
// core/registry/eventHandlers.ts —— WS 事件处理器注册表 ★扩展点
//
// 统一 WS 分发入口：ws.onMessage 只调用 dispatchEvent，
// 各模块（feed 消息流 / chat 业务 / groups 列表）用 registerEventHandler 注册。
// 新事件 = 注册 handler；事件名改一处（core/events/contract）。
// ============================================================

export type EventHandler = (data: any) => void;

const handlers = new Map<string, EventHandler[]>();

/** 注册事件处理器（同一事件可多个，按注册顺序依次调用）。返回 disposer。 */
export function registerEventHandler(type: string, fn: EventHandler): () => void {
  let arr = handlers.get(type);
  if (!arr) {
    arr = [];
    handlers.set(type, arr);
  }
  arr.push(fn);
  return () => {
    const list = handlers.get(type);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx >= 0) {
      list.splice(idx, 1);
      if (list.length === 0) handlers.delete(type);
    }
  };
}

/** 分发事件：未注册的事件静默忽略 */
export function dispatchEvent(type: string, data: any): void {
  for (const fn of handlers.get(type) ?? []) {
    try {
      fn(data);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[eventHandlers] ${type} handler 出错:`, err);
    }
  }
}

/** 清空注册（测试/热重载用） */
export function clearEventHandlers(): void {
  handlers.clear();
}
