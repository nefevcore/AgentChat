# UI 扩展宿主 + 注册表搬迁适配清单（preview/webui/src → 新 Vue3 应用）

搬迁范围：`webui/src/core/extensions/**` → `src/extensions/`，`webui/src/core/registry/**` → `src/registry/`。
"外部依赖"定义：import 自 `core/extensions` 与 `core/registry` 之外的符号（含 vue 包、`compat/protocol`、`core/api`、`stores/websocket`、`types`、`constants`、`components`）。
注：任务说 extensions 8 个文件，实际目录内 7 个 .ts；第 8 个配套件是 `src/isolated-runtime.ts`（iframe 侧运行时，isolated.ts 的协议对端）+ 根部 `ui-plugin-iframe.html`（vite 第二入口）。

---

## A. core/extensions 逐文件

### A1. `core/extensions/index.ts`（桶出口）
- **外部 import：无**。仅 `export * from './types' | './slots' | './bridge' | './host'`（不重导出 isolated / p5.5-policy，二者仅内部使用）。
- **迁移建议**：原样拷贝到 `src/extensions/index.ts`，零适配。消费方：`App.vue`（import initUiExtensionHost）。

### A2. `core/extensions/types.ts`（桥接类型）
外部 import：

| 符号 | 来源 | 用途 |
|---|---|---|
| `Component`(type) | `vue` | registerToolResultView / registerMessageView renderer 的组件类型 |
| `Perspective`(type) | `@/core/registry/perspectives` | ctx.registerPerspective 参数类型 |
| `MessageViewDef`(type) | `@/core/registry/messageViews` | ctx.registerMessageView 参数类型 |
| `EventHandler`(type) | `@/core/registry/eventHandlers` | ctx.registerEventHandler / wsOn 的回调类型 |
| `UIExtensionDescriptor`, `UISlotId`(re-export) | `../../compat/protocol` | 对外重导出插件契约类型 |

内部依赖：`./slots`（SettingsTabDef/SidebarActionDef）、`./p5.5-policy`（GlobalStyleDef）。
- **迁移建议**：整体搬迁；registry 三处 import 改指 `../registry/*`（同批迁移，仅改路径）；protocol 重导出改指新协议文件（见 D1）。注意 `UiExtensionContext.vue` 的类型 `Pick<typeof import('vue'), 'h'|'defineComponent'|'ref'|'computed'|'watch'>` 锁定了注入子集——新应用 vue 版本升级时此面保持不变即可。

### A3. `core/extensions/host.ts`（宿主生命周期）
外部 import：

| 符号 | 来源 | 用途 |
|---|---|---|
| `UIExtensionDescriptor`(type) | `../../compat/protocol` | 描述符类型 |
| `getUiExtensions` | `@/core/api/endpoints/ui` | 拉 `/api/ui/extensions` 清单（init + syncFromServer 两处） |
| `useWebSocketStore` | `@/stores/websocket` | WS 订阅 `ui.extensions.changed` |

**useWebSocketStore 具体用法**：`useWebSocketStore().onMessage((type, data) => ...)` 注册**全量原始 handler**（收到所有 WS 消息），内部过滤 `type !== 'ui.extensions.changed'` 即返回；命中后读 payload `{ name?: string; reason?: 'register'|'unregister'|'reload' }`，150ms debounce 后调 `syncFromServer()`（重拉清单 → diff version/entry/isolated → 卸载失效 + 加载新增）。依赖两个隐式契约：① onMessage 内部自动 `init()` 建立 WS 连接（store 保证，注释写明"此前依赖 App.vue 先 init 的隐性顺序契约"）；② 在非组件上下文调用 pinia store，要求组合根已 `app.use(pinia)`。
其他要点：per-name 加载互斥（inFlightLoads）、install 超时 15s、失败回滚 bridge disposers、`import(/* @vite-ignore */ entry?v=version)` 动态加载。
- **迁移建议**：文件逻辑原样搬迁；`getUiExtensions` 改指新 `src/api/endpoints/ui`；`useWebSocketStore` 改为新 WS 总线访问器（D4），建议总线模块保留"onMessage 自动建连"兜底，或明确新组合根顺序：ws connect → `initUiExtensionHost()`（现 App.vue 即此顺序）。

