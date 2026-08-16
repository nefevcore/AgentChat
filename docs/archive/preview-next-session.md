# Preview 下一会话交接 / 学习笔记

> 最后整理：2026-08-15（续·九）
> 用途：会话恢复后，从这里继续“cordis 插件化 preview”的学习与设计。
> 项目状态权威文档仍是 `docs/preview-knowledge-base.md`；本文只保存最近的学习结论与待办。
> **下一会话主线：块 E（L4：preview 整体切换 src）—— ✅ 已于本会话完成；执行记录见 `docs/block-e-migration.md`。**

---

## 1. 当前快照

- preview 已契约化重建完成，35 包（新增 `@agentchat/plugins` + `@agentchat/webui`）+ 7 个本地 vendor 包。
- `pnpm typecheck` 零错误、`pnpm test` 387/387、`pnpm dev` Loader 路径 Ready（WebUI 以插件行启动）。
- WebUI 已是 **源码自包含** 的 cordis 插件：`preview/packages/ui/webui/`（`src/` Vue 源码 + `vite.config.ts` + 内置 `dist/`），不再依赖 preview 外部的 `src/ui/webui/dist`。
- cordis 已本地 vendor 并改别名：

```text
@agentchat/cordis
@agentchat/cordis-loader
@agentchat/cordis-include
@agentchat/cordis-hmr
@agentchat/cordis-logger
@agentchat/cosmokit
@agentchat/schemastery
```

- 钩子命名已统一为 `<插件名>.<钩子>`。
- 首次运行默认 Agent 为 `admin`，tools 由 tags 自动注入。
- WS 入站消息已统一 catch，配置 Key / 发消息不会把进程打挂。

### 本轮（2026-08-15 续·九）已实施：everything-gap 块 A–D 全部完成

1. **块 A（boot 装配拆解，L2）**：
   - `@agentchat/workspace` 新包：工作区初始化插件行（files 指引 / 默认 user/admin / 首次引导），inject `ctx.bootstrap` 后调用 `core.loadAgents()`。
   - archive/timer/subagent 各自新增服务宿主插件行：Manager 由自己 `new` 并写回 `ctx.bootstrap.services`；boot 不再 new 任何业务服务。
   - `@agentchat/server/src/service-plugin`：InteractionBridge/ServiceRegistry/RPCBridge/AgentService/GroupService/HistoryService + ctx 门面（`ctx.l4`）。
   - boot 拆为三行：核心装配（`ctx.bootstrap`）→ 域服务 → 收尾接线（PluginManager/timer 启动/pending flush/archive watcher/`webServerHost`）；`bootstrap.ts` L4 `new` 清零；新增缺行诊断行（5s 后告警缺失服务，进程不崩）。
   - `@agentchat/timer` ctx 服务改名为 `ctx.timerManager`（`ctx.timer` 让给 vendored `@agentchat/cordis-timer`）。
2. **块 B（HTTP 路由注册插件化，L3）**：
   - `HttpRouteRegistry`（ctx.http）：稳定 middleware + register/registerStatic + disposer 精确摘除。
   - WebUIServer 只挂中间件/WS/SPA fallback + route registry；`/api/agents|history|groups` 由 server L4 行注册、传输层通用路由由 server http-routes 行注册、`/api/plugins` 由 plugins http 行（inject pluginManager）注册、`/api/ui` + `/ui-plugin` 由 webui 行注册。
