// ============================================================
// toast.ts —— 全局 Toast 命令式原语（模块级单例栈）
//
// 定位（webui-slot-tree ⑥ global 候选 global:toast 的原语半件）：
//   全 UI 唯一瞬时反馈通道。此前各面板自制十几套「ref + setTimeout
//   短暂反馈」（时长 1500/2000/3000/3500/5000 各异、互踩、菜单关闭即
//   丢），本模块统一收编：tone 语义（与 FeedbackNotice 同轴）、时长
//   按 tone 分级、同 key 刷新去重、栈上限、hover 暂停。
//
// 行为约定：
//   · 时长分级（缺省，ms）：ok=2000 / info=3000 / busy=4000 / error=5000
//     （error 面向长错误文本，阅读时间最长；duration:0 = 永驻手动关）
//   · 去重合并：同 key（缺省 = text）在场 → 原位刷新该条（文本/tone
//     更新 + 计时重置），不叠加——连续触发不再互踩或多条刷屏
//   · 栈上限 4 条：超出丢弃最旧（新反馈优先）
//   · hover 暂停：ToastHost mouseenter/mouseleave 调 pauseToast/
//     resumeToast，暂停时剩余时长暂存（resume 重启计时）
//
// 渲染半件 = ToastHost.vue（AppFrame 挂载一次）；本文件零 DOM 依赖，
// node 环境可测。与 FeedbackNotice 的分工：FeedbackNotice = 原地
// 嵌入式反馈条（输入区/菜单内），toast = 脱离调用点上下文的全局层。
// ============================================================
import { ref } from 'vue';

export type ToastTone = 'ok' | 'error' | 'info' | 'busy';

export interface ToastOptions {
  /** 语义态（决定图标与配色——与 FeedbackNotice 同轴） */
  tone?: ToastTone;
  /** 停留时长 ms；0 = 不自动消失；缺省按 tone 分级 */
  duration?: number;
  /** 去重键（缺省 = text）：同 key 在场时原位刷新而非叠加 */
  key?: string;
}

export interface ToastItem {
  id: number;
  /** 去重键（缺省 = text） */
  key: string;
  text: string;
  tone: ToastTone;
  /** 自动消失截止时刻（Date.now()）；0 = 永驻 */
  deadline: number;
  /** 暂停时暂存的剩余时长（ms）；null = 计时进行中 / 永驻 */
  remaining: number | null;
}

/** 缺省时长分级（ms）——error 最长（长错误文本阅读时间），ok 最短 */
const TONE_DURATION: Record<ToastTone, number> = { ok: 2000, info: 3000, busy: 4000, error: 5000 };

/** 栈上限：超出丢弃最旧 */
const MAX_STACK = 4;

/** 全局 Toast 栈（模块级单例——App 内唯一，ToastHost 渲染） */
export const toasts = ref<ToastItem[]>([]);

let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** 命令式写口：弹一条 toast（同 key 在场 → 原位刷新 + 计时重置） */
export function toast(text: string, opts: ToastOptions = {}): void {
  const tone = opts.tone ?? 'info';
  const duration = opts.duration ?? TONE_DURATION[tone];
  const key = opts.key ?? text;

  const existing = toasts.value.find((t) => t.key === key);
  if (existing) {
    // 原位刷新：文本/tone 更新 + 计时重置（连续触发不叠加不互踩）
    clearTimeout(timers.get(existing.id)!);
    timers.delete(existing.id);
    existing.text = text;
    existing.tone = tone;
    existing.deadline = duration === 0 ? 0 : Date.now() + duration;
    existing.remaining = null;
    schedule(existing.id, duration);
    return;
  }

  // 栈上限：丢弃最旧
  while (toasts.value.length >= MAX_STACK) dismissToast(toasts.value[0].id);

  const item: ToastItem = {
    id: ++seq,
    key,
    text,
    tone,
    deadline: duration === 0 ? 0 : Date.now() + duration,
    remaining: null,
  };
  toasts.value.push(item);
  schedule(item.id, duration);
}

/** 便捷别名（语义态直呼） */
export const toastOk = (text: string, opts?: ToastOptions) => toast(text, { ...opts, tone: 'ok' });
export const toastError = (text: string, opts?: ToastOptions) => toast(text, { ...opts, tone: 'error' });
export const toastInfo = (text: string, opts?: ToastOptions) => toast(text, { ...opts, tone: 'info' });
export const toastBusy = (text: string, opts?: ToastOptions) => toast(text, { ...opts, tone: 'busy' });

function schedule(id: number, duration: number): void {
  if (duration === 0) return; // 永驻
  timers.set(id, setTimeout(() => dismissToast(id), duration));
}

/** 手动关闭 / 到期出栈 */
export function dismissToast(id: number): void {
  clearTimeout(timers.get(id)!);
  timers.delete(id);
  const i = toasts.value.findIndex((t) => t.id === id);
  if (i >= 0) toasts.value.splice(i, 1);
}

/** 清空全部（测试隔离 / 场景切换兜底） */
export function clearToasts(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  toasts.value = [];
}

/** hover 暂停：停表并暂存剩余时长（永驻条忽略） */
export function pauseToast(id: number): void {
  const t = toasts.value.find((x) => x.id === id);
  if (!t || t.deadline === 0 || t.remaining !== null) return;
  clearTimeout(timers.get(id)!);
  timers.delete(id);
  t.remaining = Math.max(0, t.deadline - Date.now());
}

/** 恢复计时：按暂存剩余时长重启（永驻/未暂停条忽略） */
export function resumeToast(id: number): void {
  const t = toasts.value.find((x) => x.id === id);
  if (!t || t.remaining === null) return;
  const remaining = t.remaining;
  t.remaining = null;
  if (remaining === 0) { dismissToast(id); return; }
  t.deadline = Date.now() + remaining;
  schedule(id, remaining);
}
