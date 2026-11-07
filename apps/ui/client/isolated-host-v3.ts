// ============================================================
// isolated-host-v3.ts —— isolated 档 v3 壳侧宿主（cr-934；webui-v3
// §4.6 裁决八：sandbox iframe 独立模块表 + 自含产物——不进主文档物化面）
//
// 与旧链（已删：ui-plugin-iframe.html + isolated-runtime 双份）的差异：
// iframe 不再加载宿主静态入口，而是 srcdoc 内联自举文档——极简
// ClientModuleSystem 等价物（__ModuleLoader__.load 注册表 + 同步 require，
// 无种子——§4.4 定界：沙盒内无种子 = 既有安全边界）+ <script src=entry>
//（revision URL，自含 bundle）→ require(rowId) 物化 → default.install(ctx)。
// postMessage 桥协议与旧链逐语义一致（source/kind 词汇不动）：request 经
// 父窗白名单代理（fetch——只读 GET 子集）、onEvent 经父窗白名单转发
//（isAllowedIsolatedEvent 单源）、onUnload 随 cleanup 收割。
// ============================================================
import { defineComponent, h, onUnmounted } from 'vue';
import type { ClientContext } from 'ac-client-runtime';
import { isAllowedIsolatedEvent } from 'ac-webui-core/browser';
import type { WireRow } from 'ac-webui-core';
import { hostUrl } from './host-endpoint.ts';

/**
 * v3 isolated request 白名单（§4.6）：只读 GET 子集，路径前缀 /api/ 与
 * /ui-asset/（旧链白名单是端点枚举形态，v3 产物寻址全走 /ui-asset/——
 * 前缀形态覆盖面收紧于端点枚举之外的资产面）。
 */
const ISOLATED_REQUEST_PREFIXES = ['/api/', '/ui-asset/'];

