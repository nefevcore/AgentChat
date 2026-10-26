// ============================================================
// isolated.ts —— iframe isolated 档宿主半边（8.5 收尾批；主线
// apps/ui/src/core/extensions/isolated.ts 的 preview 平移）
//
// 不信任插件档：entry 在 sandbox="allow-scripts"（无 allow-same-origin）
// 的 iframe 内运行，opaque origin 无法直接带凭据访问宿主 API。桥接只
// 暴露 request（白名单代理）/ onEvent（白名单转发）/ onUnload——不暴露
// Vue / slot 注册表 / 宿主 DOM。
//
// 与主线的差异：request 代理走 ctx.rpc.call（主线经 @/core/api/client
// fetch——preview web-api 薄 RPC 面即传输；白名单端点集经 rpc 面
// registerRpc 注册的 GET 语义端点，方法恒 GET）。事件转发经 rpc wire
// onEvent（8.5e rpc-wire 事件帧直转——主线 wireRpc.onWireEvent 同位）。
// ============================================================
import type { ClientContext } from 'ac-client-runtime';
import { isAllowedIsolatedEvent, isAllowedIsolatedRequest } from 'ac-webui-core';

export interface IsolatedExtensionDescriptor {
  name: string;
  version: string;
  entry: string;
}

export interface IsolatedExtensionHandle {
  descriptor: IsolatedExtensionDescriptor;
  iframe: HTMLIFrameElement;
  cleanup(): void;
  /**
   * 视角承载挂载（B3 隔离档）：iframe 移入宿主 DOM 承载容器并可见
   * （aria-hidden 摘除 + 0×0 屏幕外定位撤除——设为常规填充流）。
   * 幂等：同容器重复挂载零操作。
   */
  mountTo(container: HTMLElement): void;
  /** 承载卸载（回到屏幕外隐藏态——B3 承载面的让位形态） */
  unmountFrom(): void;
  /** 注册 cleanup 时随 iframe 一并执行的回调（B3 视角 disposer 收割面） */
  onDestroy(fn: () => void): void;
}

interface IframeMessage {
  source: 'agentchat-ui-plugin-iframe' | 'agentchat-ui-iframe-host';
  plugin: string;
  kind: 'request' | 'response' | 'subscribe' | 'unsubscribe' | 'event' | 'ready' | 'error';
  id?: number;
  path?: string;
  type?: string;
  data?: unknown;
  init?: { method?: string; headers?: Record<string, string>; body?: string | null };
  ok?: boolean;
  status?: number;
  error?: string;
}