3. **块 C（静态行 HMR）**：
   - vendor `@agentchat/cordis-timer@1.1.3`；`pnpm dev` 加 `--expose-internals`；cordis.yml 挂 timer + hmr 行（`followSymlinks: false`）。
   - 实测改 `packages/examples/hello/src/index.ts` 无需重启热生效；坏语法改动期间旧 fiber 保留，恢复后再次重载成功。
   - 坑：Windows/pnpm 下 watcher 跟随 packages/*/node_modules 符号链接会扫描 pnpm store，导致 CPU 100%、HTTP 挂起（黑屏）；已用 `followSymlinks: false` 修复。
4. **块 D（P5.5 收尾）**：
   - iframe isolated：`ui-plugin-iframe.html`（CSP default-src none + script-src self）+ `isolated-runtime.ts`（受限桥接：request/onEvent/onUnload）+ `isolated.ts`（sandbox=allow-scripts，无 allow-same-origin，父窗口白名单代理 request、白名单事件转发）。不暴露 Vue/注册表。
   - global-style：`p5.5-policy.rewriteGlobalStyle` —— `.ui-plugin-<scope>` 前缀重写、`:root` CSS 变量放行、禁 `url()`/@import/at-rule/javascript:；bridge 增加 `registerGlobalStyle`。
   - CSP：主 SPA `script-src 'self'` + 内联样式 + ws；CSP 审计测试（dist index.html / ui-plugin-iframe.html）。
   - 验证：`pnpm test` **406/406**（新增 http-routes、HttpRouteRegistry、P5.5 策略/CSP、config-save-e2e、prompt-hook 等测试）；`scripts/verify-p5.5.mjs` 真 Edge headless 验收通过（白名单 request 成功，越权 `/api/agents` 被拒）。
5. 关键结论：插件 fiber 内可选读服务必须用 `ctx.get(name)`（直接属性访问会被 cordis 拒绝）；boot-finalize 构造的 PluginManager 也按此修复。
6. **运行时修复（续·九补）**：
   - `ConfigService.reloadGlobalConfig`：保存全局配置时合并默认值（尤其 `viewerId:'user'`）并**原地更新** globalConfig 引用；此前直接覆盖导致 `viewerId` 丢失 → `chat~admin~undefined` 会话。
   - `POST /api/config` 保存后热重载所有已注册 Agent；此前 Agent 继续用旧的 LLM provider（日志显示 gpt-4o/openai），保存新 LLM 后“无法会话”。
   - HMR watcher 配置 `followSymlinks: false`；此前 Windows/pnpm 下跟随 packages/*/node_modules 符号链接扫描 pnpm store → CPU 100%、静态资源挂起、页面黑屏。
   - `agent-prompt` 的 1v1 对话对象从 `dialogId` 反解 counterpart；此前直接用 `ctx.agentId`（self），导致 admin 的系统提示写着「对话对象 admin - 艾吉（自己）」，Agent 把 user 当成艾吉回复。回归测试：`agent-prompt/tests/prompt-hook.test.ts`。
7. **错误重复与重试卡死（续·九补 2）**：
   - `agent-loop` 流式错误路径：`streamLLM` 收到 error token 已 emit `chat.message.error`，随后 `finishReason='error'` 收尾又 emit 一次 → 前端两条错误、持久化一条。现用 `LoopState.errorEmitted` 去重，回归测试断言 `chat.message.error` 恰好一次。
   - `chat.send` 幂等去重从 `to|content`（30s）改为客户端 `requestId`：重连 flush 重发同一 id 仍去重；用户失败后手动重发同一文案会生成新 id，不再被吞 → 修复“更新 API Key 后再次发送无响应”。
   - 前端收到 `chat.send.ack.deduped` 时重置 `turnInProgress` 并重拉历史，避免重连重发后 UI 卡在“进行中”。
8. **新建群聊后页面卡死（续·九补 3）**：
   - `DialogView` 的 `loadingHistory` watch 对群聊也走了 direct 自动续拉：空群聊 `hasMore=true` 且内容不足一屏 → `triggerLoadMore()` 无限递归，页面卡死。
   - 修复：群聊跳过 direct 自动续拉（上翻走 `loadOlderGroupHistory`）；`loadGroupHistory` 只有拉满一页（50 条）才 `hasMore=true`；`loadOlderGroupHistory` 增加 `hasMore` 守卫。
   - 验证：headless Edge 点击群聊 → 显示“群聊开始 — 发送第一条消息吧”，无 `.history-loading`。
9. **群聊发送后一直“Agent 回复中”（续·九补 4）**：
   - `DialogView.groupTurnInProgress` 只置 true、没有接收 `group.delivered` 的复位逻辑 → 发送一次后输入框永久禁用。
   - 修复：新增 `WS_EVENT.groupDelivered`；收到投递确认（或带 group_id 的 error）即复位；10s 兜底解锁；后端 group.message 错误补发 `group_id`。
   - 验证：headless Edge 发送群消息 1.5s 后 textarea `disabled=false`，按钮恢复“发送”。
10. **头像无 fallback（续·九补 5）**：
   - `ui/Avatar.vue` 原来只在 `src` 为空时回退首字，图片 404/加载失败会显示破图；Sidebar 还把无头像的 user 硬编码成 `/api/agents/user/avatar`（204 空响应）。
   - 修复：Avatar 增加 `@error` 监听，加载失败自动切首字；Sidebar 改为直接用 `agentStore.getAgentAvatar(user)`，无头像时传 `null`。
   - 验证：headless Edge 左上角头像渲染为 `ui-avatar-fallback`（首字“用”）。