export function isAllowedIsolatedRequestV3(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  const normalized = path.split('?')[0] ?? '';
  return ISOLATED_REQUEST_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** srcdoc 自举文档输入（entryUrl 须绝对 URL——CSP origin 词与跨源部署寻址单源） */
export interface IsolatedDocInput {
  id: string;
  entryUrl: string;
}

/** JSON 嵌入词（< 转义——防早闭合 <script> 注入面） */
const embed = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * 自举文档生成（纯函数——jsdom 不跑 iframe 脚本，语义靠字串断言 +
 * 本函数可单测）。三段：① 极简模块表（注册 + 同步 require，未命中
 * loud throw）② 受限桥（request/onEvent/onUnload——无 Vue/无宿主 DOM）。
 * ③ entry script 到达 → require(rowId) → default.install(ctx)。
 */
export function generateIsolatedDoc(input: IsolatedDocInput): string {
  let scriptOrigin = "'self'";
  try {
    scriptOrigin = new URL(input.entryUrl).origin;
  } catch { /* 相对路径（同源托管）——'self' 即宿主源 */ }
  const csp = "default-src 'none'; script-src 'unsafe-inline' " + scriptOrigin + '; '
    + "style-src 'unsafe-inline'; img-src " + scriptOrigin + ' data:; '
    + "base-uri 'none'; form-action 'none'";
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n'
    + '<meta http-equiv="Content-Security-Policy" content=' + JSON.stringify(csp) + '>\n'
    + '<title>AgentChat isolated 容器</title>\n</head>\n<body>\n<script>\n'
    + BOOTSTRAP_SCRIPT
      .replace('__PLUGIN_ID__', embed(input.id))
      .replace('__ENTRY_URL__', embed(input.entryUrl))
    + '\n</script>\n</body>\n</html>\n';
}

/**
 * iframe 内自举脚本（宿主生成、沙盒内执行）。语义对齐 module-system.ts
 * 的 ④ 支（factory 注册 → 同步物化）与旧 isolated-runtime 桥协议；
 * 无种子支（自含 bundle 的依赖全打包在内——裁决八）。
 */
const BOOTSTRAP_SCRIPT = `(function () {
  'use strict';
  var PLUGIN = __PLUGIN_ID__;
  var ENTRY = __ENTRY_URL__;
  // ---- 极简 ClientModuleSystem 等价物（独立模块表，无种子） ----
  var factories = new Map();
  var memo = new Map();
  var materializing = new Set();
  window.__ModuleLoader__ = {
    load: function (reg) {
      if (!reg || typeof reg.id !== 'string' || typeof reg.factory !== 'function') {
        throw new Error('__ModuleLoader__.load 注册形非法（须 { id, factory }）');
      }
      factories.set(reg.id, reg.factory);
    },
  };
  function acRequire(spec) {
    if (memo.has(spec)) return memo.get(spec);
    var factory = factories.get(spec);
    if (factory === undefined) {
      throw new Error('模块不可解析（isolated 独立模块表未命中注册表）：' + spec);
    }
    if (materializing.has(spec)) throw new Error('模块环：' + spec);
    materializing.add(spec);
    try {
      var exports = factory(function (dep) { return acRequire(dep); });
      memo.set(spec, exports);
      return exports;
    } finally {
      materializing.delete(spec);
    }
  }
  // ---- 受限桥：request（父窗白名单代理）/ onEvent（父窗白名单转发）/ onUnload ----
  function postToParent(message) {
    message.source = 'agentchat-ui-plugin-iframe';
    message.plugin = PLUGIN;
    parent.postMessage(message, '*');
  }
  function fail(message) {
    console.error('[ui-iframe] ' + message);
    document.body.textContent = 'isolated plugin failed: ' + message;
    postToParent({ kind: 'error', error: message });
  }
  var requestSeq = 0;
  var pendingRequests = new Map();
  function request(path, init) {
    init = init || {};
    var id = ++requestSeq;
    var headers = {};
    var given = init.headers;
    if (Array.isArray(given)) {
      for (var i = 0; i < given.length; i++) headers[given[i][0]] = given[i][1];
    } else if (given && typeof given.forEach === 'function') {
      given.forEach(function (value, key) { headers[key] = value; });
    } else if (given) {
      Object.assign(headers, given);
    }
    return new Promise(function (resolve, reject) {
      pendingRequests.set(id, { resolve: resolve, reject: reject });
      postToParent({ kind: 'request', id: id, path: path,
        init: { method: init.method || 'GET', headers: headers, body: typeof init.body === 'string' ? init.body : null } });
      setTimeout(function () {
        if (pendingRequests.delete(id)) reject(new Error('isolated request timeout'));
      }, 10000);
    });
  }
  var eventHandlers = new Map();
  function onEvent(type, handler) {
    var set = eventHandlers.get(type);
    if (!set) {
      set = new Set();
      eventHandlers.set(type, set);
      postToParent({ kind: 'subscribe', type: type });
    }
    set.add(handler);
    return function () {
      set.delete(handler);
      if (set.size === 0) {
        eventHandlers.delete(type);
        postToParent({ kind: 'unsubscribe', type: type });
      }
    };
  }
  var unloaders = [];
  var ctx = {
    name: PLUGIN,
    request: request,
    onEvent: onEvent,
    onUnload: function (fn) { unloaders.push(fn); },
  };
  function runUnloaders() {
    for (var i = unloaders.length - 1; i >= 0; i--) {
      try { unloaders[i](); } catch (err) { console.error('[ui-iframe] unload disposer 抛错', err); }
    }
    unloaders.length = 0;
  }
  addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var msg = event.data;
    if (!msg || msg.source !== 'agentchat-ui-iframe-host' || msg.plugin !== PLUGIN) return;
    if (msg.kind === 'response' && typeof msg.id === 'number') {
      var pending = pendingRequests.get(msg.id);
      if (!pending) return;
      pendingRequests.delete(msg.id);
      if (msg.ok) pending.resolve(msg.data);
      else pending.reject(new Error(msg.error || ('request failed (' + msg.status + ')')));
    } else if (msg.kind === 'event' && typeof msg.type === 'string') {
      eventHandlers.get(msg.type)?.forEach(function (handler) {
        try { handler(msg.data); } catch (err) { console.error('[ui-iframe] 插件事件处理器抛错', err); }
      });
    } else if (msg.kind === 'unload') {
      runUnloaders();
    }
  });
  // ---- 装载行 bundle → require(rowId) 物化 → default.install(ctx) ----
  var script = document.createElement('script');
  script.src = ENTRY;
  script.onerror = function () { fail('入口加载失败：' + ENTRY); };
  script.onload = function () {
    try {
      var mod = acRequire(PLUGIN);
      var plugin = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
      var install = typeof plugin === 'function' ? plugin
        : plugin && typeof plugin.install === 'function' ? plugin.install : null;
      if (!install) throw new Error('入口缺少 install(ctx)（isolated 契约：request/onEvent/onUnload）');
      Promise.resolve(install(ctx)).then(function (returned) {
        if (typeof returned === 'function') unloaders.push(returned);
        console.info('[ui-iframe] 已加载 isolated UI 插件：' + PLUGIN);
        postToParent({ kind: 'ready', ok: true });
      }, function (err) {
        runUnloaders();
        fail('install() 失败：' + (err && err.message ? err.message : String(err)));
      });
    } catch (err) {
      fail('物化失败：' + (err && err.message ? err.message : String(err)));
    }
  };
  document.body.appendChild(script);
})();`;

// ---------------- 父窗宿主半边 ----------------

/** postMessage 桥消息形（旧链词汇原样——source/kind 与 iframe 侧对齐） */
interface IframeMessage {
  source: 'agentchat-ui-plugin-iframe' | 'agentchat-ui-iframe-host';
  plugin: string;
  kind: 'request' | 'response' | 'subscribe' | 'unsubscribe' | 'event' | 'ready' | 'error' | 'unload';
  id?: number;
  path?: string;
  type?: string;
  data?: unknown;
  init?: { method?: string; headers?: Record<string, string>; body?: string | null };
  ok?: boolean;
  status?: number;
  error?: string;
}

/** isolated 行宿主句柄（boot-v3 reload 面消费：rev 变化 = cleanup 重建） */
export interface IsolatedRowHandle {
  row: WireRow;
  iframe: HTMLIFrameElement;
  /** 卸载：通知 iframe onUnload → 撤订阅/席位 → 移除 iframe */
  cleanup(): void;
}

/**
 * 席位占位承载组件（旧 isolatedView 同档最简形态）：div 容器 + ref 回调
 * 挂入 iframe；卸载让位时 iframe 回 body 屏幕外寄存（销毁语义归 cleanup，
 * 让位不杀 iframe——插件 request/订阅仍活）。
 */
function isolatedPlaceholderComponent(handle: IsolatedRowHandle) {
  const iframe = handle.iframe;
  const id = handle.row.id;
  const hideOffscreen = () => {
    iframe.setAttribute('aria-hidden', 'true');
    Object.assign(iframe.style, { position: 'fixed', left: '-9999px', top: '0', width: '0', height: '0', border: '0' });
  };
  return defineComponent({
    name: 'IsolatedRowHost',
    setup() {
      onUnmounted(hideOffscreen);
      return () => h('div', {
        'data-ui-isolated-view': id,
        style: { width: '100%', minHeight: '48px', border: '1px dashed rgba(127,127,127,.5)', boxSizing: 'border-box' },
        ref: (node: unknown) => {
          const el = node as HTMLElement | null;
          if (el === null || iframe.parentElement === el) return;
          el.appendChild(iframe);
          iframe.setAttribute('aria-hidden', 'false');
          Object.assign(iframe.style, { position: 'static', left: 'auto', top: 'auto', width: '100%', height: '100%', minHeight: '48px', border: '0', display: 'block' });
        },
      });
    },
  });
}

/**
 * 装载 isolated wire 行：sandbox iframe（allow-scripts、无 allow-same-origin
 * → opaque origin 无法带凭据直访宿主 API）+ 席位占位注册 + 白名单代理。
 * 席位词须为已声明席位（'new:' 词形仅 isolated:false——cr-690）；未声明
 * 席位 warn 跳过（wire 词汇漂移面归 seats-audit 门）。
 */
export function loadIsolatedRowV3(ctx: ClientContext, row: WireRow & { entry: string }): IsolatedRowHandle {
  // 绝对 URL（跨源部署 + CSP origin 词单源）；同源时与相对路径同效
  const entryUrl = new URL(hostUrl(row.entry), location.href).href;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts'); // 无 allow-same-origin → opaque origin
  iframe.referrerPolicy = 'no-referrer';
  iframe.dataset.uiIsolated = row.id;
  iframe.srcdoc = generateIsolatedDoc({ id: row.id, entryUrl });
  // 屏幕外寄存（非 display:none——部分浏览器不建隐藏 frame 树；旧链同款）
  iframe.setAttribute('aria-hidden', 'true');
  Object.assign(iframe.style, { position: 'fixed', left: '-9999px', top: '0', width: '0', height: '0', border: '0' });

  const post = (message: Record<string, unknown>) => {
    try {
      iframe.contentWindow?.postMessage({ source: 'agentchat-ui-iframe-host', plugin: row.id, ...message }, '*');
    } catch { /* iframe 已卸载等——best-effort */ }
  };
  // 按 type 引用计数订阅（iframe 侧 handler 0→1 subscribe / 1→0 unsubscribe 对齐）
  const subscriptions = new Map<string, { dispose: () => void; count: number }>();
  const seatDisposers: Array<() => void> = [];
  let disposed = false;

  const onMessage = async (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data as IframeMessage | undefined;
    if (!msg || msg.source !== 'agentchat-ui-plugin-iframe' || msg.plugin !== row.id) return;
    switch (msg.kind) {
      case 'request': {
        const id = msg.id ?? 0;
        const path = msg.path ?? '';
        const method = msg.init?.method ?? 'GET';
        if (!isAllowedIsolatedRequestV3(method, path)) {
          post({ kind: 'response', id, ok: false, status: 403, error: 'isolated request 不在白名单: ' + method + ' ' + path });
          return;
        }
        try {
          // 只读 GET 代理（白名单已闸方法）；插件自定义 headers 不透传——
          // opaque origin 本就无凭据可携带，宿主面不替沙盒扩权
          const res = await fetch(hostUrl(path), { method: 'GET' });
          const text = await res.text();
          let data: unknown = text;
          try { data = JSON.parse(text); } catch { /* 非 JSON 原样文本 */ }
          if (!res.ok) {
            post({ kind: 'response', id, ok: false, status: res.status, error: 'proxy ' + res.status + ': ' + path });
          } else {
            post({ kind: 'response', id, ok: true, status: res.status, data });
          }
        } catch (err) {
          post({ kind: 'response', id, ok: false, status: 0, error: err instanceof Error ? err.message : String(err) });
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
          post({ kind: 'event', type, data: args[0] });
        });
        subscriptions.set(type, { dispose, count: 1 });
        return;
      }
      case 'unsubscribe': {
        const sub = msg.type !== undefined ? subscriptions.get(msg.type) : undefined;
        if (!sub) return;
        sub.count--;
        if (sub.count <= 0) {
          subscriptions.delete(msg.type!);
          try { sub.dispose(); } catch { /* ignore */ }
        }
        return;
      }
      case 'ready':
        console.info('[isolated-host-v3] isolated 行就绪：' + row.id, { sandbox: iframe.getAttribute('sandbox') });
        return;
      case 'error':
        console.warn('[isolated-host-v3] isolated 行报错：' + row.id, msg.error);
        return;
    }
  };

  window.addEventListener('message', onMessage);
  document.body.appendChild(iframe);

  const handle: IsolatedRowHandle = {
    row,
    iframe,
    cleanup: () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('message', onMessage);
      try {
        iframe.contentWindow?.postMessage({ source: 'agentchat-ui-plugin-iframe', plugin: row.id, kind: 'unload' }, '*');
      } catch { /* ignore */ }
      for (const { dispose } of subscriptions.values()) {
        try { dispose(); } catch { /* ignore */ }
      }
      subscriptions.clear();
      for (const dispose of seatDisposers) {
        try { dispose(); } catch { /* ignore */ }
      }
      seatDisposers.length = 0;
      iframe.remove();
    },
  };

  const placeholder = isolatedPlaceholderComponent(handle);
  for (const seat of row.seats) {
    try {
      seatDisposers.push(ctx.slots.register(seat, { id: row.id, component: placeholder }));
    } catch (error) {
      console.warn('[isolated-host-v3] 席位 "' + seat + '" 未声明——占位注册跳过（' + row.id + '）：', error instanceof Error ? error.message : error);
    }
  }
  return handle;
}