export function loadIsolatedExtension(ctx: ClientContext, descriptor: IsolatedExtensionDescriptor): IsolatedExtensionHandle {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts'); // 无 allow-same-origin → opaque origin
  iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute('aria-hidden', 'true');
  // 不用 display:none（部分浏览器不创建隐藏 frame 树），改为屏幕外 0×0
  iframe.style.position = 'fixed';
  iframe.style.left = '-9999px';
  iframe.style.top = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.dataset.uiIsolated = descriptor.name;
  iframe.src = `/ui-plugin-iframe.html?name=${encodeURIComponent(descriptor.name)}`
    + `&entry=${encodeURIComponent(descriptor.entry)}`
    + `&version=${encodeURIComponent(descriptor.version)}`;

  // 按 type 的引用计数订阅：与 iframe 运行时（ac-client-runtime isolated-runtime
  // 的 "handler 数 0→1 subscribe、1→0 unsubscribe" 协议对齐——父侧 unsubscribe
  // 不落地则循环订阅泄漏 handler
  const subscriptions = new Map<string, { dispose: () => void; count: number }>();

  const cleanup = () => {
    try {
      iframe.contentWindow?.postMessage({
        source: 'agentchat-ui-plugin-iframe',
        plugin: descriptor.name,
        kind: 'unload',
      }, '*');
    } catch { /* ignore */ }
    for (const { dispose } of subscriptions.values()) {
      try { dispose(); } catch { /* ignore */ }
    }
    subscriptions.clear();
    for (const fn of destroyFns) {
      try { fn(); } catch { /* ignore */ }
    }
    destroyFns.length = 0;
    iframe.remove();
  };

  const post = (message: Record<string, unknown>) => {
    try {
      iframe.contentWindow?.postMessage(message, '*');
    } catch { /* ignore */ }
  };

  const onMessage = async (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data as IframeMessage | undefined;
    if (!msg || msg.source !== 'agentchat-ui-plugin-iframe' || msg.plugin !== descriptor.name) return;

    switch (msg.kind) {
      case 'request': {
        const id = msg.id ?? 0;
        const path = msg.path ?? '';
        const method = msg.init?.method ?? 'GET';
        if (!isAllowedIsolatedRequest(method, path)) {
          post({ source: 'agentchat-ui-iframe-host', plugin: descriptor.name, kind: 'response', id, ok: false, status: 403,
            error: `isolated request 不在白名单: ${method} ${path}` });
          return;
        }
        try {
          // 白名单端点在 preview web-api 面 = registerRpc 端点（GET 语义）；
          // 方法名 = 路径斜杠形态（/api/x/y → x/y 的 rpc 方法形态由宿主
          // registerRpc 域面承载——见 web-api.ts 各端点注册）。isolated
          // 白名单只放只读 GET 端点，body 恒空。
          const data = await ctx.rpc.call<unknown>(rpcMethodFor(path));
          post({ source: 'agentchat-ui-iframe-host', plugin: descriptor.name, kind: 'response', id, ok: true, status: 200, data });
        } catch (err) {
          post({ source: 'agentchat-ui-iframe-host', plugin: descriptor.name, kind: 'response', id, ok: false, status: 500,
            error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      case 'subscribe': {
        if (!msg.type || !isAllowedIsolatedEvent(msg.type)) return;
        const type = msg.type;
        const existing = subscriptions.get(type);
        if (existing) { existing.count++; return; }
        const dispose = ctx.rpc.onEvent((incoming, args) => {
          if (incoming !== type) return;
          post({ source: 'agentchat-ui-iframe-host', plugin: descriptor.name, kind: 'event', type, data: args[0] });
        });
        subscriptions.set(type, { dispose, count: 1 });
        return;
      }
      case 'unsubscribe': {
        const type = msg.type;
        if (!type) return;
        const sub = subscriptions.get(type);
        if (!sub) return;
        sub.count--;
        if (sub.count <= 0) {
          subscriptions.delete(type);
          try { sub.dispose(); } catch { /* ignore */ }
        }
        return;
      }
      case 'ready': {
        console.info(`[ui-ext] isolated UI 插件就绪: ${descriptor.name}@${descriptor.version}`, { sandbox: iframe.getAttribute('sandbox') });
        return;
      }
      case 'error': {
        console.warn(`[ui-ext] isolated UI 插件报错: ${descriptor.name}`, msg.error);
        return;
      }
    }
  };

  window.addEventListener('message', onMessage);
  document.body.appendChild(iframe);

  let mountedContainer: HTMLElement | null = null;
  const destroyFns: Array<() => void> = [];
  /** 隐藏态定位（cleanup 复位用）：iframe 常驻 body、承载时移入容器 */
  function mountTo(container: HTMLElement): void {
    if (mountedContainer === container) return; // 幂等
    if (mountedContainer) unmountFrom();
    iframe.setAttribute('aria-hidden', 'false');
    iframe.style.position = 'static';
    iframe.style.left = 'auto';
    iframe.style.top = 'auto';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    container.appendChild(iframe);
    mountedContainer = container;
  }
  function unmountFrom(): void {
    if (!mountedContainer) return;
    document.body.appendChild(iframe); // 回 body 寄存（隐藏态基准——cleanup 才真移除）
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.position = 'fixed';
    iframe.style.left = '-9999px';
    iframe.style.top = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    mountedContainer = null;
  }

  const handle: IsolatedExtensionHandle = {
    descriptor,
    iframe,
    cleanup: () => {
      window.removeEventListener('message', onMessage);
      cleanup();
    },
    mountTo,
    unmountFrom,
    onDestroy: (fn: () => void) => { destroyFns.push(fn); },
  };
  return handle;
}

/** 白名单路径 → rpc 方法名（/api/ui/extensions → ui/extensions 形态——宿主注册面） */
function rpcMethodFor(path: string): string {
  return path.replace(/^\/api\//, '');
}
