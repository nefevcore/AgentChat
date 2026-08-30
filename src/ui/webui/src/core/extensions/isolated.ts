// ============================================================
// core/extensions/isolated.ts —— iframe isolated 档宿主（P5.5）
//
// 不信任插件档：插件 entry 在 sandbox="allow-scripts"（无
// allow-same-origin）的 iframe 内运行，opaque origin 无法直接带
// 凭据访问宿主 API。桥接只暴露：
//   · request —— 父窗口按白名单（p5.5-policy）代理，GET 只读子集
//   · onEvent  —— 父窗口按白名单转发插件生命周期事件
//   · onUnload —— 卸载回调
// 不暴露 Vue / slot 注册表 / 宿主 DOM。
// ============================================================

import type { UIExtensionDescriptor } from '@agentchat/protocol';
import { request as apiRequest } from '@/core/api/client';
import { useWebSocketStore } from '@/stores/websocket';
import { isAllowedIsolatedEvent, isAllowedIsolatedRequest } from './p5.5-policy';

export interface IsolatedExtensionHandle {
  descriptor: UIExtensionDescriptor;
  iframe: HTMLIFrameElement;
  cleanup(): void;
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

export function loadIsolatedExtension(descriptor: UIExtensionDescriptor): IsolatedExtensionHandle {
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

  // 按 type 的 WS 订阅引用计数：与 iframe 运行时（isolated-runtime.ts）的
  // "handler 数 0→1 subscribe、1→0 unsubscribe" 协议对齐——此前父侧
  // unsubscribe 是 no-op，插件每次 订阅→退订→再订阅 循环都会多挂一个
  // handler（只增不减），同一事件向 iframe 投递 N 次。
  const subscriptions = new Map<string, { dispose: () => void; count: number }>();

  const cleanup = () => {
    // 通知 iframe 逆序执行插件 disposers（iframe 删除前 postMessage）
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
    if (
      !msg
      || msg.source !== 'agentchat-ui-plugin-iframe'
      || msg.plugin !== descriptor.name
    ) {
      return;
    }

    switch (msg.kind) {
      case 'request': {
        const id = msg.id ?? 0;
        const path = msg.path ?? '';
        const method = msg.init?.method ?? 'GET';
        const headers = msg.init?.headers ?? {};
        const body = msg.init?.body ?? undefined;

        if (!isAllowedIsolatedRequest(method, path)) {
          post({
            source: 'agentchat-ui-iframe-host',
            plugin: descriptor.name,
            kind: 'response',
            id,
            ok: false,
            status: 403,
            error: `isolated request 不在白名单: ${method} ${path}`,
          });
          return;
        }

        try {
          const data = await apiRequest<unknown>(path, {
            method,
            headers,
            body: method === 'GET' ? undefined : body,
          });
          post({
            source: 'agentchat-ui-iframe-host',
            plugin: descriptor.name,
            kind: 'response',
            id,
            ok: true,
            status: 200,
            data,
          });
        } catch (err) {
          post({
            source: 'agentchat-ui-iframe-host',
            plugin: descriptor.name,
            kind: 'response',
            id,
            ok: false,
            status: 500,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      case 'subscribe': {
        if (!msg.type || !isAllowedIsolatedEvent(msg.type)) return;
        const type = msg.type;
        const existing = subscriptions.get(type);
        if (existing) {
          existing.count++;
          return;
        }
        const dispose = useWebSocketStore().onMessage((incoming, data) => {
          if (incoming !== type) return;
          post({
            source: 'agentchat-ui-iframe-host',
            plugin: descriptor.name,
            kind: 'event',
            type,
            data,
          });
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
        console.info(`[ui-ext] isolated UI 插件就绪: ${descriptor.name}@${descriptor.version}`, {
          sandbox: iframe.getAttribute('sandbox'),
        });
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

  const baseCleanup = cleanup;
  const handle: IsolatedExtensionHandle = {
    descriptor,
    iframe,
    cleanup: () => {
      window.removeEventListener('message', onMessage);
      baseCleanup();
    },
  };
  return handle;
}
