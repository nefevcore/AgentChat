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

  const eventDisposers: Array<() => void> = [];

  const cleanup = () => {
    // 通知 iframe 逆序执行插件 disposers（iframe 删除前 postMessage）
    try {
      iframe.contentWindow?.postMessage({
        source: 'agentchat-ui-plugin-iframe',
        plugin: descriptor.name,
        kind: 'unload',
      }, '*');
    } catch { /* ignore */ }
    for (const dispose of eventDisposers) {
      try { dispose(); } catch { /* ignore */ }
    }
    eventDisposers.length = 0;
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
        eventDisposers.push(useWebSocketStore().onMessage((incoming, data) => {
          if (incoming !== type) return;
          post({
            source: 'agentchat-ui-iframe-host',
            plugin: descriptor.name,
            kind: 'event',
            type,
            data,
          });
        }));
        return;
      }

      case 'unsubscribe': {
        // 事件 disposer 由 cleanup 统一回收；此处仅接受消息（父侧不强拆，避免竞态）
        void msg.type;
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
