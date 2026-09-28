// ============================================================
// client/historyFlag.ts —— Android 返回键桥（cr-35 Phase①）
//
// 协议（最小面，壳 → WebView 单向）：MainActivity onBackPressed 时
// evaluateJavascript 派发 'agentchat:back' CustomEvent；本模块注册
// 回调并回答「是否已消费」——壳以同步 JS 表达式的返回值判定，
// 未消费时执行默认行为（moveTaskToBack 退后台而不是 finish 杀链路）。
//
// 消费判定单源住 uiStore 派生（mobileMainOpen / 各全屏覆盖态），
// 本模块只做桥接与注册，无布局知识。
// ============================================================

const BRIDGE_EVENT = 'agentchat:back';

export interface BackConsumption {
  /** 本次返回是否被 UI 消费（true = 不退后台） */
  handled: boolean;
  /** 调试标签（日志用） */
  via?: string;
}

/** 全局消费回调（单一注册位——后注册覆盖先注册，webui 单 App 实例） */
let handler: (() => BackConsumption) | null = null;

/** 壳查询入口（evaluateJavascript 同步调用；无注册 = 未消费） */
function queryBack(): BackConsumption {
  if (!handler) return { handled: false };
  try {
    return handler();
  } catch {
    return { handled: false, via: 'handler-error' };
  }
}

/** 注册返回消费回调；返回注销函数（AppFrame 挂载时注册） */
export function registerBackHandler(fn: () => BackConsumption): () => void {
  handler = fn;
  return () => { if (handler === fn) handler = null; };
}

// window 面挂载（壳 evaluateJavascript 直呼 window.__agentchatBack()）
declare global {
  interface Window {
    __agentchatBack?: () => BackConsumption;
  }
}
if (typeof window !== 'undefined') {
  window.__agentchatBack = queryBack;
  // 事件面（等价通道——壳侧二选一，CustomEvent 利于未来扩展载荷）
  window.addEventListener(BRIDGE_EVENT, () => { queryBack(); });
}