11. **System Prompt 预览失败（续·九补 6）**：
   - `AgentService.getAgentSystemPrompt` 仍找旧 `buildSystemPrompt` ServiceRegistry 条目；插件化后该实现已变成 `ctx.hooks` 的 `agent-prompt.build-system-prompt` 钩子 → 预览报“服务未注册”。
   - 修复：优先从 `ctx.hooks.find('runStart', ...)` 取工厂并执行，与真实 run 同一实现；保留 ServiceRegistry 旧通道作兜底。
   - 验证：WS `agent.system_prompt` 预览 neko 返回 1264 字符成功。

### 本轮（2026-08-15 续·七）已实施：WebUI 前端源码迁入插件包（完全插件化）

1. `src/ui/webui` 的 **Vue 源码 / vite / tsconfig / index.html / public** 整体迁入 `preview/packages/ui/webui/`；
2. `@agentchat/webui` 现在源码自包含：`src/` 同时含插件后端入口（`index.ts/plugin.ts`）与前端 Vue 源码；`vite build` 直接在包内产出 `dist/`；
3. 配置调整：`vite.config.ts` / `tsconfig.json` 的 `@shared` 指向仓库根 `src/shared`；前端 tsconfig 与插件后端 tsconfig 分离（`tsconfig.json` / `tsconfig.plugin.json`）；preview 根 tsconfig exclude UI 源码（由包内 vue-tsc 负责）；
4. 移除 `scripts/sync-dist.mjs`（不再需要外部同步）；pnpm workspace `allowBuilds` 增加 `vue-demi`；
5. 验证：包内 `vue-tsc` + `tsc` 双 typecheck 0 错误、`vite build` 成功、HTTP 返回的 index/assets 与包内 dist 完全一致；preview `pnpm typecheck` 0 错误、`pnpm test` 387/387。

### 本轮（2026-08-15 续·六）已实施：WebUI 本体改为 cordis 插件（DSH 模型对齐）

1. **新包 `preview/packages/ui/webui`（`@agentchat/webui`）**：内置 `dist/` 前端产物（`scripts/sync-dist.mjs` 从 `src/ui/webui/dist` 同步）；`src/plugin.ts` 声明 `inject: ['webServerHost']`，自行创建 `WebUIServer`（HTTP + WS + REST + SPA）并注册 `ServerService`；关闭/替换 WebUI = 移除/替换 `cordis.yml` 这一行。
2. **boot 只提供宿主依赖**：`WebServerHostService`（ServiceRegistry / 工作区 / 端口 / enabled）由 boot 插件注册；`bootstrap({ deferWebUI: true })` 在 Loader 场景不再直接 start WebUI；直接 `bootstrap()` 路径仍会启动（便于测试/CLI），静态资源统一指向 `@agentchat/webui` 内置 dist。
3. **WebUIServer 可选能力读取修正**：ctx 门面服务改为 `ctx.get()` 可选读取 + ServiceRegistry 回退，避免插件 fiber 因 `historyService` 等未 inject 而直接属性访问抛错。
4. **`cordis.yml`**：新增 `@agentchat/webui/src/plugin` 行（webuiPort: 3830）。
5. **验证**：`pnpm dev` Loader 冒烟显示「WebUI 插件行已启动：http://localhost:3830」；`pnpm typecheck` 0 错误；`pnpm test` 387/387。

### 本轮（2026-08-15 续·五）已实施：P5 深度 UI 扩展（P5.1–P5.4）