### A4. `core/extensions/bridge.ts`（install(ctx) 桥接）
外部 import：

| 符号 | 来源 | 用途 |
|---|---|---|
| `vue`（命名空间：h/defineComponent/ref/computed/watch）+ `Component`(type) | `vue` | 注入 ctx.vue 五件套 |
| `UIExtensionDescriptor`, `UISlotId`(type) | `../../compat/protocol` | 白名单校验类型 |
| `registerPerspective` | `@/core/registry/perspectives` | 转发 ctx.registerPerspective |
| `registerMessageView` | `@/core/registry/messageViews` | 转发 ctx.registerMessageView |
| `registerToolResultView` | `@/core/registry/toolResultViews` | 转发 ctx.registerToolResultView |
| `registerEventHandler` | `@/core/registry/eventHandlers` | 转发 ctx.registerEventHandler |
| `request`(as apiRequest) | `@/core/api/client` | ctx.request 通道 |
| `useWebSocketStore` | `@/stores/websocket` | ctx.wsOn 通道 |
| `rewriteGlobalStyle` | `./p5.5-policy`（内部） | global-style 消毒 |
| `registerSettingsTab/registerAgentSettingsTab/registerSidebarAction` | `./slots`（内部） | 新 slot 转发 |

**给插件暴露的通道细节**：
- **slot 白名单门**：`assertSlot(descriptor, slot)` 要求 `descriptor.slots`（UISlotId 数组，8 值见 B）包含对应 id，否则抛错拒注。受门控：perspective / tool-result / message-view / ws-event / settings-tab:global / settings-tab:agent / sidebar-action / global-style。
- **`ctx.request<T>(path, init)`**：直接透传 `apiRequest`（同源 fetch；非 2xx 抛 `Error(body.error || HTTP n)`，成功返回解析 JSON）。**不经 slots 白名单、不限方法与路径**（可信档全权）。
- **`ctx.wsOn(type, handler)`**：`useWebSocketStore().onMessage((t, data) => { if (t === type) handler(data) })`——**任意事件名、全量流过滤**，不经 'ws-event' slot 门控（只有 `ctx.registerEventHandler` 才受 'ws-event' 约束）。disposer 记入 bridge disposers，插件忽略返回值也能在卸载时撤销。
- **id 前缀**：settings tab 与 sidebar action 的 id 统一加 `${descriptor.name}-` 前缀防跨插件冲突。
- **`registerGlobalStyle`**：经 rewriteGlobalStyle 消毒后 `<style data-ui-global-style=name>` 插入 head，disposer 移除元素。
- **`onUnload(fn)`** / install 返回的 disposer：全部进 disposers，host 卸载时逆序执行。
- **迁移建议**：逻辑原样搬迁；4 个 registry import、api client、ws store 改新路径（均为一行 import 改动）。

### A5. `core/extensions/isolated.ts`（iframe 隔离档宿主）
外部 import：

| 符号 | 来源 | 用途 |
|---|---|---|
| `UIExtensionDescriptor`(type) | `../../compat/protocol` | 描述符类型 |
| `request`(as apiRequest) | `@/core/api/client` | 代理 iframe 的 request（白名单校验后） |
| `useWebSocketStore` | `@/stores/websocket` | 按白名单转发事件给 iframe |
| `isAllowedIsolatedEvent`, `isAllowedIsolatedRequest` | `./p5.5-policy`（内部） | 白名单 |

