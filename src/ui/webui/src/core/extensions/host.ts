// ============================================================
// core/extensions/host.ts —— UiExtensionHost（P5.3）
//
// 1. 拉取 /api/ui/extensions
// 2. import('/ui-plugin/<name>/<entry>?v=<version>')
// 3. 调用插件 install(bridgeCtx)
// 4. 记录 bridge disposers + install 返回的 disposer
// 5. 卸载时逆序执行；WS ui.extensions.changed 驱动 reload/unload/re-register
// ============================================================

import type { UIExtensionDescriptor } from '@agentchat/protocol';
import { getUiExtensions } from '@/core/api/endpoints/ui';
import { useWebSocketStore } from '@/stores/websocket';
import { createBridge, getBridgeDisposers } from './bridge';
import { loadIsolatedExtension } from './isolated';
import type { Disposer, UiExtensionContext, UiExtensionModule } from './types';

interface LoadedExtension {
  descriptor: UIExtensionDescriptor;
  disposers: Disposer[];
}

const loaded = new Map<string, LoadedExtension>();
let wsUnsubscribe: (() => void) | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

function extensionUrl(descriptor: UIExtensionDescriptor): string {
  const sep = descriptor.entry.includes('?') ? '&' : '?';
  return `${descriptor.entry}${sep}v=${encodeURIComponent(descriptor.version)}`;
}

/** 注入插件声明的前端 CSS（若有）；卸载时按 name 移除。 */
function injectStyles(descriptor: UIExtensionDescriptor): void {
  for (const href of descriptor.styles ?? []) {
    if (!href) continue;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.uiExtension = descriptor.name;
    document.head.appendChild(link);
  }
}

function removeStyles(name: string): void {
  document.querySelectorAll(`link[data-ui-extension="${CSS.escape(name)}"]`).forEach(el => el.remove());
}

/** 单个插件 install() 的超时：挂起的插件不得阻塞其后所有插件的加载 */
const INSTALL_TIMEOUT_MS = 15_000;

/** per-name 加载互斥：同名并发加载（初次 init 循环与 WS 事件触发的
 *  syncFromServer 重叠）时，`loaded.set` 直接覆盖会丢失先加载那套
 *  disposers → 孤儿 perspective/订阅/style 残留。同名加载串行去重。 */
const inFlightLoads = new Map<string, Promise<boolean>>();

async function loadExtension(descriptor: UIExtensionDescriptor): Promise<boolean> {
  const prev = inFlightLoads.get(descriptor.name);
  if (prev) {
    // 同名在途：等它落地（其结果即代表该 name 的最新状态）
    return prev;
  }
  const task = loadExtensionInner(descriptor).finally(() => {
    inFlightLoads.delete(descriptor.name);
  });
  inFlightLoads.set(descriptor.name, task);
  return task;
}

async function loadExtensionInner(descriptor: UIExtensionDescriptor): Promise<boolean> {
  if (descriptor.isolated) {
    // P5.5：不信任插件档 —— sandbox iframe + 白名单 request + 受控 postMessage
    // 防御：同名旧实例未卸载（异常路径残留）先清理，避免覆盖丢失 disposers
    if (loaded.has(descriptor.name)) unloadExtension(descriptor.name);
    const handle = loadIsolatedExtension(descriptor);
    loaded.set(descriptor.name, { descriptor, disposers: [handle.cleanup] });
    console.info(`[ui-ext] 已挂载 isolated UI 插件（sandbox iframe）: ${descriptor.name}@${descriptor.version}`);
    return true;
  }

  let bridge: UiExtensionContext | null = null;
  try {
    const mod = (await import(/* @vite-ignore */ extensionUrl(descriptor))) as UiExtensionModule;
    if (typeof mod.install !== 'function') {
      throw new Error(`插件入口缺少 install(ctx) 函数: ${descriptor.entry}`);
    }

    bridge = createBridge(descriptor);
    // 超时守护：install 永不 resolve（插件 bug）不得阻塞后续插件；
    // 超时后走 catch 分支回滚已注册项
    const returned = await Promise.race([
      mod.install(bridge),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('install() 超时')), INSTALL_TIMEOUT_MS)),
    ]);

    const disposers: Disposer[] = [...getBridgeDisposers(bridge)];
    if (typeof returned === 'function') disposers.push(returned);

    injectStyles(descriptor);
    loaded.set(descriptor.name, { descriptor, disposers });
    console.info(`[ui-ext] 已加载 UI 插件: ${descriptor.name}@${descriptor.version}`, {
      slots: descriptor.slots,
    });
    return true;
  } catch (err) {
    // 安装中途抛错/超时也可能已注册部分 slot：逆序执行已记录的 bridge disposers，避免残留
    if (bridge) {
      const disposers = getBridgeDisposers(bridge);
      for (let i = disposers.length - 1; i >= 0; i--) {
        try {
          disposers[i]();
        } catch (disposeErr) {
          console.error(`[ui-ext] 回滚插件 "${descriptor.name}" 的 disposer 出错:`, disposeErr);
        }
      }
    }
    // 单个插件失败必须隔离：仅记录，不影响宿主与其他插件
    console.error(`[ui-ext] 加载 UI 插件失败: ${descriptor.name}`, err);
    removeStyles(descriptor.name);
    return false;
  }
}

