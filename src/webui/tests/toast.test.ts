// @vitest-environment jsdom
// ============================================================
// webui/tests/toast.test.ts —— 全局 Toast 原语语义单测
//
// 覆盖（webui-kit/toast.ts——M34 统一 Toast 行为）：
//   · tone 时长分级 + duration 覆盖 + 0 永驻
//   · 同 key 去重刷新（原位更新文本/tone + 计时重置，不叠加）
//   · 缺省 key = text（同文案同样合并）
//   · 栈上限 4：超出丢弃最旧
//   · 到期出栈 / dismissToast 手动关 / clearToasts 清空
//   · pause/resume（hover 暂停：剩余时长暂存，resume 重启；归零即出栈）
//   · ToastHost 渲染：Teleport body、tone class、role=status
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import {
  toast, toastOk, toastError, toastInfo, toastBusy,
  dismissToast, clearToasts, pauseToast, resumeToast, toasts,
  ToastHost,
} from '@agentchat/webui-kit';

beforeEach(() => { clearToasts(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); clearToasts(); });

describe('tone 时长分级与自定义时长', () => {
  it('缺省时长按 tone 分级：ok 2s / info 3s / busy 4s / error 5s', () => {
    toastOk('a'); toastInfo('b'); toastBusy('c'); toastError('d');
    expect(toasts.value.length).toBe(4);
    vi.advanceTimersByTime(2000);
    expect(toasts.value.map((t) => t.text)).toEqual(['b', 'c', 'd']); // ok 出栈
    vi.advanceTimersByTime(1000);
    expect(toasts.value.map((t) => t.text)).toEqual(['c', 'd']); // info 出栈
    vi.advanceTimersByTime(1000);
    expect(toasts.value.map((t) => t.text)).toEqual(['d']); // busy 出栈
    vi.advanceTimersByTime(1000);
    expect(toasts.value.length).toBe(0); // error 出栈
  });

  it('duration 覆盖分级；0 = 永驻（不自动消失）', () => {
    toast('flash', { tone: 'error', duration: 100 });
    vi.advanceTimersByTime(100);
    expect(toasts.value.length).toBe(0);
    toast('stay', { tone: 'error', duration: 0 });
    vi.advanceTimersByTime(60_000);
    expect(toasts.value.length).toBe(1); // 永驻
    dismissToast(toasts.value[0].id);
    expect(toasts.value.length).toBe(0);
  });

  it('tone 缺省 = info', () => {
    toast('x');
    expect(toasts.value[0].tone).toBe('info');
  });
});

describe('去重合并（统一下 Toast 行为的核心语义）', () => {
  it('同 key 在场 → 原位刷新文本与 tone + 计时重置，不叠加', () => {
    toastBusy('正在备份…', { key: 'backup' });
    const id0 = toasts.value[0].id;
    vi.advanceTimersByTime(3800); // busy 4s 已走 3.8s
    toastOk('备份完成：ok.zip', { key: 'backup' }); // 刷新为 ok（重新计 2s）
    expect(toasts.value.length).toBe(1);
    expect(toasts.value[0].tone).toBe('ok');
    expect(toasts.value[0].text).toBe('备份完成：ok.zip');
    expect(toasts.value[0].id).toBe(id0); // 原条目（未重建）
    vi.advanceTimersByTime(1900);
    expect(toasts.value.length).toBe(1); // 旧计时已废——重置生效
    vi.advanceTimersByTime(100);
    expect(toasts.value.length).toBe(0);
  });

  it('缺省 key = 文本：同文案合并', () => {
    toastOk('已保存');
    toastOk('已保存');
    expect(toasts.value.length).toBe(1);
  });

  it('不同 key 互不合并', () => {
    toastError('本地打开失败：A', { key: 'open-local' });
    toastError('打开文件夹失败：B', { key: 'open-dir' });
    expect(toasts.value.length).toBe(2);
  });
});

describe('栈上限与手动管理', () => {
  it('上限 4 条：超出丢弃最旧', () => {
    for (let i = 1; i <= 6; i++) toast(`t${i}`, { key: `k${i}`, duration: 0 });
    expect(toasts.value.map((t) => t.text)).toEqual(['t3', 't4', 't5', 't6']);
  });

  it('dismissToast 关指定条；clearToasts 清空全部', () => {
    toast('a', { duration: 0 });
    toast('b', { duration: 0 });
    dismissToast(toasts.value[0].id);
    expect(toasts.value.map((t) => t.text)).toEqual(['b']);
    clearToasts();
    expect(toasts.value.length).toBe(0);
  });
});

describe('hover 暂停 / 恢复', () => {
  it('暂停冻结计时，恢复按剩余时长续走；剩余归零即出栈', () => {
    toast('long', { tone: 'info', duration: 3000 });
    const id = toasts.value[0].id;
    vi.advanceTimersByTime(1000);
    pauseToast(id);
    vi.advanceTimersByTime(60_000); // 暂停期间不出栈
    expect(toasts.value.length).toBe(1);
    resumeToast(id);
    expect(toasts.value[0].remaining).toBeNull(); // 恢复计时态
    vi.advanceTimersByTime(1999);
    expect(toasts.value.length).toBe(1); // 剩 1ms
    vi.advanceTimersByTime(1);
    expect(toasts.value.length).toBe(0);
  });

  it('暂停期间时钟流逝：resume 仍按暂停时快照的剩余时长续走', () => {
    toast('edge', { tone: 'ok', duration: 1000 });
    const id = toasts.value[0].id;
    vi.advanceTimersByTime(999);
    pauseToast(id);
    expect(toasts.value[0].remaining).toBe(1);
    vi.advanceTimersByTime(5000); // 暂停中时钟走再久也不出栈
    expect(toasts.value.length).toBe(1);
    resumeToast(id);
    expect(toasts.value.length).toBe(1); // 快照剩余 1ms，不追补
    vi.advanceTimersByTime(1);
    expect(toasts.value.length).toBe(0);
  });

  it('永驻条（duration 0）pause/resume 无副作用', () => {
    toast('stay', { duration: 0 });
    const id = toasts.value[0].id;
    pauseToast(id);
    expect(toasts.value[0].remaining).toBeNull(); // 未进暂停态
    resumeToast(id);
    expect(toasts.value.length).toBe(1);
  });

  it('未暂停条 resume 忽略', () => {
    toast('plain', { duration: 0 });
    resumeToast(toasts.value[0].id);
    expect(toasts.value.length).toBe(1);
  });
});

describe('ToastHost 渲染', () => {
  function mountHost() {
    const host = document.createElement('div');
    const app = createApp({ render: () => h(ToastHost) });
    app.mount(host);
    return () => app.unmount();
  }

  it('Teleport 到 body，tone class / aria 语义 / 文案呈现', async () => {
    const unmount = mountHost();
    toastError('出错了');
    await nextTick();
    const stack = document.querySelector('.toast-stack');
    const el = document.querySelector('.toast-item');
    expect(stack).toBeTruthy();
    expect(stack!.getAttribute('role')).toBe('status'); // aria-live 语义在栈容器
    expect(el).toBeTruthy();
    expect(el!.classList.contains('is-error')).toBe(true);
    expect(el!.textContent).toContain('出错了');
    unmount();
  });

  it('dismiss 后出栈；手动关钮触发 dismissToast', async () => {
    const unmount = mountHost();
    toast('点我关闭', { duration: 0 });
    await nextTick();
    const btn = document.querySelector('.toast-close') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    await nextTick();
    expect(toasts.value.length).toBe(0); // 栈语义出栈（leave 动画不阻塞状态）
    unmount();
  });
});