**postMessage 协议（完整）**：
- iframe：`src=/ui-plugin-iframe.html?name=&entry=&version=`，`sandbox="allow-scripts"`（无 allow-same-origin → opaque origin），`referrerPolicy=no-referrer`，0×0 屏幕外定位，`data-ui-isolated=name`。
- 信封：`{ source: 'agentchat-ui-plugin-iframe' | 'agentchat-ui-iframe-host', plugin: <name>, kind, ... }`；过滤条件 `event.source === iframe.contentWindow` + `msg.source/plugin` 匹配。
- **iframe→host kind 清单**：`request`{id, path, init{method, headers, body}}、`subscribe`{type}、`unsubscribe`{type}、`ready`、`error`{error}。
- **host→iframe kind 清单**：`response`{id, ok, status=200/403/500, data|error}、`event`{type, data}、`unload`（cleanup 时先发再删 iframe）。
  ⚠️ `unload` **不在文件内 `IframeMessage.kind` 类型联合里**（联合只列 request|response|subscribe|unsubscribe|event|ready|error），是裸对象字面量直发——类型缺口，搬迁时建议补进联合。
- request 代理：`isAllowedIsolatedRequest(method, path)` 不过 → 回 403；GET 强制 body=undefined。
- subscribe 按 type 引用计数（0→1 建订阅、1→0 退订），与 iframe 侧 `isolated-runtime.ts` 的 handler 计数协议对齐；每个匹配事件以 kind 'event' 投递回 iframe。
- **迁移建议**：与 `src/isolated-runtime.ts`、`ui-plugin-iframe.html` **必须同批搬迁**（source 常量字符串是隐式契约，建议提为两文件共享常量）；api client / ws 总线改新路径；vite 保留双入口 + `/ui-plugin` 代理（见 D8）。

### A6. `core/extensions/slots.ts`（新 slot 注册表）
外部 import：仅 `vue`（`ref`, `computed`, `type Component`）。内部：`./types`（Disposer）。
**注册表结构**：3 个响应式原始数组 `settingsTabs` / `agentSettingsTabs` / `sidebarActions`（`ref<T[]>`），3 个排序只读 computed `sortedSettingsTabs` / `sortedAgentSettingsTabs` / `sortedSidebarActions`（`order ?? 100` 升序、稳定排序）；注册函数 `registerSettingsTab/registerAgentSettingsTab/registerSidebarAction`（同 id 替换保持位置，disposer 按对象身份移除）；`resolveTabProps(tab, base)`（无 props 返回 base 副本；函数式 props 调用后与 base 合并，tab 优先）。
**注意**：UISlotId 白名单本体不在本文件——白名单在 `descriptor.slots`（bridge 的 assertSlot 强制）；本文件只是 settings-tab:global / settings-tab:agent / sidebar-action 三种 slot 的存储。
- **迁移建议**：零外部依赖（除 vue），原样拷贝。消费方需同步迁：`Sidebar.vue`（sortedSidebarActions + SidebarActionDef）、`SettingsPanel.vue`（sortedSettingsTabs + resolveTabProps）、`settings/components/AgentPane.vue`（sortedAgentSettingsTabs + resolveTabProps）——新应用对应布局组件需提供这些渲染口。

### A7. `core/extensions/p5.5-policy.ts`（纯策略函数）
**外部 import：零**（完全自包含，可独立单测）。
**导出清单**：
- `interface GlobalStyleDef { scope?: string; css: string }`
- `rewriteGlobalStyle(pluginName: string, def: GlobalStyleDef): string` —— CSS 消毒（剥注释、禁 @import/url()/expression()/javascript:/`</style`、禁 at-rule、禁反斜杠转义、:root 块只许 `--*` 自定义属性）+ 选择器强制 `.ui-plugin-<scope>` 前缀。
- `isAllowedIsolatedRequest(method: string, path: string): boolean` —— GET-only 白名单 8 条：`/api/ui/extensions`、`/api/ui/slots`、`/api/config`、`/api/version`、`/api/plugins/catalog`、`/api/plugins/permissions`、`/api/plugins/library`、`/api/plugins/assembly/[a-z0-9_-]+`。
- `isAllowedIsolatedEvent(type: string): boolean` —— 事件白名单 4 个：`ui.extensions.changed`、`plugin.catalog.changed`、`plugin.reload`、`agent.assembly.changed`。
- **迁移建议**：原样拷贝；仅需保证白名单与新应用后端路由/事件名对齐（路径变了要同步改这里）。