1. **manifest.ui 契约**：`PluginUIManifest`（entry/styles/slots/isolated）+ 校验（相对路径、slot 白名单、ui ⇒ permissions 含 ui）；执行期 gate：`manifest.ui` 未授予 `ui` 在 import 前拒绝。
2. **ctx.webui Service**：`WebUIService`（addEntry/listExtensions/getEntryDir/removeEntry）；PluginHost load 成功后挂 UI 资源、dispose 先撤 UI、回滚重挂旧 UI；事件 `ui.extensions.changed`。
3. **发布期 esbuild 构建**：stage 时 `ui/index.ts` → `ui/dist/index.js`（bundle/esm/es2022/external vue，确定性 hash 覆盖构建产物）；prebuilt `ui.entry` 直通；坏 UI 构建拒绝 stage；staging 查看器可读 `ui/dist/index.js`。
4. **服务端托管/API**：`GET /api/ui/extensions`、`GET /api/ui/slots`（8 slot 目录）；`/ui-plugin/:name/*` 静态路由（name 白名单、`..`/绝对路径/符号链接逃逸拒绝、Content-Type 白名单）。
5. **前端 UiExtensionHost**：`core/extensions/{types,host,bridge,slots}`；拉取清单 → 动态 import(entry?version) → install(bridge)；每个 import try/catch 隔离；manifest.ui.slots 运行时白名单核对；卸载逆序执行 disposers；WS `ui.extensions.changed` debounce 同步。
6. **slot v1 接入**：perspective（PerspectiveHost 响应式版本）、tool-result（disposer/unregister）、message-view（renderer map）、ws-event（disposer）、settings-tab:global（SettingsPanel 树动态叶子）、settings-tab:agent（AgentPane 动态页签）、sidebar-action（Sidebar 按钮）；perspectives/messageViews/toolResultViews/eventHandlers 均升级返回 disposer + 同名替换。
7. **参考插件 ui-hello 三连验收（真实 Edge headless + CDP）**：
   - stage（esbuild 构建 ui/dist）→ approve(grants=[ui]) → `/api/ui/extensions` 出现 ui-hello、静态 JS 200；
   - **不刷新页面**：Agent 设置出现「UI Hello」页签，点击渲染插件组件且可交互；
   - 插件 install 契约实调：tool-result `ui_hello` / settings-tab:agent / perspective 三个 slot 全部注册；
   - uninstall → WS 驱动页签消失（无整页 reload）；
   - 重启后端 → `/api/ui/extensions` 恢复，刷新页面后「UI Hello」页签回归。
8. **P5.5 未做**（下轮候选）：iframe isolated 档、`global-style` scoped CSS 注入限制、生产 CSP 审计。

### 本轮（2026-08-15 续·四）已实施：UI/Web 插件化 P4（打磨 + 页面一致性验收）

1. **WS 端到端测试**：新增 `boot/plugin-ws-e2e.test.ts`（真实 WebUIServer + ws 客户端）——
   `stage → plugin.catalog.changed(staging)`、`PUT assembly → agent.assembly.changed` 两个事件实收验证。
2. **会话注册语义对齐 register_plugin**：`registerSessionPlugin` 加载后自动把插件名写入 owner Agent presets；
   `unloadSessionPlugin` 自动回收 presets；saveAssembly 自带热重载 + WS 广播；配套测试覆盖。
3. **权限徽章差异细化**：插件行/卡片对 `permissions` 与 `grantedPermissions` 逐项对比，
   “声明但未授予（重启后可能加载失败）”显式展示。
4. **错误态收尾**：`agentAssemblyError` 独立状态，装配视图加载失败时 Agent 扩展页显示可诊断错误；
   插件库动作错误/成功提示、空态完善。
5. **开发注册 grants 弹窗**：dev 卡片注册会话时，`process/shell/ui` 强制勾选授予（缺勾选禁用按钮），
   与发布 approve 的人审交互一致。
6. **真实浏览器验收（Edge headless + CDP）**：
   - 首页正常加载（`.app-layout` / agent.list 正常）；
   - 设置面板正常打开，树含「Agent 设置 / 模型管理 / 搜索引擎 / 扩展与工具 / 插件库 / 定时任务」；
   - Agent 扩展页：插件组 17 / 工具 27 / 钩子分组计数正确，无错误提示；
   - 插件库页：开发目录卡片显示 manifest/provides/权限，注册会话 grants 弹窗勾选 process 后
     “会话已加载” + admin presets 实收 p4-demo；发布 stage → 待审页签哈希/requiredGrants 正确展示。

### 本轮（2026-08-15 续·三）已实施：UI/Web 插件化 P3（插件库 UI）

1. **四个新组件**（`settings/components/`）：
   - `PluginLibraryPane.vue` —— 已安装 / 待审暂存 / 开发目录三页签 + 刷新 + 错误/成功提示；
   - `PluginCard.vue` —— 版本/owner/权限徽章（声明未授予告警）/卸载（确认框提示 .backup 路径）；
   - `StagingReviewModal.vue` —— 文件树 + 内容预览 + `requiredGrants` 强制勾选（缺勾选禁用批准）+ 哈希 8 位复制 + 批准/拒绝；
   - `PluginDevCard.vue` —— manifest 摘要（provides/权限/目录）+ 注册会话/卸载会话/发布 stage。
2. **设置树新增“插件库”入口**（`selectedNode === 'pluginLibrary'`）；动作后立即刷新 + WS `plugin.catalog.changed` 二次兜底刷新。
3. **后端 P3 补齐**：
   - `PluginInfo.dir`（dev/installed/session 目录暴露，UI stage/register 用）；
   - `POST /api/plugins/session/register`：开发目录 → PluginHost 会话级加载（watch 开启、grants 校验、重启即失、不写 presets——启用去 Agent 面板勾选 preset）；
   - `PluginManager.registerSessionPlugin` + 路由/接口/测试。