function unloadExtension(name: string): void {
  const rec = loaded.get(name);
  if (!rec) return;
  // 逆序执行 disposers（先 install 返回值，再各注册项）
  for (let i = rec.disposers.length - 1; i >= 0; i--) {
    try {
      rec.disposers[i]();
    } catch (err) {
      console.error(`[ui-ext] 卸载插件 "${name}" 的 disposer 出错:`, err);
    }
  }
  removeStyles(name);
  loaded.delete(name);
}

/** 按 name 卸载（宿主侧直接调用 / 测试用） */
export function unloadUiExtension(name: string): void {
  unloadExtension(name);
}

/** 从服务端列表同步：卸载已消失/变化的，加载新增/变化的 */
async function syncFromServer(): Promise<void> {
  let list: UIExtensionDescriptor[];
  try {
    list = await getUiExtensions();
  } catch (err) {
    console.warn('[ui-ext] 同步 /api/ui/extensions 失败，保留当前状态', err);
    return;
  }

  // ① 卸载服务端已不存在或版本/入口变化的插件
  for (const [name, rec] of [...loaded]) {
    const next = list.find(d => d.name === name);
    if (
      !next
      || next.version !== rec.descriptor.version
      || next.entry !== rec.descriptor.entry
      || next.isolated !== rec.descriptor.isolated
    ) {
      console.info(`[ui-ext] 卸载已失效 UI 插件: ${name}`);
      unloadExtension(name);
    }
  }

  // ② 加载新增/变化后的插件（顺序执行，单个失败隔离）
  for (const desc of list) {
    const existing = loaded.get(desc.name);
    if (
      existing
      && existing.descriptor.version === desc.version
      && existing.descriptor.entry === desc.entry
      && existing.descriptor.isolated === desc.isolated
    ) {
      continue;
    }
    await loadExtension(desc);
  }
}

/**
 * 初始化 UiExtensionHost。
 * 失败降级：拉取失败只 console.warn，内置 UI 不受影响。
 */
export async function initUiExtensionHost(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // 订阅 WS 事件（App.vue 已先 useWebSocketStore().init()）
  wsUnsubscribe = useWebSocketStore().onMessage((type, data) => {
    if (type !== 'ui.extensions.changed') return;
    const payload = data as { name?: string; reason?: 'register' | 'unregister' | 'reload' } | undefined;
    console.info('[ui-ext] 收到 ui.extensions.changed:', payload);
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void syncFromServer();
    }, 150); // debounce：register/unregister/reload 往往连续到达
  });

  let list: UIExtensionDescriptor[];
  try {
    list = await getUiExtensions();
  } catch (err) {
    console.warn('[ui-ext] 拉取 /api/ui/extensions 失败，跳过 UI 插件加载（内置 UI 不受影响）', err);
    return;
  }

  for (const desc of list) {
    // 顺序加载；单个插件 try/catch 在 loadExtension 内部
    await loadExtension(desc);
  }
}

/** 测试/热重载辅助：当前已加载的插件名列表（只读） */
export function loadedUiExtensionNames(): string[] {
  return [...loaded.keys()];
}