---

## B. compat/protocol.ts 关键 interface（原样抄录）

extensions 实际 import 的只有 `UIExtensionDescriptor` 与 `UISlotId`（host.ts / isolated.ts 各 import Descriptor；bridge.ts 两者；types.ts re-export 两者）。以下抄录该契约簇（含同簇的 slot 目录 / 变更事件 / 事件名常量，供新协议文件一并覆盖）：

```ts
/** UI slot v1 白名单（宿主先开口，插件后填空） */
export type UISlotId =
  | 'perspective'
  | 'tool-result'
  | 'message-view'
  | 'ws-event'
  | 'settings-tab:global'
  | 'settings-tab:agent'
  | 'sidebar-action'
  | 'global-style';

/**
 * 后端向浏览器下发的 UI 扩展清单。
 * preview 差异：ac-webui 下发 permissions（src 为 grantedPermissions）——
 * 两字段皆可选，消费方按 `permissions ?? grantedPermissions` 取值。
 */
export interface UIExtensionDescriptor {
  name: string;
  version: string;
  entry: string;
  styles: string[];
  slots: UISlotId[];
  isolated: boolean;
  status: 'installed' | 'session';
  permissions?: string[];
  grantedPermissions?: string[];
}

/** slot 目录条目 */
export interface UISlotInfo {
  id: UISlotId;
  label: string;
  description: string;
}

/** 插件 UI 资源变更事件（WS） */
export interface UIExtensionsChangedEvent {
  name: string;
  reason: 'register' | 'unregister' | 'reload';
}

export const PLUGIN_EVENT = {
  CATALOG_CHANGED: 'plugin.catalog.changed',
  RELOAD: 'plugin.reload',
  ASSEMBLY_CHANGED: 'agent.assembly.changed',
  UI_EXTENSIONS_CHANGED: 'ui.extensions.changed',
} as const;

export type PluginEventName = (typeof PLUGIN_EVENT)[keyof typeof PLUGIN_EVENT];

export interface PluginEventMap {
  [PLUGIN_EVENT.CATALOG_CHANGED]: PluginCatalogChangedEvent;
  [PLUGIN_EVENT.RELOAD]: PluginReloadEvent;
  [PLUGIN_EVENT.ASSEMBLY_CHANGED]: AgentAssemblyChangedEvent;
  [PLUGIN_EVENT.UI_EXTENSIONS_CHANGED]: UIExtensionsChangedEvent;
}
```

`PluginCatalogChangedEvent { kind: 'installed'|'staging'|'session' }`、`PluginReloadEvent { name; status: 'loaded'|'replaced'|'failed'; error? }`、`AgentAssemblyChangedEvent { agentId }` 同文件内。协议文件本身零 import。其余大块（PersistedMessage/AgentInfo/AssemblyView/PluginCatalog 等）只被旧壳（`types/index.ts`、`settings/types.ts`、`stores/feed.ts`）使用，extensions/registry 不依赖——新应用协议文件可只保留 P5 契约簇 + 新应用自身需要的部分（preview 注释明确"自包含、不跨轨依赖 src/sdk/protocol"，建议维持内联而非引包）。

---

## C. core/registry 四个注册表：公开 API + import 方

### C1. `perspectives.ts`
外部依赖：仅 `vue`（`ref`, `Component`）——零旧壳依赖。
API：
```ts
interface Perspective { id: string; label: string; icon?: string; active: () => boolean; component: Component; props?: () => Record<string, unknown> }
export const perspectiveVersion: Ref<number>                      // 注册表版本号（computed 响应式依赖用）
export function registerPerspective(p: Perspective): () => void   // 同 id 替换；返回 disposer
export function unregisterPerspective(id: string): void
export function activePerspective(): Perspective | null           // 注册顺序第一个 active
export function allPerspectives(): readonly Perspective[]
```
**被谁 import**：`core/extensions/bridge.ts`（registerPerspective）、`core/extensions/types.ts`（type Perspective）、`App.vue`（registerPerspective——内置 talk/group 视角在此注册）、`components/layout/PerspectiveHost.vue`（activePerspective + perspectiveVersion）。
迁移：原样拷到 `src/registry/perspectives.ts`；新应用需自带 PerspectiveHost 等价渲染口 + 内置视角注册点。

