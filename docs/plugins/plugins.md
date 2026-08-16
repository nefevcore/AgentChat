# @agentchat/plugins
> 包路径 `src/plugins/plugins` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
插件域包：`PluginManifest` 契约（re-export 自 `@agentchat/agent-config`）+ 全局插件库 registry（staging/approve/install）+ `PluginHost`（动态 import + cordis Fiber 生命周期 + owner 回收）+ 权限授予策略 + UI 扩展服务（`ctx.webui`）+ `/api/plugins` 路由行。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | 插件行 `agentchat-plugin-host`：`ctx.pluginHost` |
| `host.ts` | `PluginHost`：load/unload/reload、权限门、inject 预检、回滚、watch 轮询、事件 |
| `registry.ts` | 全局插件库：`stagePlugin/approveStaging/rejectStaging/uninstallPlugin/listInstalled/loadInstalledPlugins` |
| `permissions.ts` | 权限词汇与授予策略（默认授予/显式要求/执行期 gate） |
| `http-plugin.ts` | 插件行 `agentchat-plugin-http-routes`：注册 `/api/plugins` |
| `webui-service.ts` | `ctx.webui`：UI 扩展清单与 `/ui-plugin/:name/*` 目录映射 |
| `index.ts` | re-export（含 `@agentchat/agent-config`） |

## 插件行

| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| `plugin.ts` | `agentchat-plugin-host` | `[]` | `ctx.pluginHost = PluginHost`（动态插件装载器服务行） |
| `http-plugin.ts` | `agentchat-plugin-http-routes` | `['http','pluginManager']` | 注册 `/api/plugins`（`createPluginsRouter(manager)`），挂/摘本行即挂/摘路由 |

## 提供的能力

### PluginHost 生命周期（load/unload/reload）

`load(spec)` 顺序：

1. `validatePluginManifest` 校验 manifest。
2. 权限 gate（import 前）：`assertPermissionsGranted(manifest, allowedPermissions)`，未授予的高危权限直接抛错，插件代码不进进程。
3. 入口检查：`dir/manifest.entry`（缺省 `index.ts`）必须存在。
4. inject 预检：`manifest.inject` 逐项 `ctx.get(dep)`，未提供即抛错（避免 cordis PENDING 挂死）。
5. 会话级加载不得覆盖已安装插件（`sessionOnly` 不能替换 `installed`）。
6. 动态 `import(pathToFileURL(entry) + '?t=' + Date.now())`（cache-busting）；校验模块有 `apply`，`plugin.name` 与 `manifest.name` 一致。
7. 同名替换：先 `disposeRecord(old)` 回收旧实例，再 `ctx.plugin(module, manifest.config ?? {})` 激活；新模块激活失败 → `cleanupOwner` + 重新激活旧模块回滚，并 `notifyReload({status:'failed'})`。
8. `mountRecord`：登记 `loaded` Map；`watch` 开启轮询；`manifest.ui` 存在则 `mountUi`（`ctx.webui.addEntry`）。
9. 事件：新装/替换分别发 `plugin.catalog.changed` / `plugin.reload`；返回 `{name, status:'loaded'|'replaced', entry, fiberUid}`。

- `reload(name)`：重读 `manifest.json`（name 变化拒绝），沿用原 `allowedPermissions/watch` 后走 `load`。
- `unload(name)`：`disposeRecord` → `notifyCatalogChanged`。
- `disposeRecord` 顺序：UI 扩展先卸载 → `stopWatcher` → `cleanupOwner`（`tools.unregister(owner)` + `hooks.unregister(owner)`）→ `fiber.dispose()`。
- watch：`hashDir`（SHA-256，排序相对路径 + 文件内容，排除 `node_modules/.git/.staging/.backup`），每 `750ms` 轮询；变化自动重载，失败保留旧实例。**作用域仅限该插件目录与该插件 Fiber**——不重载其他插件行、不重启进程；重载沿用首次授予的权限（不重新审批）。入口 URL 带时间戳 cache-bust，插件内其它模块仍走 Node 模块缓存。
- 与 `@agentchat/cordis-hmr` 的区别：后者是面向整个 `src` 的静态 HMR（当前在 cordis.yml 默认注释），改动共享/框架模块可能触发多插件局部重载，命中 externals 时直接 `loader.exit()` 整进程重载；PluginHost 的 per-plugin watcher 不做这些。
- 事件：`plugin.catalog.changed` / `plugin.reload` / `agent.assembly.changed` / `ui.extensions.changed`，经 `attachEventSink` 接入 boot 的 `PluginEventBus` 再广播 WS。

### 全局插件库（registry.ts）

目录约定（`<workspace>/plugins/`）：

| 路径 | 说明 |
| --- | --- |
| `registry.json` | 安装记录（`{version:1, plugins:{name → InstalledPluginRecord}}`） |
| `<name>/` | 已安装插件源码（manifest.json + 入口 + 源码） |
| `.staging/<id>/` + `.staging/<id>.json` | 待审查暂存副本与记录 |
| `.backup/<name>-<ver>-<ts>/` | 被替换/卸载的旧版本 |

关键函数：