4. **端到端验收（临时工作区 3831）**：dev 扫描（dir/owner 暴露）→ session register → session 列表 →
   stage → staging tree/file 人审读取 → approve（grants 校验）→ library installed → **重启同一工作区** →
   installed 恢复、session 清空、`p3_tool/p3-demo.hook` 以 owner 出现在 catalog、admin assembly.available 包含该插件。

### 本轮（2026-08-15 续·二）已实施：UI/Web 插件化 P2（UI 契约迁移）

1. **api.ts 契约层**：新增 `getAssembly/saveAssembly/getCatalog/getLibrary/stage/approve/reject/uninstall/getSession/reloadSession/unloadSession/getPermissions/getStagingTree/getStagingFile`；`core/api/client.ts` 补 `jsonPut`；旧扁平端点标注 deprecated 保留。
2. **useSettings 三块状态**：`agentAssembly`（当前 Agent AssemblyView + 装配字段指纹 dirty）、`pluginCatalog`、`pluginLibrary` + `pluginPermissions`；保存时 presets/tools/hooks **走 PUT assembly**（legacy 发空 patch 让后端归一化），其余字段走 `/api/agents/:id/config`；普通保存不再覆盖装配字段（后端 `AgentService.saveAgentConfig` 保留磁盘现值）。
3. **WS 实时刷新**：`agent.assembly.changed` → 刷新当前 Agent 装配（有未保存编辑不覆盖 raw）；`plugin.catalog.changed / plugin.reload` → 刷新目录 + 装配；`WebSocketClient.onMessage` 返回 disposer，SettingsPanel 卸载时撤销订阅。
4. **AgentPane 迁移**：删除 `builtinDecl/ensureBuiltin/patchBuiltin` 与本地 `getAgentTools` 副本；`decl` 改为 `{ presets, tools, hooks }` 通用 patch；legacy 只读 + 顶部迁移横幅。
5. **ExtToolsPane 迁移**：左导航新增“插件”分组（PluginInfo 开关写 `decl.presets`、来源/版本/权限徽章、未启用置灰）；钩子顺序/开关写 `decl.hooks`；工具自动集合来自 `assembly.tools.enabled`、显式写 `decl.tools`；全局模式改用 `/catalog` 只读目录。
6. **共享类型同步**：`src/shared/types` 与 preview `@agentchat/protocol` 对齐；`settings/types.ts` re-export 给 UI 消费。
7. **验证**：`vue-tsc --noEmit` 零错误；`vite build` 成功（dist 已重建）；preview `pnpm test` 360/360；
   临时工作区 3831 端到端：GET catalog/assembly → PUT assembly → 再 GET 校验 + 静态 index 200 + permissions 词汇（含 `ui`）全部通过。

### 更早（2026-08-15 续）已实施：UI/Web 插件化 P1（后端契约）

> 依据 `docs/ui-web-pluginization-plan.md`（§3/§5 P1 全部完成，进入 P2 前建议过一遍验收清单）。

1. **`ctx.pluginHost` 服务化**：`PluginHost` 改为 cordis Service（构造即注册 `ctx.pluginHost`）；
   `register-core.ts` / `cordis.yml` 新增 `@agentchat/plugins/src/plugin` 服务行（先于 dev 工具行）；
   `loadInstalledPlugins` / `makeRegisterPluginTool` 全部复用 `getOrCreatePluginHost(ctx)`（WeakMap 同一身份缓存）。
2. **manifest `provides`**：`{ tools, hooks }` 可选声明 + 纯函数校验（去重）；
   `getCatalog` 做“声明优先、ToolsService/HooksService owner 反查补漏”的合并。
3. **插件库 uninstall / reject**：`rejectStaging`（删 `.staging` 目录与记录）、
   `uninstallPlugin`（registry 移除 + 目录移 `.backup`，不删 Agent presets）；均有纯函数测试。
4. **暂存人审查看器**：`listStagingFiles` / `readStagingFile`（相对路径白名单、`..`/绝对路径/符号链接逃逸拒绝、1MiB 上限）。
5. **PluginManager 新方法**：`getAssembly / saveAssembly / getCatalog / getLibrary / stage / approve / reject / uninstall / getSession / reloadSession / unloadSession / getPermissions / getStagingTree / getStagingFile`。
6. **REST 契约**：`api/plugins.ts` 拆为 `plugins/catalog.ts + assembly.ts + library.ts` 三个子路由，端点按 §3.2 全量落地：
   `GET|PUT /api/plugins/assembly/:agentId`、`GET /catalog`、`GET /library`、`POST /library/{stage,approve,reject}`、
   `POST /library/:name/uninstall`、`GET /session`、`POST /session/:name/{reload,unload}`、
   `GET /permissions`、`GET /staging/:id/{tree,file}`；旧扁平端点保留一个版本周期（deprecated）。
