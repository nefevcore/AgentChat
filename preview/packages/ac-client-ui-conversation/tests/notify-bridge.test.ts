// ============================================================
// ac-client-ui-conversation/tests/notify-bridge.test.ts ——
// 系统通知发口（cr-291 移动端后台唤回）单测
//
// 锁定链路：
//   · Web Notification 权限已授 → 直弹（不入队列）；
//   · 未授权（安卓壳形态）→ 入 window.__agentchatNotifyQueue + dirty
//     置位（壳轮询消费）；同 tag 覆叠、上限 20 截断；
//   · node 无 window → 静默无通知（不炸）。
// 手法：全局 window 桩先于模块 import 注入（模块 import 时捕获
// globalThis.window；与 unread-restore 的 localStorage 桩同款）。
// ============================================================
import { describe, it, expect, beforeAll, vi } from 'vitest';

type Bridge = typeof import('../client/notifyBridge.ts');
type Win = {
  __agentchatNotifyQueue?: Array<{ title: string; body: string; tag: string }>;
  __agentchatNotifyDirty?: boolean;
  Notification?: { permission: string; new (t: string, o?: { body?: string; tag?: string }): unknown };
  document?: { visibilityState: string; addEventListener: (t: string, h: () => void) => void };
};

let mod: Bridge;
let win: Win;
let notifyCtor: ((t: string, o?: { body?: string; tag?: string }) => unknown) | null;

beforeAll(async () => {
  win = {};
  (globalThis as unknown as { window: unknown }).window = win;
  mod = await import('../client/notifyBridge.ts');
});

describe('notifyBridge：壳桥队列形态（未授权 = 安卓壳）', () => {
  it('入队 + dirty 置位；同 tag 覆叠（连发只留最新）', () => {
    mod.notifyUser({ title: '甲', body: '一', tag: 'pair:user|alpha' });
    mod.notifyUser({ title: '甲', body: '二', tag: 'pair:user|alpha' });
    expect(win.__agentchatNotifyQueue).toHaveLength(1);
    expect(win.__agentchatNotifyQueue![0].body).toBe('二');
    expect(win.__agentchatNotifyDirty).toBe(true);
  });

  it('不同 tag 各自入队；上限 20 截旧', () => {
    win.__agentchatNotifyQueue = [];
    for (let i = 0; i < 25; i++) {
      mod.notifyUser({ title: 't', body: String(i), tag: `tag-${i}` });
    }
    expect(win.__agentchatNotifyQueue).toHaveLength(20);
    expect(win.__agentchatNotifyQueue![0].body).toBe('5'); // 最旧的 5 条被截
    expect(win.__agentchatNotifyQueue!.at(-1)!.body).toBe('24');
  });
});

describe('notifyBridge：Web Notification 直弹（已授权）', () => {
  it('granted → 构造 Notification，不入队列', () => {
    notifyCtor = vi.fn();
    win.__agentchatNotifyQueue = [];
    win.Notification = { permission: 'granted', } as Win['Notification'];
    // 构造器绑定：notifyBridge 经 new N(title, opts) 调用
    (win.Notification as unknown as { new (t: string, o?: unknown): unknown }) = class {
      constructor(t: string, o?: unknown) { notifyCtor?.(t, o as never); }
    };
    Object.defineProperty(win.Notification, 'permission', { value: 'granted' });
    mod.notifyUser({ title: '甲', body: '直弹', tag: 'x' });
    expect(notifyCtor).toHaveBeenCalledWith('甲', { body: '直弹', tag: 'x' });
    expect(win.__agentchatNotifyQueue).toHaveLength(0);
  });
});

describe('notifyBridge：pageHidden 判定', () => {
  it('document.visibilityState 投影', () => {
    let listener: (() => void) | null = null;
    win.document = {
      visibilityState: 'hidden',
      addEventListener: (_t, h) => { listener = h; },
    };
    // pageHidden 直读当前态
    expect(mod.pageHidden()).toBe(true);
    win.document.visibilityState = 'visible';
    expect(mod.pageHidden()).toBe(false);
  });
});