| 函数 | 语义 |
| --- | --- |
| `stagePlugin(workspaceDir, sourceDir, owner)` | 校验 → 复制到 `.staging/<id>` → 若 `manifest.ui` 用 esbuild 构建 `ui/index.ts` → 计算哈希 → 写记录 |
| `approveStaging(workspaceDir, id, grants?)` | 权限校验（`grantPermissions` + `assertPermissionsGranted`）→ 哈希一致性校验 → 同版本拒绝 → 旧版本移 `.backup` → staged rename 为目标目录 → 写 `registry.json` |
| `rejectStaging` | 删除暂存目录与记录 |
| `uninstallPlugin` | 目录移 `.backup` + registry 移除；不修改任何 Agent 的 `presets` |
| `listInstalled` / `listStaging` | 已安装/待审清单 |
| `listStagingFiles` / `readStagingFile` | 人审查看器：路径守卫 + 符号链接检查 + 1 MiB 上限 |
| `loadInstalledPlugins(ctx, workspaceDir)` | 启动扫描：按 registry 权限快照逐个 `host.load`，失败跳过不阻断启动 |

发布 ≠ 启用：安装只让插件进入插件库并可在启动时扫描加载；Agent 需在 `config.presets` 中引用 `manifest.name` 才真正启用。

### 权限策略（permissions.ts）

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `DEFAULT_GRANTED_PERMISSIONS` | `['fs','network']` | 默认授予，无需人工审批 |
| `EXECUTION_EXPLICIT_REQUIRED` | `['process','shell']` | 执行期强制显式授予 |
| `REVIEW_EXPLICIT_REQUIRED` | `['process','shell','ui']` | UI 审查层需宿主显式勾选（`ui` 执行期 gate 在 P5 接入） |
| `missingPermissions` | — | `manifest.permissions` 中未授予的执行期强制项；`manifest.ui` 存在时补 `ui` |

`grantPermissions(grants)`：默认权限 + 显式 grants 去重；未知权限抛错。

### UI 扩展（webui-service.ts）

`ctx.webui = WebUIService`（首个 `manifest.ui` 插件装载时创建）。`addEntry(name, version, dir, ui, status, grantedPermissions)`：校验 `ui.entry`（缺省 `ui/dist/index.js`）与 `ui.styles` 文件存在；同名替换先调旧 disposer；产出 `UIExtensionDescriptor`（`entry: /ui-plugin/<name>/<rel>`，`slots`，`isolated` 等）。`listExtensions()` 供 `GET /api/ui/extensions` 直接读；`getEntryDir()` 供 `/ui-plugin/:name/*` 静态路由解析。

### /api/plugins 路由（plugins 域 + host/server 的 api/plugins.ts）

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/plugins` | 旧兼容：全部内置插件列表 |
| `GET /api/plugins/schemas` / `/llm-schemas` / `/search-schemas` | 配置 Schema |
| `GET /api/plugins/tools/:agentId` | Agent 工具清单（catalog/enabled/explicit） |
| `GET|POST /api/plugins/:agentId` | 旧兼容：Agent 插件/钩子启用 |
| `GET /api/plugins/catalog` | 全量目录（plugins/hooks/tools） |
| `GET /api/plugins/permissions` | 权限词汇表 |
| `GET /api/plugins/global/hooks` / `/global/tools` | 全局钩子/工具目录 |
| `GET /api/plugins/assembly/:agentId` / `PUT /api/plugins/assembly/:agentId` | 装配视图与保存（热重载 + WS 广播） |
| `GET /api/plugins/library` | 已安装 + 暂存 |
| `POST /api/plugins/library/stage` / `approve` / `reject` | 发布两阶段 |
| `POST /api/plugins/library/:name/uninstall` | 卸载 |
| `GET /api/plugins/session` / `POST /session/register` / `POST /session/:name/reload|unload` | 会话级开发插件 |
| `GET /api/plugins/staging/:id/tree` / `file` | 人审代码查看 |

## 关键契约 / API

```ts
interface PluginLoadSpec {
  manifest: PluginManifest;
  dir: string;            // manifest.json 所在目录
  agentId?: string;       // sessionOnly 归属
  sessionOnly: boolean;   // false = 插件库安装；true = 会话级
  allowedPermissions?: PluginPermission[];  // 缺省 fs/network
  watch?: boolean;
}
interface PluginLoadResult {
  name: string;
  status: 'loaded' | 'replaced' | 'restored';
  entry: string;
  fiberUid: number | null;
}
// PluginHost 事件（经 PluginEventBus 广播）
PLUGIN_EVENT.CATALOG_CHANGED / RELOAD / ASSEMBLY_CHANGED / UI_EXTENSIONS_CHANGED
```

## 配置
本包无独立插件配置命名空间。行为常量集中在源码：watch 轮询 `750ms`；staging id 正则 `^[a-z0-9-]+$`；安装名正则 `^[a-z0-9][a-z0-9-]*$`；人审文件上限 `1 MiB`；默认 UI 入口 `ui/dist/index.js`；esbuild 浏览器打包 `format:'esm', platform:'browser', target:'es2022', external:['vue']`。

## 与其他插件的关系
- 依赖：`@agentchat/agent-config`、`cordis`、`hooks`、`protocol`、`server`（仅 `createPluginsRouter` 与类型）、`tools`、`esbuild`。
- 使用方：
  - `@agentchat/boot`：`getOrCreatePluginHost(ctx)` + `attachEventSink` + `loadInstalledPlugins` + `makePluginManager`。
  - `@agentchat/server`：`WebUIServer` 通过 `ctx.get('webui')` 提供 `/api/ui/extensions` 与 `/ui-plugin` 静态路由；WSHandler 订阅插件域事件广播。
  - 各工具领域行：通过 `ToolsService/HooksService` 的 owner 注册被 `cleanupOwner` 回收。
- 方向约束：插件域不 import `@agentchat/boot`。

## 测试
package.json 的 test 脚本为 `vitest run`。测试文件：`tests/plugin-host.test.ts`、`plugin-registry.test.ts`、`webui-service.test.ts`。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