7. **PUT assembly 语义**：服务端校验三字段 → 临时文件 + rename 原子写盘 → `AgentService.hotReloadAgent` 立即热重载；
   reload 失败回滚文件并返回 500；旧 `plugins` 字段保存时归一化迁移并删除。
8. **WS 事件**：`plugin.catalog.changed / plugin.reload / agent.assembly.changed` 三个事件；
   `PluginEventBus`（server）→ `PluginHost.attachEventSink` → `WSHandler` 订阅广播（复用现有 message 通道 data 字段）。
9. **权限词汇 `ui`（P1 占位）**：manifest 校验/grants/staging requiredGrants/`/permissions` 端点均认 `ui`；
   **执行期 gate 仍只强制 process/shell**（P5 引入 `manifest.ui` 时再把 ui 纳入强制）。
10. **共享类型**：`@agentchat/protocol` 新增 `PluginInfo / HookInfo / AgentToolInfo / AssemblyView / StagingRecord / PluginEventMap`；
    `src/shared/types/index.ts` 已同步（P2 UI 直接消费）。
11. **新测试**：`plugins/plugin-registry.test.ts`、`boot/plugin-manager.test.ts`、`server/plugin-api.test.ts`（+18 用例）。

### 更早（2026-08-15）已实施：Agent 配置新契约 + 插件开发闭环

1. **Agent 配置新契约**（保留 JSON，旧 `plugins` 兼容回退）：
   - `presets: string[]` —— 启用哪些插件（owner = cordis 插件 name；插件级候选过滤，顺序无意义）
   - `tools: string[]` —— 显式工具追加（`requires` 为空的工具只能在此启用）
   - `hooks: HookNames` —— 全局钩子顺序表（顺序即执行顺序；未启用插件的钩子也照写，启用后自动生效）
2. **注册归属制**：`ToolsService` / `HooksService` 的 register/registerFactory 全部带 `owner`；
   `unregister(owner)` 精确回收；`resolveTools` / `hooks.collect` 按 `config.presets` 过滤；
   `presets` 缺省 = 旧契约语义（不过滤，保证迁移兼容）。
3. **`@agentchat/plugins` 新包**：
   - `PluginManifest`（name/version/entry/inject/config/permissions）+ 纯函数校验（在 agent-config 定义，plugins 包 re-export）
   - `PluginHost`：动态 import + `ctx.plugin(module)` + fiber 跟踪；同名重载先 dispose 旧 fiber 并回收 owner 注册；会话级加载不得覆盖已安装插件
   - 插件库 registry：`<workspace>/plugins/registry.json`；`stagePlugin / listStaging / approveStaging / listInstalled / loadInstalledPlugins`
4. **dev 新工具**（均 `requires:['admin']`）：
   - `register_plugin`：`<ws>/plugins/<agentId>/<name>` 开发目录 → 会话级动态加载（默认开源码监听）→ 写 `presets` → `reload-requested(self)` 中断立即生效
   - `unregister_plugin`：会话级卸载 + 回收 presets
   - `publish_plugin`：`stage`（校验/暂存/哈希，待宿主人审）→ `approve`（安装进全局插件库，同名同版本拒绝、新版本旧版入 `.backup`，并即时装载）
5. **启动扫描**：bootstrap 在装配前执行 `loadInstalledPlugins(ctx, workspaceDir)`；已安装插件重启自动恢复。
6. **安全边界**：动态 import = 插件代码进宿主进程；会话级加载不落盘（重启即失）；发布必须两段式人审。
7. **同名替换语义**：`ToolsService.register` 支持 `{ replace: true }`；`register_tool` 运行时注册默认替换旧同名工具并遮蔽同名工厂工具，owner 卸载后工厂恢复。
8. **权限执行期强制**：`manifest.permissions` 词汇表 `fs/network/process/shell`；`fs/network` 默认授予，`process/shell` 必须 `grants` 显式授予；检查发生在 dynamic import 之前（未授予代码不进进程）；发布 approve 的授予快照写入 `registry.json`，启动扫描按快照恢复。
9. **开发期自动重载**：`PluginHost` 支持 `watch`（750ms 哈希轮询），源码变化自动 fiber dispose + 重挂；新模块 import/激活失败自动回滚旧实例；`PluginHostOptions.importModule` 为 loader/HMR 集成扩展点。
10. **后端遗留修复（UI 插件化审计）**：新建 Agent 模板改 `presets/tools/hooks`；`update_agent_profile` 支持新字段并落盘 config.json；`security-check` 校验 presets/tools/hooks。
11. **UI/Web 插件化契约已冻结**：见 `docs/ui-web-pluginization-plan.md`（AssemblyView、插件库 REST/WS 契约、UI 结构、四阶段实施）。