### C2. `eventHandlers.ts`
**外部依赖：零 import**（全仓最干净）。
API：
```ts
export type EventHandler = (data: any) => void
export function registerEventHandler(type: string, fn: EventHandler): () => void  // 同事件多 handler 按序调用
export function dispatchEvent(type: string, data: any): void                      // 未注册静默忽略；单 handler 抛错不中断
export function clearEventHandlers(): void                                        // 测试/热重载
```
**被谁 import**：`core/extensions/bridge.ts`、`core/extensions/types.ts`（type）、`stores/chat.ts`、`stores/feed.ts`（**register + dispatchEvent——旧壳的 WS 单一分发点在 feed store**）、`stores/groups.ts`、`stores/singles.ts`。
迁移：原样拷贝；新应用的 WS 总线必须在入站消息处调 `dispatchEvent(type, data)`（旧壳此调用点在 feed.ts，删旧壳时别丢）。

### C3. `messageViews.ts`
外部依赖：`vue`（ref, Component）、`@/types`（**Turn, ChatMessage**）、`@/constants`（**VIEWER_ID**）。
API：
```ts
interface MessageViewDef { id: string; match: (turn: Turn, final: ChatMessage | null) => boolean; priority?: number; renderer?: Component }
export const messageViewVersion: Ref<number>
export function registerMessageView(def: MessageViewDef, renderer?: Component): () => void  // 同 id 替换
export function unregisterMessageView(id: string): void
export function resolveMessageView(turn: Turn, final: ChatMessage | null): string | null     // 读 version 建立响应式依赖；未命中 null
export function resolveMessageViewRenderer(id: string): Component | null                     // 内置 id（无 renderer）→ null
```
模块加载时内置注册：`id:'user'`（`match: turn => turn.agent_id === VIEWER_ID.value`）、`id:'assistant'`（兜底 `() => true`）。
**被谁 import**：`core/extensions/bridge.ts`、`core/extensions/types.ts`（type MessageViewDef）、`components/chat/Message/TurnDisplayItem.vue`（resolveMessageView + resolveMessageViewRenderer）。
迁移：本体可拷，但 Turn/ChatMessage/VIEWER_ID 三个旧壳符号必须先在新应用落地（D5/D6），或把内置注册拆到应用层 builtins（见 E）。

### C4. `toolResultViews.ts`
外部依赖：`vue`（ref, Component）、**7 个内置组件** `@/components/chat/ToolResult/{ToolResultCode, ToolResultWeb, ToolResultTerminal, ToolResultWrite, ToolResultEdit, ToolResultSubagent, ToolResultBrowser}.vue`。
API：
```ts
interface ToolResultViewDef { match: string | RegExp; component: Component; priority?: number }
export const toolResultViewVersion: Ref<number>
export function registerToolResultView(match: string | RegExp, component: Component, opts?: { priority?: number }): () => void  // 同 match 替换（幂等）
export function unregisterToolResultView(match: string | RegExp): void   // 字符串相等 / 正则引用相等
export function resolveToolResultView(toolName?: string): Component | null  // 读 version 建立依赖；精确名 > 正则族；同层取最高 priority
```
模块加载时内置注册（旧工具名词表）：`bash`→Terminal、`read`→Code、`write`→Write、`edit`→Edit、`web_search`→Web、`browser`→Browser、正则族 `/^(fetch_webpage|open_browser_page|navigate_page|read_page|click_element|type_in_page|screenshot_page|hover_element|drag_element|handle_dialog|run_playwright_code)$/`→Web、`subagent`→Subagent。
**被谁 import**：`core/extensions/bridge.ts`、`composables/useToolResult.ts`（resolveToolResultView——消息渲染分发点）。
迁移：注册表本体只依赖 vue；7 个组件 import 是最重耦合，建议拆 builtins（E2）或先移植 7 个 ToolResult 组件。

