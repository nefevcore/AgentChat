// ============================================================
// ac-client-ui-conversation/client/notifyBridge.ts —— 系统通知
// 发口（cr-291 移动端后台唤回）
//
// 触发面：Agent 私信到达（showInbound）、独立会话/直答 run 收束
//（loop/after-run finish='stop'）——用户不在看时（页面后台或非当前
// 会话）经系统通知唤回。双通道：
//   · Web Notification API（桌面浏览器/已授权壳）直弹；
//   · 安卓壳桥队列（window.__agentchatNotifyQueue + dirty 置位）：壳内
//     WebView 后台被节流、Web Notification 因 POST_NOTIFICATIONS 未授
//     权不可用——壳的前台服务常驻（cr-109），1s 轮询队列经原生
//     NotificationManager 弹系统通知（独立 channel）。与
//     __agentchatBootReady（cr-274）同款 evaluateJavascript 桥姿势。
//
// 归位：读方 = feed-core 触发点（唯一写方），住 conversation 行 client，
// 与 unreadStore 同款裁决（客户端 UI 增益态，不进后端）；不引 DOM lib
// ——浏览器面经结构化类型访问（本包进根 tsc 程序），node 测试环境
// undefined → 静默无通知。
// ============================================================

/** 通知载荷（桥序列化面：title/body/tag——壳侧 JSON 直读） */
export interface NotifyPayload {
  title: string;
  body: string;
  /** 同 tag 覆叠（会话维度聚合：连发消息只留最新一条） */
  tag: string;
}

const QUEUE_MAX = 20;

/** 结构化 window 面（node 环境缺省 undefined——try/catch 兜底） */
interface WindowLike {
  __agentchatNotifyQueue?: NotifyPayload[];
  __agentchatNotifyDirty?: boolean;
  Notification?: { permission: string; new (title: string, opts?: { body?: string; tag?: string }): unknown };
  document?: { visibilityState: string; addEventListener(type: string, h: () => void): void };
}
const win: WindowLike | undefined = (globalThis as { window?: WindowLike }).window;

/** 队列挂载（幂等）：壳在位与否不影响 webui 自身运行 */
function ensureQueue(): NotifyPayload[] | undefined {
  if (!win) return undefined;
  if (!Array.isArray(win.__agentchatNotifyQueue)) win.__agentchatNotifyQueue = [];
  return win.__agentchatNotifyQueue;
}

/** 页面隐藏（后台/锁屏）——通知的前提（前台看得见不打扰） */
export function pageHidden(): boolean {
  try {
    return typeof win?.document?.visibilityState === 'string'
      ? win.document.visibilityState !== 'visible'
      : false;
  } catch {
    return false;
  }
}

/**
 * 发系统通知：权限已授走 Web Notification（桌面端）；否则入壳桥队列
 * （安卓壳轮询消费）。同 tag 原位覆叠 + 上限截断（旧丢弃——最新消息
 * 优先于历史完整性）。任一失败静默降级：通知是增益通道，不构成主链路。
 */
export function notifyUser(payload: NotifyPayload): void {
  try {
    const N = win?.Notification;
    if (N && N.permission === 'granted') {
      new N(payload.title, { body: payload.body, tag: payload.tag });
      return;
    }
    const q = ensureQueue();
    if (!q) return;
    const idx = q.findIndex((n) => n.tag === payload.tag);
    if (idx >= 0) q.splice(idx, 1);
    q.push(payload);
    if (q.length > QUEUE_MAX) q.splice(0, q.length - QUEUE_MAX);
    win!.__agentchatNotifyDirty = true;
  } catch {
    /* 通知失败静默——不影响会话主链路 */
  }
}

/** 页面回前台清脏标记（壳轮询见 dirty=false 跳过，避免重复消费） */
function clearDirty(): void {
  try {
    if (win) win.__agentchatNotifyDirty = false;
  } catch { /* ignore */ }
}

// 前台化即清脏（与 wire resumeFromBackground 同事件源；多监听无冲突）
if (win?.document && typeof win.document.addEventListener === 'function') {
  win.document.addEventListener('visibilitychange', () => {
    if (win.document?.visibilityState === 'visible') clearDirty();
  });
}