---

## 2. 已搞清楚的 cordis 概念

1. `Context` = 运行时共享容器；`Service` 挂到 ctx；插件 = `{ name, inject, apply }`。
2. `inject` 决定激活顺序，不满足则 Fiber 处于 PENDING 等待，不是进程阻塞。
3. 可选能力不应用 `inject` 硬依赖，应使用：

```ts
// 方案 A：启动时判断，缺失则降级
const tools = ctx.get?.('tools')
if (!tools) return

// 方案 B：主插件立即启动，能力后到自动补上
ctx.inject(['tools'], (ctx) => { ... })
```

4. cordis.yml 行序不决定启动顺序；服务提供与 inject 消费决定激活顺序。
5. 当前 preview 是“单 Context 多 Agent”：`ctx.tools` / `ctx.hooks` / `ctx.llm` 全局共享，
   工具与钩子按 Agent 配置在每次投递时烘焙。
6. **能力解析流水线（新契约）**：

```text
全部注册(全局, 带 owner) → presets 过滤(插件级) → tags 匹配(工具级 requires)
                          → tools 显式追加 / hooks 顺序表收集 → 烘焙
```

   规则钉死：
   - `hooks.<kind>` 数组顺序 = 执行顺序；presets 顺序无意义（Set 语义）。
   - 顺序表里的钩子名未注册 → 跳过（允许“先配置、后安装插件”）。
   - 钩子名未启用（owner 不在 presets）→ 跳过，但顺序位置仍由顺序表决定。

---

## 3. 热重载现状（已学结论）

| 场景 | 是否支持 | 机制 |
|---|---|---|
| Agent 注册新工具 | ✅ | `register_tool` → `ctx.tools.register`（owner=`runtime:register-tool:<id>`，always=true）→ 下次投递重新烘焙 |
| Agent 修改自身 config | ✅ | `reload` 工具 → `reload-requested` 中断 → `performReload` → registry 覆盖 |
| Agent 开发完整插件 | ✅ | `register_plugin` → `PluginHost.load` → dynamic import + `ctx.plugin(module)` → 写 presets → reload 中断 |
| 会话级插件更新/卸载 | ✅ | 同名 `register_plugin` 重载（先 dispose 旧 fiber，失败回滚）；`unregister_plugin` 回收 owner 注册 + presets |
| 发布到全局插件库 | ✅ | `publish_plugin stage → approve`；bootstrap 扫描 registry.json 启动恢复 |
| 开发者改插件源码 HMR | ✅（动态插件） | `register_plugin` 自动开启 `watch`：哈希轮询 → 自动重挂（失败保留旧版）；cordis.yml 静态行仍待挂 `@agentchat/cordis-hmr`（需补 vendor cordis-timer + loader 内部暴露） |

关键边界：

- 改自己的 `config.json`：只影响该 Agent。
- 改全局注册中心里的工具：其他 Agent 后续会话也会变。
- 正在运行中的 `CurrentContext` 不受影响，除非显式 `performReload`。
- 同名工具当前“先注册者胜”；动态插件经 fiber dispose + `unregister(owner)` 后可干净替换，
  但 `register_tool` 运行时工具仍不覆盖同名（留待 replace 语义）。

---

## 4. 下一会话建议继续的方向

### 方向 E：UI/Web 插件化 P5.5 —— ✅ 已实施（本轮）

```text
P5.5 收尾（全部完成）：
  · iframe isolated 档（sandbox allow-scripts；父窗口白名单 request + 受控 postMessage 事件；不暴露 Vue/注册表）
  · global-style slot（.ui-plugin-<scope> 前缀重写 + 禁 url() 外链/at-rule）
  · 生产 CSP 审计（self + 内联样式 + ws；isolated 容器 default-src none）
静态行 HMR：✅ 已实施（vendor @agentchat/cordis-timer + --expose-internals）
```

### 方向 A：register_plugin / publish_plugin —— ✅ 已实施（后端）