---

## D. 搬迁清单：新应用需新建的小文件

| # | 建议路径 | 一句话说明 |
|---|---|---|
| 1 | `src/protocol/ui-extension.ts`（或并入 `src/protocol/index.ts`） | P5 契约簇：UISlotId / UIExtensionDescriptor / UISlotInfo / UIExtensionsChangedEvent / PLUGIN_EVENT / PluginEventMap（+插件面板保留时再纳 PluginInfo/AssemblyView 等），满足 host/bridge/isolated/types 及 endpoints 的类型 import。 |
| 2 | `src/api/client.ts` | HTTP 客户端：`request<T>(url, init)`（非 2xx 抛 `body.error || HTTP n`，成功返 JSON）；extensions 只用 `request`，jsonPost/Put/Patch/Delete/stripEmpty 供新应用其余部分按需带过。 |
| 3 | `src/api/endpoints/ui.ts` | `getUiExtensions(): Promise<UIExtensionDescriptor[]>`——GET `/api/ui/extensions` 取 `{extensions} ?? []`（host.ts init 与 syncFromServer 唯一数据源）。 |
| 4 | `src/services/ws-bus.ts`（或新写 `src/stores/websocket.ts`） | WS 订阅访问器：`onMessage(handler: (type: string, data: any) => void): () => void`，建议保留"onMessage 自动建连"兜底；host/bridge/isolated 三处 `useWebSocketStore` 改 import 此模块（唯一非纯路径改写点）；纯模块实现可顺便解除 host 对 pinia 非组件上下文的依赖。 |
| 5 | `src/types/chat.ts` | Turn / TurnStep / ChatMessage 定义（messageViews 的 match 签名与 resolveMessageView 参数），替代将被删除的旧 `@/types`；注意旧 types/index.ts 自身还 import protocol（MessageSource 等），新文件应直接依赖 #1 而非旧壳。 |
| 6 | `src/constants.ts`（或 store getter） | `VIEWER_ID = ref('user')` viewer 身份，满足 messageViews 内置 'user' matcher。 |
| 7 | `src/registry/builtins/`（建议新增，非必须） | 把 messageViews 的 user/assistant 内置注册与 toolResultViews 的 8 条内置注册 + 7 组件 import 移出注册表本体，令 `src/registry/*` 零宿主组件依赖、可整体搬迁不被组件树阻塞。 |
| 8 | `ui-plugin-iframe.html` + `src/isolated-runtime.ts` + vite 配置项 | isolated 档运行时配套：vite `build.rollupOptions.input['ui-plugin-iframe']` 双入口 + dev 代理 `/ui-plugin`、`/api`、`/ws` → 后端（现 3830）。 |
| 9 | 组合根调用点 | 新 App 根组件：先 ws 总线 init → `initUiExtensionHost()`；`@` alias → `src`；host 动态 import 用 `/* @vite-ignore */` 绝对路径，dev 走代理、生产同源，均无需打包器特殊处理。 |

---

## E. 注意点：旧 src 词汇耦合清单

