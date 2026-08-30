// ============================================================
// src/isolated-runtime.ts —— iframe isolated 档运行时（P5.5）
//
// 由 ui-plugin-iframe.html 以 <script type="module"> 加载，
// 在 sandbox="allow-scripts"（无 allow-same-origin）的 iframe 内运行。
//
// 信任模型（docs/ui-web-pluginization-plan.md §7.9.6）：
//   · 不暴露 Vue / slot 注册表 / DOM 宿主；
//   · request 只经 postMessage 回父窗口，父窗口按白名单校验后代理；
//   · 事件订阅只经父窗口转发白名单类型；
//   · 插件若需要可见 UI，可自行在 iframe 文档内渲染（能力自限于 iframe）。
// ============================================================

interface ParentRequestMessage {
  source: 'agentchat-ui-plugin-iframe';
  plugin: string;
  kind: 'request';
  id: number;
  path: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
  };
}

interface ParentEventMessage {
  source: 'agentchat-ui-plugin-iframe';
  plugin: string;
  kind: 'event';
  type: string;
  data: unknown;
}

interface ParentUnloadMessage {
  source: 'agentchat-ui-plugin-iframe';
  plugin: string;
  kind: 'unload';
}

interface InboundHostMessage {
  source: 'agentchat-ui-iframe-host';
  plugin: string;
  kind: 'response' | 'event';
  id?: number;
  type?: string;
  data?: unknown;
  ok?: boolean;
  status?: number;
  error?: string;
}

type Disposer = () => void;

const params = new URLSearchParams(window.location.search);
const pluginName = params.get('name') ?? '';
const entryPath = params.get('entry') ?? '';
const version = params.get('version') ?? '';

function postToParent(message: object): void {
  window.parent.postMessage(message, '*');
}

function fail(message: string): void {
  console.error(`[ui-iframe] ${message}`);
  document.body.textContent = `isolated plugin failed: ${message}`;
  // source 必须是 plugin-iframe（宿主侧 isolated.ts 的过滤器只认这个常量，
  // 此前误写 iframe-host → 宿主永远收不到加载失败通知，失败完全静默）
  postToParent({ source: 'agentchat-ui-plugin-iframe', plugin: pluginName, kind: 'error', error: message });
}

// ---- request：父窗口白名单代理（iframe 内不做自行 fetch，也没有 connect 能力） ----
let requestSeq = 0;
const pendingRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

async function request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const id = ++requestSeq;
  const body = typeof init.body === 'string' ? init.body : null;
  const headers: Record<string, string> = {};
  if (init.headers) {
    if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) headers[k] = v;
    } else if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => { headers[key] = value; });
    } else {
      Object.assign(headers, init.headers);
    }
  }
  const msg: ParentRequestMessage = {
    source: 'agentchat-ui-plugin-iframe',
    plugin: pluginName,
    kind: 'request',
    id,
    path,
    init: { method: init.method ?? 'GET', headers, body },
  };
  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    postToParent(msg);
    setTimeout(() => {
      if (pendingRequests.delete(id)) reject(new Error('isolated request timeout'));
    }, 10_000);
  });
}

// ---- 事件订阅：父窗口按白名单转发（受控 postMessage） ----
const eventHandlers = new Map<string, Set<(data: unknown) => void>>();

function onEvent(type: string, handler: (data: unknown) => void): Disposer {
  let set = eventHandlers.get(type);
  if (!set) {
    set = new Set();
    eventHandlers.set(type, set);
    postToParent({ source: 'agentchat-ui-plugin-iframe', plugin: pluginName, kind: 'subscribe', type });
  }
  set.add(handler);
  return () => {
    set?.delete(handler);
    if (set && set.size === 0) {
      eventHandlers.delete(type);
      postToParent({ source: 'agentchat-ui-plugin-iframe', plugin: pluginName, kind: 'unsubscribe', type });
    }
  };
}

function dispatchEvent(type: string, data: unknown): void {
  for (const handler of eventHandlers.get(type) ?? []) {
    try {
      handler(data);
    } catch (err) {
      console.error(`[ui-iframe] 插件 "${pluginName}" 的事件处理器抛错`, err);
    }
  }
}

// ---- 受限桥接：只暴露 request/onEvent/onUnload，无 Vue/注册表 ----
interface IsolatedUiExtensionContext {
  name: string;
  request<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  onEvent(type: string, handler: (data: unknown) => void): Disposer;
  onUnload(fn: Disposer): void;
}

interface IsolatedUiExtensionModule {
  install?: (ctx: IsolatedUiExtensionContext) => void | Disposer | Promise<void | Disposer>;
}

async function boot(): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(pluginName)) {
    fail(`非法插件名: ${pluginName}`);
    return;
  }
  const prefix = `/ui-plugin/${pluginName}/`;
  if (!entryPath.startsWith(prefix) || entryPath.includes('..')) {
    fail(`非法入口: ${entryPath}`);
    return;
  }

  const url = `${entryPath}?v=${encodeURIComponent(version)}`;
  let module: IsolatedUiExtensionModule;
  try {
    module = (await import(/* @vite-ignore */ url)) as IsolatedUiExtensionModule;
  } catch (err) {
    fail(`入口加载失败: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (typeof module.install !== 'function') {
    fail(`入口缺少 install(ctx) 函数: ${entryPath}`);
    return;
  }

  const unloaders: Disposer[] = [];
  const ctx: IsolatedUiExtensionContext = {
    name: pluginName,
    request,
    onEvent,
    onUnload(fn) {
      unloaders.push(fn);
    },
  };

  try {
    const returned = await module.install(ctx);
    if (typeof returned === 'function') unloaders.push(returned);
    console.info(`[ui-iframe] 已加载 isolated UI 插件: ${pluginName}@${version}`);
    postToParent({ source: 'agentchat-ui-plugin-iframe', plugin: pluginName, kind: 'ready', ok: true });
  } catch (err) {
    for (let i = unloaders.length - 1; i >= 0; i--) {
      try { unloaders[i](); } catch { /* ignore */ }
    }
    fail(`install() 失败: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 父窗口卸载：先执行返回的 disposer 与 onUnload，再由父窗口移除 iframe
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const msg = event.data as Partial<ParentUnloadMessage> | undefined;
    if (msg?.source !== 'agentchat-ui-plugin-iframe' || msg.plugin !== pluginName) return;
    if (msg.kind === 'unload') {
      for (let i = unloaders.length - 1; i >= 0; i--) {
        try { unloaders[i](); } catch (err) {
          console.error(`[ui-iframe] unload disposer 抛错: ${pluginName}`, err);
        }
      }
      unloaders.length = 0;
    }
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const msg = event.data as InboundHostMessage | undefined;
  if (msg?.source !== 'agentchat-ui-iframe-host' || msg.plugin !== pluginName) return;
  if (msg.kind === 'response' && typeof msg.id === 'number') {
    const pending = pendingRequests.get(msg.id);
    if (!pending) return;
    pendingRequests.delete(msg.id);
    if (msg.ok) pending.resolve(msg.data);
    else pending.reject(new Error(msg.error ?? `request failed (${msg.status})`));
  } else if (msg.kind === 'event' && typeof msg.type === 'string') {
    dispatchEvent(msg.type, msg.data);
  }
});

void boot();