```text
Agent 在 <ws>/plugins/<agentId>/<name>/ 写插件（manifest.json + entry）
  → register_plugin：PluginHost 动态 import → ctx.plugin(module) → fiber 跟踪
  → 写本 Agent config.presets → reload-requested(self) → 本轮立即重烘焙
  → publish_plugin stage → 宿主人审 → approve → <ws>/plugins/registry.json
  → 重启后 loadInstalledPlugins 扫描恢复
```

仍需打磨（低优先级）：

1. 发布前 dry-run 加载 + 内置插件名保留字清单；
2. 插件库 registry 的 UI 展示（安装清单/授予权限/卸载入口）；
3. cordis.yml 静态插件行的 HMR（`@agentchat/cordis-hmr` 需要 `cordis-timer` + loader 内部暴露，暂未 vendor）。

### 方向 B：per-Agent cordis.yml / child Context —— 本轮决定不做

结论：共享 root ctx + presets/tools/hooks 烘焙已满足当前需求；child Context 收益不大，暂停。

### 方向 C：可选依赖 / 优雅降级

把可选能力插件从硬 `inject` 改成 `ctx.get?.('tools')` 判断或 `ctx.inject(['tools'], ...)`。仍为候选。

### 方向 D：整体切换 src —— ✅ 已实施（块 E，本会话）

preview 已整体切换为根目录 `src/`：

```text
packages/*/* → src 对应目录
preview/vendor/* → src/vendor/*
```

判据已全部通过：根目录全量 typecheck/test/build + desktop 打包 + `pnpm dev` 冒烟（详见 `docs/block-e-migration.md`）。

---

## 5. 继续学习推荐顺序

```text
1. preview/cordis.yml
2. packages/core/agent-config/src/{index,manifest}.ts
3. packages/plugins/plugins/src/{host,registry}.ts      ← 新插件域
4. packages/core/tools/src/service.ts                    ← owner/presets 过滤
5. packages/core/hooks/src/service.ts                    ← owner/顺序表
6. packages/dev/dev/src/{plugin-tools,register-tool}.ts
7. packages/boot/boot/src/{bootstrap,loader}.ts          ← 启动扫描 + pluginManager API
8. packages/agents/agents/src/config.ts                  ← 新契约装配
```

对照 vendor：

```text
vendor/cordis/src/context.ts
vendor/cordis/src/service.ts
vendor/cordis/src/fiber.ts
vendor/cordis/src/registry.ts
```

---

## 6. 验证命令

```powershell
cd C:\Users\xiaofeng\Documents\Dev\AgentChat\preview
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

改前端后构建（源码在 WebUI 插件包内，preview 自包含）：

```powershell
cd C:\Users\xiaofeng\Documents\Dev\AgentChat\preview\packages\ui\webui
pnpm build
# 或直接：
# .\node_modules\.bin\vue-tsc.cmd --noEmit -p tsconfig.json
# .\node_modules\.bin\vite.cmd build
```

---

## 7. 未决问题（可直接选一个继续）

1. ~~是否实现 `register_plugin`？~~ ✅ 已实现（含 unregister_plugin / publish_plugin）。
2. ~~工具修改是否需要 `owner` / 版本 / 替换语义？~~ ✅ 动态插件按 owner 回收；`register_tool` 同名 replace 已实现（后注册者胜，owner 卸载后工厂恢复）。
3. ~~per-Agent cordis.yml 只做实验，还是进主线？~~ 本轮决定：不做（child Context 暂停）。
4. 是否给可选工具/钩子行改成优雅降级？——仍开放。
5. ~~何时整体切换 src？~~ ✅ 已切换（块 E，2026-08-15）。
6. ~~插件库 manifest `permissions` 是否接入执行期强制 / UI 展示？~~ ✅ 已接入（load 前拒绝 + approve grants + registry 快照 + UI 徽章/grants 弹窗/暂存人审）。
7. cordis.yml 静态插件行的 `@agentchat/cordis-hmr` 是否挂上？（需补 vendor `cordis-timer`；动态插件 HMR 已由 PluginHost watch 覆盖）——仍开放。
8. ~~按 `docs/ui-web-pluginization-plan.md` 的 P1 阶段开始实施~~ ✅ P1–P4 及 P5.1–P5.4 全部完成；**剩余 = P5.5（iframe isolated / global-style / CSP 审计）**。参考插件 ui-hello 三连验收已通过。
9. **“一切皆插件”剩余差距** → `docs/everything-plugin-gap-plan.md` 块 A/B/C/D/E 已全部完成；L4 全量切 src 完成。