1. **`registry/messageViews.ts` 是旧壳词汇最重处**：直接 `import { Turn, ChatMessage } from '@/types'` + `import { VIEWER_ID } from '@/constants'`，内置 matcher `turn.agent_id === VIEWER_ID.value` 硬编码 viewer 身份模型。建议：注册表本体参数化（类型从 #5 取），内置注册移入 builtins（#7）；若新应用聊天状态模型改型，`MessageViewDef.match` 签名是插件 API 面，尽量保持 `(turn, final) => boolean` 不变以免破坏已发布插件。
2. **`registry/toolResultViews.ts` 内置注册**依赖 7 个旧组件树组件与旧工具名词表（bash/read/write/edit/web_search/browser/subagent + 11 个浏览器族工具名正则）。建议同上拆 builtins；`resolveToolResultView` 的消费方 `composables/useToolResult.ts` 在新应用消息渲染层重写。
3. **`core/extensions/` 目录本体没有任何 Turn/ChatMessage/VIEWER_ID/chat.\* 的直接引用**——唯一泄漏是 `types.ts` 经 `MessageViewDef`（match 签名携带 Turn/ChatMessage）间接进入插件 API 面；事件名方面 host.ts 只用 `ui.extensions.changed`（插件域，非 chat.*）。
4. **事件名双源缺口**：`'ui.extensions.changed'` 存在于 compat/protocol `PLUGIN_EVENT`、p5.5-policy 事件白名单、host.ts 字面量，但 `core/events/contract.ts` 的 `WS_EVENT` **没有收录**它（只收了 plugin.catalog.changed / plugin.reload / agent.assembly.changed）。新应用事件目录必须补上并收敛为单一来源。contract.ts 事件名清单（迁移参考）：出站 13 个（chat.send/interrupt/continue/subscribe/delete_message/interact.respond、history.request、agent.list、agent.system_prompt、agent.tool_defs、session.compress、system.restart、group.message）；入站含 chat.* 22 个消息流事件（chat.start/step.start/step.end/interrupted/end/message.start|update|end|error/thinking.start|update|end/toolcall.start|update|end/tool_execution.start|update|end/session.resume/virtual.receive）+ history.response、group.message、agent.list.response、agent.profile.updated、chat.send.ack、chat.interaction、chat.interact.respond、session.compressed、session.archived、singles.updated、system.restarting、agent.system_prompt.response、agent.tool_defs.response、group.created/deleted/join/leave/delivered、plugin.catalog.changed、plugin.reload、agent.assembly.changed——extensions/registry 均不直接引用这些 chat.* 名（eventHandlers/wsOn 都是任意字符串通道），新应用只需保证 dispatchEvent 链路接通。
5. **bridge 信任档权限语义**：`ctx.request` 无路径/方法限制（可写操作）、`ctx.wsOn` 不经 'ws-event' slot 门控且可订阅任意事件（含携带聊天内容的 chat.message.*）；只有 `registerEventHandler` 受 slot 约束、isolated 档才有 GET 白名单。迁移时明确保留此差异（或收紧），并写进新插件文档。
6. **isolated 协议的隐式契约**：`source` 常量 `'agentchat-ui-plugin-iframe'` / `'agentchat-ui-iframe-host'` 在 isolated.ts 与 isolated-runtime.ts 两处重复（runtime 里注释明确"此前误写导致宿主永远收不到失败通知"）；`kind:'unload'` 不在 IframeMessage 类型联合内。迁移时两文件同进同出，建议常量与消息类型提为共享模块。
7. **响应式版本号模式**：三个注册表的 resolve\* 函数都靠读 `xxxVersion.value` 建立响应式依赖（动态注册/卸载自动重解析）——新应用渲染层调用点必须放进 computed/render 内，否则插件热装卸不触发重渲染。
8. **pinia 非组件上下文**：host.ts 在模块函数里调 `useWebSocketStore()`，要求组合根先装 pinia；若 #4 用纯模块总线则此约束消失（推荐，顺带消解 host 对旧 stores 目录的依赖）。
9. **p5.5 白名单与新后端对齐**：isolated request 白名单 8 条路径（/api/ui/extensions、/api/ui/slots、/api/config、/api/version、/api/plugins/catalog|permissions|library、/api/plugins/assembly/&lt;id&gt;）与 4 个事件名必须随新应用路由/事件目录同步，否则 isolated 插件全 403。

---

## 结论

extensions 7 文件中 p5.5-policy、index、slots 三个可零改动直迁；types/host/bridge/isolated 四个各需 1–3 行 import 改写（→ 新 protocol / api / ws-bus / registry 路径）。registry 侧 perspectives、eventHandlers 零依赖直迁；messageViews、toolResultViews 需先落 D5/D6 或拆 builtins（D7）才能直迁。
