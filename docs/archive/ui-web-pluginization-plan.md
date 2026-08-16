# UI/Web 插件化 —— 设计方案与后端契约

> 整理：2026-08-15
> 状态：**P1–P5.5 已全部实现（2026-08-15）**：isolated iframe 档、`global-style` scoped CSS 注入限制、生产 CSP 审计完成。WebUI 本体已重构为 `@agentchat/webui` cordis 插件，**前端源码已迁入 `preview/packages/ui/webui/src`（源码 + dist 自包含，对齐 DSH）**。实施记录见 `docs/preview-next-session.md`。
> 配套文档：`docs/preview-next-session.md`（后端插件化现状）、`docs/preview-knowledge-base.md`（权威知识库）

---

## 0. 目标

把 WebUI 从“写死 builtin 插件目录 + 旧 plugins 声明”迁移为**完全由后端注册中心驱动的插件管理界面**：

1. Agent 能力编辑：`presets / tools / hooks` 三字段可视化（与后端新契约一一对应）；
2. 插件生命周期管理：开发目录 → 会话级加载/卸载 → 发布暂存 → 人审 → 安装/替换/卸载；
3. 权限可见性：manifest 权限、grant 快照、暂存哈希全程透明展示；
4. UI 不再维护插件目录副本：目录、状态、顺序全部来自后端。

原则：

- **单真相源**：UI 只渲染后端 `/api/plugins/*` 的返回；钩子顺序 = `config.hooks`，启用 = `config.presets`，显式工具 = `config.tools`。
- **人审闭环不可绕过**：`approve` 永远由宿主用户在 UI 上确认（含 grants 勾选），Agent 工具路径保留但 UI 不提供“一键免审”。
- **渐进迁移**：旧 `plugins` 声明在 UI 中**只读兼容**；用户一旦在 UI 编辑，即写新契约（后端做一次归一化迁移）。

---

## 1. 现状盘点（审计结论）

### 1.1 后端已就绪（preview）

- `AgentConfig`：`presets / tools / hooks`（旧 `plugins` 兼容回退）；
- `ToolsService/HooksService`：owner 归属、presets 过滤、unregister、同名 replace；
- `@agentchat/plugins`：manifest 校验、PluginHost（动态加载/watch/回滚）、权限策略、插件库 registry（stage/approve/install/扫描）；
- dev 工具：`register_plugin / unregister_plugin / publish_plugin`；
- 已修复的遗漏：新建 Agent 模板、`update_agent_profile`（新字段 + 落盘）、`security-check` 新字段校验。

### 1.2 UI 现状（src/ui/webui/src/settings）

| 文件 | 现状 | 迁移方向 |
|---|---|---|
| `api.ts` | 只有 schema + getAgentPlugins/getGlobal*/getAgentTools | 增加插件库/暂存/权限/会话端点 |
| `types.ts` | `PluginMeta` 只有钩子元数据 | 扩展 `PluginInfo/HookInfo/StagingRecord` |
| `useSettings.ts` | `agentPlugins` 一个数组 | 拆 `agentAssembly + pluginLibrary + staging` 三块状态 |
| `AgentPane.vue` | `builtinDecl()/patchBuiltin()` 读写真 `raw.plugins` | 改为 `raw.hooks/raw.tools/raw.presets` 的通用 patch |
| `ExtToolsPane.vue` | `decl` 模型 = `{ runStart[], tools[] }` | decl 改为 `{ hooks, tools, presets }` 三合一视图 |
| 全局设置面板 | 只读 hooks/tools 目录 | 保持只读目录 + 新增“插件库”管理页 |

### 1.3 关键断点

- `GET /api/plugins/:agentId` 目前返回**扁平数组**（钩子 + 工具项混排），UI 需要先归一化；
- `POST /api/plugins/:agentId` 只写 runStart/runEnd，**不写 presets/tools，不热重载 registry**；
- 后端没有“插件库查询 / 暂存列表 / 卸载”的 HTTP 端点（只有 Agent 工具）；
- `PluginHost` 实例散落在 boot 扫描与 dev 插件里，没有作为 ctx 服务暴露，HTTP 层无法操作会话插件。

---

## 2. 目标信息模型

### 2.1 三类核心对象

```text
PluginInfo   —— 一个可装载插件（内置 / 已安装 / 开发中 / 会话中）
HookInfo     —— 一个注册钩子（owner 插件 + kind + 元数据）
AssemblyView —— 一个 Agent 的能力装配快照（presets + hooks 顺序表 + tools 显式清单）
StagingRecord—— 发布暂存待审条目（含哈希、源目录、授予前权限）
```

### 2.2 共享类型（放 `@agentchat/sdk-protocol` + UI `types.ts`）

```ts
export type PluginPermission = 'fs' | 'network' | 'process' | 'shell' | 'ui';

export interface PluginInfo {
  name: string;                 // manifest.name = preset id
  label?: string;               // UI 展示名
  description?: string;
  version?: string;
  source: 'builtin' | 'installed' | 'dev' | 'session';
  permissions?: PluginPermission[];
  grantedPermissions?: PluginPermission[];  // installed/session 才有
  owner?: string;               // 发布者/会话归属 Agent
  installedAt?: string;
  entry?: string;
  /** 权威能力声明（manifest.provides 或注册中心反查） */
  provides?: { tools: string[]; hooks: string[] };
}

export interface HookInfo {
  name: string;                 // '<plugin>.<hook>'
  kind: HookKind;               // runStart / runEnd / stepStart / stepEnd / toolExecutionStart / toolExecutionEnd / fallback
  label: string;
  description?: string;
  owner: string;                // cordis 插件 name（preset id）
  configNs?: string;            // 配置命名空间（UI 弹窗）
  security?: boolean;           // 只读安全概览
}

export interface AgentToolInfo {
  name: string; label?: string; description?: string;
  requires?: string[]; ns?: string; owner?: string;
}

export interface AssemblyView {
  agentId: string;
  /** presets：启用哪些插件（顺序无意义） */
  presets: string[];
  /** 已安装/开发中但未启用的插件 */
  available: PluginInfo[];
  /** hooks：顺序表（顺序即执行顺序）+ 全量目录 */
  hooks: {
    order: Partial<Record<HookKind, string[]>>;
    catalog: HookInfo[];
  };
  /** tools：显式清单 + 全量目录 + 当前生效集合 */
  tools: {
    explicit: string[];
    enabled: string[];          // resolveTools 实际烘焙结果
    catalog: AgentToolInfo[];
  };
  legacy?: { hasPlugins: boolean };  // 旧契约只读标记，提醒迁移
}

export interface StagingRecord {
  id: string;
  manifest: { name: string; version: string; entry?: string; permissions?: PluginPermission[] };
  sourceDir: string;
  hash: string;
  owner: string;
  createdAt: string;
  /** 需要宿主显式授予的高危权限（process/shell） */
  requiredGrants: PluginPermission[];
}
```

### 2.3 权限展示规则（UI 硬性要求）

- `fs/network`：徽章显示“默认授予”；
- `process/shell`：徽章显示“需显式授予”，勾选框在 approve 弹窗强制呈现；
- `ui`：**UI 扩展权限**（深度 UI 插件必需，见 §7），同 process/shell 一样需显式授予，approve 弹窗强制勾选；
- 已安装插件的 `grantedPermissions` 与 manifest 声明逐项对比，缺项显示“声明但未授予（重启后可能加载失败）”。

---

## 3. 后端契约（评审冻结范围）

### 3.1 现状保留（兼容期不动）

```text
GET  /api/plugins/schemas
GET  /api/plugins/llm-schemas
GET  /api/plugins/search-schemas
GET  /api/plugins/global/hooks
GET  /api/plugins/global/tools
```

### 3.2 新增 / 变更端点

#### ① Agent 装配视图

```http
GET /api/plugins/assembly/:agentId
→ { assembly: AssemblyView }        # 替代 GET /api/plugins/:agentId 的扁平数组

PUT /api/plugins/assembly/:agentId
body: {
  presets?: string[],
  tools?: string[],
  hooks?: { runStart?: string[], ... }   # 七类顺序表
}
→ { success: true, assembly: AssemblyView }
```

语义：

- 服务端校验：`presets/tools` 字符串数组；`hooks` 七类全字符串数组；
- 写盘 = 读 `config.json` → 覆盖三字段 → 写回；
- **立即热重载**：调用 `AgentService.hotReloadAgent(agentId, agentDir)`（bootstrap 已有 loader）；
- 旧 `plugins` 字段在写新契约时由后端做归一化（见 §3.4），并删除旧字段。

#### ② 插件目录（全量，替代 getAllPlugins 的硬编码）

```http
GET /api/plugins/catalog
→ { plugins: PluginInfo[], hooks: HookInfo[], tools: AgentToolInfo[] }
```

后端来源：

- `plugins` = 内置清单（由各插件行注册时上报）+ `listInstalled()` + dev 目录扫描 + 会话 PluginHost 列表；
- `hooks` = `HooksService` 全量（含 owner）；
- `tools` = `ToolsService.listAll()`（工厂用空 Agent 烘焙做目录）。

#### ③ 插件库生命周期

```http
GET    /api/plugins/library
→ { installed: PluginInfo[], staging: StagingRecord[] }

POST   /api/plugins/library/stage
body: { dir: string; owner: string }
→ { staging: StagingRecord }           # 复用 @agentchat/plugins.stagePlugin

POST   /api/plugins/library/approve
body: { id: string; grants?: PluginPermission[] }
→ { installed: PluginInfo }            # 复用 approveStaging（人审 = UI 按钮点击）

POST   /api/plugins/library/reject
body: { id: string }
→ { success: true }                    # 删除 .staging 目录与记录

POST   /api/plugins/library/:name/uninstall
→ { success: true, backupDir?: string }
# 新后端能力：registry 移除 + 目录移 .backup + ctx.pluginHost.unload(name)
```

#### ④ 会话插件（开发态）

```http
GET    /api/plugins/session
→ { plugins: PluginInfo[] }            # PluginHost 中 sessionOnly=true 的记录

POST   /api/plugins/session/:name/reload
→ { status: 'loaded' | 'replaced' }
POST   /api/plugins/session/:name/unload
→ { success: true }
```

#### ⑤ 权限词汇表

```http
GET /api/plugins/permissions
→ {
  vocabulary: ['fs','network','process','shell','ui'],
  defaultGranted: ['fs','network'],
  explicitRequired: ['process','shell','ui']
}
```

#### ⑥ 暂存代码查看（人审必需）

```http
GET /api/plugins/staging/:id/tree
→ { files: Array<{ path: string; size: number }> }

GET /api/plugins/staging/:id/file?path=<rel>
→ { path: string; content: string }
```

安全：路径只允许相对、拒绝 `..` 与绝对路径；只读。

### 3.3 WS 事件（供 UI 实时刷新）

| 事件 | 载荷 | 触发 |
|---|---|---|
| `plugin.catalog.changed` | `{ kind: 'installed'|'staging'|'session' }` | stage/approve/reject/uninstall/register/unregister |
| `plugin.reload` | `{ name, status: 'loaded'|'replaced'|'failed', error? }` | PluginHost watch 重载结果 |
| `agent.assembly.changed` | `{ agentId }` | PUT assembly 后广播（多端同步） |

复用现有 WS `message` 通道的 data 字段，不新增 socket 协议版本。

### 3.4 旧契约归一化（后端，一次性）

`PUT /api/plugins/assembly/:agentId` 保存前执行：

```text
若 config.plugins 存在且 config.presets 不存在：
  presets = hooks owner ∪ tools owner（按钩子名/工具名反查注册中心）
  hooks   = collectHookNames(plugins)
  tools   = collectToolNames(plugins)
  delete config.plugins
```

`GET /api/plugins/assembly/:agentId` 对旧配置**动态展示**同样结果，但带 `legacy.hasPlugins=true`，UI 显示“旧契约配置，保存后迁移”。

### 3.5 后端实现前置（P1 已全部完成 ✅）

1. ✅ **`ctx.pluginHost` 服务化**：boot 创建 `PluginHost` 并挂 Service；`loadInstalledPlugins` 与 dev 工具共用同一个实例；HTTP 层可卸载/重载。
2. ✅ **manifest 增加 `provides`**（可选声明）：`{ tools: string[], hooks: string[] }`；`validatePluginManifest` 校验；注册后与 `ToolsService/HooksService` 实际 owner 反查合并（声明优先，注册中心补漏）。
3. ✅ **插件库 uninstall / reject**：在 `@agentchat/plugins/registry.ts` 增加纯函数，配测试。
4. ✅ **makePluginManager 扩展**：新增 `getAssembly/saveAssembly/getCatalog/library*` 方法，注入 `AgentService`（或 loader + registry）。
5. ✅ **api/plugins.ts 重构**：拆 `assembly.ts / library.ts / catalog.ts` 三个子路由，`PluginManager` 接口同步。
6. ✅ **协议共享类型**：`@agentchat/sdk-protocol` 增加 §2.2 类型；UI `@shared/types` 同步。

---

## 4. UI 设计方案

### 4.1 设置面板结构调整

```text
Settings
├── 全局设置
│   ├── 现有（模型池/配置/Schema）
│   ├── 扩展与工具（保持只读目录）
│   └── 插件库（新增页签）
│       ├── 已安装：PluginInfo 列表（版本/owner/权限徽章/卸载）
│       ├── 待审：StagingRecord 列表（文件树预览 + 授予勾选 + 批准/拒绝）
│       └── 开发：<ws>/plugins/<agentId>/* 扫描（会话加载/卸载/发布）
└── Agent 设置
    └── 扩展与工具（迁移为 AssemblyView 编辑）
```

### 4.2 AgentPane 迁移要点

删除 `builtinDecl/ensureBuiltin/patchBuiltin`，替换为：

```ts
const decl = computed(() => ({
  presets: (props.raw.presets ?? []) as string[],
  tools:   (props.raw.tools ?? []) as string[],
  hooks:   (props.raw.hooks ?? {}) as Record<string, string[]>,
}));

function patchDecl(patch: {
  presets?: string[]; tools?: string[]; hooks?: Record<string, string[]>;
}) {
  emit('update:raw', {
    ...props.raw,
    presets: patch.presets ?? decl.value.presets,
    tools:   patch.tools ?? decl.value.tools,
    hooks:   { ...decl.value.hooks, ...(patch.hooks ?? {}) },
  });
}
```

### 4.3 ExtToolsPane 改造

- props：`decl` 改为 `{ presets, tools, hooks }`；
- 左侧导航新增“插件”分组：
  - 每个 `PluginInfo` 一行：名称/描述/权限徽章/开关（写 `decl.presets`）；
  - 已安装但未启用插件置灰展示；
- 钩子清单逻辑不变，数据源从 `decl.hooks[kind]` 取顺序；开关与拖拽仍写 `decl.hooks`；
- 工具区：`explicit` 直接读 `decl.tools`；“自动”集合来自后端 `tools.enabled`（已含 presets 过滤结果）。

### 4.4 插件库页（新组件）

文件规划：

```text
src/ui/webui/src/settings/components/
├── PluginLibraryPane.vue      # 页签容器（installed/staging/dev 三栏）
├── PluginCard.vue             # 单插件卡片（权限徽章/动作按钮）
├── StagingReviewModal.vue     # 文件树 + diff 预览 + grants 勾选 + 批准/拒绝
└── PluginDevCard.vue          # 开发插件（manifest 摘要 + register/unregister/stage）
```

交互约束：

- “批准”按钮旁永远显示 `requiredGrants` 勾选（process/shell 缺省不勾）；
- 哈希显示 8 位前缀 + 复制按钮；
- 卸载/替换弹确认框（显示将备份到 `.backup` 的路径）；
- 所有动作后监听 WS `plugin.catalog.changed` 刷新，不整页 reload。

### 4.5 兼容与回退

- UI 启动时若 `assembly.legacy.hasPlugins=true`：在扩展页顶部显示“旧契约，本次只读；点击保存即迁移”横幅；
- 后端保留 `GET /api/plugins/:agentId`（扁平数组）一个版本周期，UI 迁移完成后标记 deprecated；
- 前端构建产物仍放 `src/ui/webui/dist`，preview 后端沿用现有静态托管逻辑。

---

## 5. 实施阶段（评审后执行顺序）

| 阶段 | 内容 | 完成判据 | 状态 |
|---|---|---|---|
| P1 后端契约 | ctx.pluginHost 服务化、manifest.provides、uninstall/reject、PluginManager 新方法、REST/WS 契约、归一化；**权限词汇加入 `ui`（仅类型占位，执行期在 P5）** | typecheck + 旧测试全绿 + 新契约测试 | ✅ 已完成 |
| P2 UI 契约迁移 | api/types/useSettings/AgentPane/ExtToolsPane 迁移到 AssemblyView | UI 手动验收：presets/hooks/tools 全流程 | ✅ 已完成（vue-tsc + vite build + 3831 端到端） |
| P3 插件库 UI | PluginLibraryPane + 人审流 + 开发流 | stage→approve→安装→重启恢复 全流程 | ✅ 已完成（session/register + dir 暴露 + 重启恢复端到端） |
| P4 打磨 | WS 实时刷新、权限徽章、legacy 迁移横幅、错误态 | E2E + 文档更新 | ✅ 已完成（WS 端到端 + Edge headless CDP 页面验收） |
| P5 深度 UI 扩展 | DSH 级界面改造：ctx.webui 服务、发布期浏览器打包、UiExtensionHost、slot 桥接（详见 §7） | 参考 UI 插件完成“新视角 + 工具结果视图 + 设置页签”三连验收 | ✅ P5.1–P5.5 全部完成（ui-hello 三连验收 + isolated 真浏览器验收） |

---

## 6. 风险与决策记录

1. **暂存文件查看是只读后端代理**：不允许浏览器直读文件系统（沙箱边界）；`GET staging/:id/file` 必须校验 id 白名单 + 相对路径。
2. **approve 幂等与并发**：同 id 只能 approve 一次；`approveStaging` 已有版本冲突校验，HTTP 层要映射 409。
3. **dev 插件扫描不递归全盘**：只扫 `<ws>/plugins/<agentId>/*` 一层目录的 `manifest.json`，避免误扫插件库与 node_modules。
4. **hot reload 失败不写坏配置**：PUT assembly 先写临时文件 + 原子 rename，再 hotReload；reload 失败回滚文件并返回 500（当前后端单写盘，P1 一并加固）。
5. **权限不在 UI 里“假装沙箱”**：UI 只展示与 gate，真正的执行边界仍是 `PluginHost.load` 的 import 前拒绝。
6. **静态 cordis.yml 插件行 HMR** 不在本方案范围（需补 vendor cordis-timer），动态插件 HMR 已由 PluginHost watch 覆盖。

---

## 7. 深度 UI 扩展（DSH 级界面改造）

> 回答“能否让插件修改 UI”的最终结论：**能**。
> AgentChat 前端已经有 4 个显式注册表扩展点（perspective / messageView / toolResultView / eventHandler），
> 缺的是“后端 UI 资源托管 + 发布期浏览器打包 + 客户端动态加载器”三段管道。
> 补齐后可以达到 Koishi/DSH 的常规 UI 插件能力；任意 DOM 篡改不开放。

### 7.1 参照机制（DSH/Koishi 是怎么做的）

Koishi/DSH 的 UI 插件是三段式：

1. **服务端挂载**：插件 `inject: ['webui']`，在 `apply(ctx)` 里调用
   `ctx.webui.addEntry(<插件名>, <前端产物目录>)`，把插件前端资源挂到
   `/plugins/<name>/`；同时插件清单经 API 下发给浏览器。
   （参照 [koishi webui.addEntry 实现](https://github.com/koishijs/koishi/commit/217fbcdba46cec74559e022bd37e41d35a85a1e5)、
   [cordiverse/webui](https://github.com/cordiverse/webui)、
   [@cordisjs/plugin-server-webui](https://www.npmjs.com/package/@cordisjs/plugin-server-webui)）
2. **发布期打包**：插件的 Vue 组件在发布时被打包为浏览器可执行的 `js/css`；
   服务端只负责托管产物，不负责编译。
3. **客户端注册**：Console 运行时动态 `import()` 插件入口；插件入口调用
   客户端 `ctx.page / ctx.slot` 注册页面、面板、配置表单。
   UI 是“插槽 + 注册表”模型，不是插件任意改 DOM。

AgentChat 要做的是同一模型，但把 `ctx.page/ctx.slot` 换成我们已有的
`core/registry/*` 注册表，并新增设置页/侧边栏等 slot。

### 7.2 现有前端扩展点盘点（重要：代码里已有雏形）

| 文件 | 现状 API | 动态插件还缺什么 |
|---|---|---|
| `core/registry/perspectives.ts` | `registerPerspective({id,label,component,active,props})`；`activePerspective()` 取首个命中 | ① `unregister`（卸载时撤销）② 组件来自动态 import |
| `core/registry/messageViews.ts` | `registerMessageView({id,match,priority})`；返回 view id（渲染在 `TurnDisplayItem` 里按 id 分支） | ③ 缺 `registerMessageViewRenderer(id, component)`：目前只有 id，没有动态组件表 |
| `core/registry/toolResultViews.ts` | `registerToolResultView(match, component, {priority})`；精确名 > 正则族，`useToolResult` 已走此表 | ④ `unregister`；⑤ 动态组件 |
| `core/registry/eventHandlers.ts` | `registerEventHandler(type, fn)`；`clearEventHandlers()` 是清空全量 | ⑥ 需要按 owner 批量撤销（或返回 disposer） |
| `settings/components/*` | 设置页签/面板目前是静态组件树（AgentPane 的 tab 硬编码） | ⑦ 需要 `settingsTabs` 注册表（global/agent 两种） |
| `App.vue` / `Sidebar.vue` | 侧边栏与顶栏静态 | ⑧ 需要 `sidebarActions` 等 slot 注册表 |

结论：**注册表思想已经存在**，P5 的工作是把它们升级为“可动态安装/卸载的 slot 系统”，
而不是从零引入插件框架。

### 7.3 目标架构

```text
┌─ 后端 cordis 插件 ───────────────────────────────────────────┐
│ apply(ctx) {                                                  │
│   ctx.tools.register(owner, [...])      // 已有               │
│   ctx.hooks.register(...)               // 已有               │
│   if (manifest.ui) {                                          │
│     ctx.webui.addEntry(name, buildDir, manifest.ui)  // P5.1 │
│   }                                                           │
│ }                                                             │
└───────────────────────────────────────────────────────────────┘
        │ 发布管线（P5.2）: ui/index.ts --esbuild/vite--> ui/dist/
        ▼
┌─ WebUIServer ────────────────────────────────────────────────┐
│ GET /ui-plugin/<name>/*            # 静态托管（路径守卫）      │
│ GET /api/ui/extensions             # 所有 UI 扩展清单         │
│ GET /api/ui/slots                  # slot 目录（可发现性）    │
│ WS  ui.extensions.changed          # 注册/卸载/重载广播        │
└───────────────────────────────────────────────────────────────┘
        ▼
┌─ 浏览器 UiExtensionHost（P5.3）──────────────────────────────┐
│ 1. 拉取 /api/ui/extensions                                    │
│ 2. import('/ui-plugin/<name>/<entry>?v=<version>')            │
│ 3. 调用插件 install(bridgeCtx)                                │
│ 4. bridgeCtx 转发到现有注册表 + 新 slot 注册表                │
│ 5. 记录 disposers；卸载时逆序执行 + 从注册表撤销              │
└───────────────────────────────────────────────────────────────┘
```

### 7.4 manifest 与权限扩展

```ts
// @agentchat/agent-config/src/manifest.ts
export type PluginPermission = 'fs' | 'network' | 'process' | 'shell' | 'ui';

export interface PluginUIManifest {
  /** 浏览器入口（相对插件目录；缺省 ui/dist/index.js） */
  entry?: string;
  /** 额外 CSS（相对插件目录） */
  styles?: string[];
  /** 声明的插槽（白名单，见 §7.8） */
  slots?: UISlotId[];
  /** true = 在 iframe 隔离容器里运行（受限桥接；P5.5） */
  isolated?: boolean;
}

export interface PluginManifest {
  // ...现有字段
  ui?: PluginUIManifest;
}
```

校验规则（`validatePluginManifest` 扩展）：

- `ui.entry/styles` 必须是相对路径，禁 `..` 与绝对路径；
- `ui.slots` 只能取 §7.8 白名单值；
- `ui.isolated` 必须 boolean；
- **gate 规则**：`manifest.ui` 存在时，`ui` 必须在授予权限里（与 process/shell 同级、
  approve 弹窗强制勾选）；未授予 → `PluginHost.load` 在 import 前拒绝，整包不装载。
  这样“后端工具 + UI 资源”作为一个原子单元要么全上、要么全不上。

### 7.5 `ctx.webui` Service 契约（P5.1）

```ts
// @agentchat/plugins/src/webui-service.ts
import { Service } from '@agentchat/cordis';

export interface UIExtensionDescriptor {
  name: string;                 // manifest.name
  version: string;
  entry: string;                // URL path，如 /ui-plugin/name/dist/index.js
  styles: string[];             // URL path[]
  slots: UISlotId[];
  isolated: boolean;
  status: 'installed' | 'session';
  grantedPermissions: PluginPermission[];
}

export class WebUIService extends Service {
  constructor(ctx: Context) { super(ctx, 'webui'); }

  /** 挂载插件 UI 产物目录；返回 disposer（unload 时调用） */
  addEntry(name: string, dir: string, ui: PluginUIManifest): () => void;

  /** 当前全部 UI 扩展清单（HTTP 层直接读） */
  listExtensions(): UIExtensionDescriptor[];

  /** 按 name 移除（session unload / installed uninstall） */
  removeEntry(name: string): boolean;
}

declare module '@agentchat/cordis' {
  interface Context { webui?: WebUIService }
}
```

生命周期接线：

- `PluginHost.load` 激活成功后：若 `manifest.ui` 且 `allowedPermissions` 含 `ui`，
  调 `ctx.webui?.addEntry(...)`；记录在 `LoadedPlugin`（`uiDisposer`）。
- `PluginHost.disposeRecord`：先 `uiDisposer()` 再回收 tools/hooks + fiber。
- `loadInstalledPlugins`：boot 在装配期创建 `WebUIService`（若未存在），扫描安装插件时一并挂 UI。
- dev `register_plugin`：会话级插件同样挂 UI，unload 即移除；重启即失。
- WebUIServer 挂两个路由（见 §7.9 的安全约束）。

### 7.6 发布期浏览器打包（P5.2）

问题：浏览器不能直接执行插件目录里的 `.vue/.ts`；`publish_plugin` 现在的
`copyPluginDir` 只复制源码。

分两档：

**P5.2a（MVP，先落地）**：插件 UI 用“浏览器可直接运行或 esbuild 可编译”的
`js/mjs/ts` 编写，**Vue 不经插件 import**，而是由桥接上下文注入（见 §7.7
`ctx.vue`）。发布时用 esbuild（vendor 已有依赖）打包：

```text
ui/index.ts
  ↓ esbuild(bundle: true, format: 'esm', target: 'es2022', external: ['vue'])
ui/dist/index.js   # 单文件，确定性输出（写 buildHash 进 staging 记录）
```

优点：零 Vite 配置、产物可审计、避免多份 Vue 副本/版本错位。
缺点：不能用 `.vue` 单文件组件，需用 `h()/defineComponent`（TSX 可选）。

**P5.2b（后续）**：支持 `.vue` SFC。在 `scripts/build-plugin-ui.mjs` 里用 Vite
`build({ lib: { entry: 'ui/index.ts' }, build: { rollupOptions: { external: ['vue'] } } })`
产出 `js + css`；Vue 仍 external，由宿主编排。此档需要额外验收 chunk/asset 路径。

publish 管线变更：

```text
stage：
  1. 校验 manifest（含 ui）
  2. 若存在 ui：执行构建 → ui/dist（失败即拒绝 stage）
  3. hashPluginDir（源码 + 构建产物都参与）
  4. 暂存记录新增 buildHash + uiFiles 清单
approve：
  · grants 必须包含 ui（manifest.ui 存在时）
  · 其余流程不变（同版本拒绝 / 旧版 .backup）
staging 查看器：
  · GET staging/:id/tree 同时列出源码与构建产物
  · GET staging/:id/file 可读 ui/dist/index.js 供人审
```

dev 快速路径：`register_plugin` 在 dev 模式下可直接把 `ui/dist` 挂给
`ctx.webui`（要求插件作者先本地构建）；后续再加 tsx/vite HMR 中间件。

### 7.7 客户端 `UiExtensionHost` 与桥接 API（P5.3）

新增目录：

```text
src/ui/webui/src/core/extensions/
├── types.ts          # UIExtensionDescriptor / UiExtensionModule / UiExtensionContext
├── host.ts           # init/load/unload/reload；Map<name, Disposers>
├── bridge.ts         # install(ctx) 的桥接实现（转发到注册表）
├── slots.ts          # settingsTabs / sidebarActions 等新注册表
└── index.ts
```

插件入口模块约定：

```ts
// /ui-plugin/<name>/dist/index.js（ESM）
export function install(ctx: UiExtensionContext): void | (() => void) | Promise<void | (() => void)>;
```

桥接上下文（核心 API，保持最小面）：

```ts
export interface UiExtensionContext {
  /** 插件名（与 manifest.name 一致） */
  name: string;
  /** 宿主注入的 Vue 工具（h/defineComponent/ref/computed/watch），
      插件不再自行 import 'vue'，避免多副本 */
  vue: Pick<typeof import('vue'), 'h' | 'defineComponent' | 'ref' | 'computed' | 'watch'>;

  // —— 既有扩展点桥接 ——
  registerPerspective(p: Perspective): Disposer;
  registerToolResultView(match: string | RegExp, component: Component, opts?: { priority?: number }): Disposer;
  registerMessageView(def: MessageViewDef, renderer: Component): Disposer; // 补 renderer 映射
  registerEventHandler(type: string, fn: EventHandler): Disposer;

  // —— 新增 slot ——
  registerSettingsTab(tab: SettingsTabDef): Disposer;        // 全局设置页签
  registerAgentSettingsTab(tab: SettingsTabDef): Disposer;    // Agent 设置页签
  registerSidebarAction(action: SidebarActionDef): Disposer;  // 侧边栏动作

  // —— 与后端交互 ——
  request<T>(path: string, init?: RequestInit): Promise<T>;   // 同 origin fetch（复用现有 client）
  wsOn(type: string, handler: EventHandler): Disposer;        // 现有 WS 通道
  onUnload(fn: () => void): void;
}

export type Disposer = () => void;
```

`host.ts` 语义：

```text
init()
  ├─ GET /api/ui/extensions（失败降级：内置 UI 不受影响）
  ├─ 逐个 import(entry + '?v=' + version)
  ├─ 校验 export.install 为函数
  ├─ install(bridge) → 收集返回的 disposer 与 onUnload
  └─ 失败：console.error + 记录 failed，其余继续

unload(name)
  └─ 逆序执行 disposers → 从各注册表撤销 → Map.delete

reload(name)（WS ui.extensions.changed 驱动或插件发布后触发）
  ├─ unload(name)
  ├─ import(entry + '?v=' + newVersion)
  └─ 重新 install
```

### 7.8 Slot 目录 v1（白名单）—— 展开说明

#### 7.8.1 什么是 slot：宿主先开口，插件后填空

Slot 是宿主 UI 里**预先挖好的固定插口**。插件不能自己决定“我要出现在侧边栏第 3 个按钮”，
它只能：

1. 在 `manifest.ui.slots` 里**声明**自己想用哪些插口（人审可见）；
2. 在 `install(ctx)` 里调用对应 `registerXxx(def)` **提交一个组件/处理器**；
3. 由宿主 UI 在**自己决定的位置**渲染它，并决定顺序、样式和卸载。

对比：

| 模式 | 谁决定 UI 结构 | 风险 |
|---|---|---|
| 插件任意改 DOM（不采用） | 插件 | 互相覆盖、升级即碎、无法卸载 |
| **Slot 白名单（本方案）** | 宿主 | 插件只能贡献内容；宿主保证布局稳定 |

这正是 Vue 组件里 `<slot>` 的同一个思想：父组件（宿主）写
`<slot name="header" />`，子组件（插件内容）只能填这个具名槽，
不能决定槽放在哪。

#### 7.8.2 一个 slot 的完整生命周期（以“Agent 设置页签”为例）

当前 `AgentPane.vue` 的页签是硬编码的：

```ts
const tab = ref<'info' | 'llm' | 'timer' | 'sec' | 'ext'>('info')
```

模板里写死 5 个 `<button class="agent-tab">` 和 5 个 `v-if` 内容块。
插件没有地方“插入第 6 个页签”。

Slot 化之后：

```ts
// host：新注册表 src/ui/webui/src/core/extensions/slots.ts
export interface AgentSettingsTabDef {
  id: string; label: string; icon?: string;
  order?: number;                 // 排序：默认 100，数字小在前
  component: Component;           // 页签内容组件
}
const tabs: AgentSettingsTabDef[] = [
  { id: 'info', label: '基本信息', order: 10, component: ... },
  { id: 'llm',  label: '模型',     order: 20, component: ... },
  // ... 内置 5 个页签也迁移进注册表，与插件地位一致
]
export function registerAgentSettingsTab(def: AgentSettingsTabDef): Disposer {
  tabs.push(def); tabs.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
  return () => { const i = tabs.indexOf(def); if (i >= 0) tabs.splice(i, 1) }
}
```

```ts
// 插件 ui/index.ts：只“填槽”，不碰 AgentPane 源码
export function install(ctx: UiExtensionContext) {
  ctx.registerAgentSettingsTab({
    id: 'ui-hello',
    label: 'UI Hello',
    order: 50,                   // 排在模型后、定时任务前
    component: ctx.vue.defineComponent({ setup: () => () => ctx.vue.h('div', '来自插件的页签') }),
  })
}
```

```vue
<!-- AgentPane.vue：渲染从硬编码改为 v-for 注册表 -->
<button v-for="t in agentSettingsTabs" :key="t.id"
        class="agent-tab" :class="{ active: tab === t.id }"
        @click="tab = t.id">{{ t.label }}</button>

<div v-else class="agent-tab-body">
  <component :is="currentTab.component" v-bind="currentTabProps" />
</div>
```

卸载插件时：`Disposer` 把 `ui-hello` 从数组删掉 → 页签消失；
宿主代码一行都不用改。这就是 slot 的核心收益：**插件的 UI 贡献可插、可拔、可排序，而且不破坏宿主**。

#### 7.8.3 每个 slot 的“坑”是什么形状（宿主给插件什么、插件交什么）

| slot id | 宿主渲染位置 | 插件提交的内容 | 宿主传给组件/回调的数据 |
|---|---|---|---|
| `perspective` | `PerspectiveHost`（主界面顶层） | `{ id,label,icon,active(),component,props() }` | 无强制 props；组件自己读 stores（talk/group 先例） |
| `tool-result` | `useToolResult` 工具结果分发 | `{ match: string\|RegExp, component, priority? }` | `{ toolName, args, result, stream }`（对齐现有 ToolResult 组件 props） |
| `message-view` | `TurnDisplayItem` 消息渲染 | `{ id, match(turn,final), priority, renderer }` | 渲染器拿到与现有 user/assistant 视图相同的 turn/final 数据 |
| `ws-event` | `eventHandlers.dispatchEvent` | `(data) => void` | WS 原始 data（宿主不解释） |
| `settings-tab:global` | SettingsPanel 全局页签栏 | `SettingsTabDef` | `{ globalConfig, nsSchemas, pools }` |
| `settings-tab:agent` | AgentPane 页签栏 | `SettingsTabDef` | `{ agentId, raw, effective, emit }`（只读 props，写操作经 emit 同现有页签） |
| `sidebar-action` | Sidebar 动作区 | `SidebarActionDef` | 点击回调（宿主提供 router/store 上下文） |
| `global-style`（P5.5） | 宿主 `<style>` 注入 | `{ scope, css }` | 无；宿主重写选择器前缀后注入 |

统一约束：

- 所有 `registerXxx` 返回 `Disposer`；插件返回的卸载函数与逐项 Disposer 都会被 host 记录。
- **同 slot 多插件排序**：`order`（小在前）→ 注册先后（稳定）；`tool-result` 例外沿用
  现有 `match` 精确名 > 正则族 > `priority` 语义。
- **id 冲突**：同 slot 同 id 后注册者替换前者（与 HooksService 同名覆盖一致），host 记 warn。
- **运行时注册不能超出 manifest.ui.slots 声明**：host 在 install 前拿到 descriptor，
  对每个 `registerXxx` 调用核对白名单；超声明直接抛错（插件加载失败但不影响其他插件）。

#### 7.8.4 v1 白名单与保留位

| slot id | 注册点 | 说明 |
|---|---|---|
| `perspective` | `perspectives.ts` | 顶级视角（如统计工作台、社区流） |
| `tool-result` | `toolResultViews.ts` | 工具结果渲染器（match + component + priority） |
| `message-view` | `messageViews.ts` + 新 renderer map | 消息形态视图 |
| `ws-event` | `eventHandlers.ts` | 后端/前端事件处理器 |
| `settings-tab:global` | 新 `settingsTabs` | 全局设置新页签 |
| `settings-tab:agent` | 新 `agentSettingsTabs` | Agent 设置新页签（P5 后内置页签也迁入此表） |
| `sidebar-action` | 新 `sidebarActions` | 侧边栏动作按钮（icon/label/onClick） |
| `global-style` | 新 `styleInjections`（P5.5） | 只允许注入 scoped CSS / CSS 变量；不开任意 DOM 修改 |

v1 保留位（不实现）：`chat-input-command`、`agent-card-action`、`toolbar-action`。
新增 slot 走同样的白名单 + 类型契约流程，不开放通配。

各 slot 的最小类型：

```ts
export interface SettingsTabDef { id: string; label: string; icon?: string; order?: number; component: Component }
export interface SidebarActionDef { id: string; label: string; icon: string; order?: number; onClick(): void }
```

#### 7.8.5 为什么“声明 + 注册”要做两遍

- `manifest.ui.slots`：**静态声明**，发布人审时宿主用户就能看到“这个插件要动我的哪些界面”，
  也是权限审查与 UI 目录展示的数据源；
- `install(ctx)` 里的 `registerXxx`：**运行时事实**，宿主只相信这次调用实际提交了什么。
- 两者不一致时：运行时少于声明 = 合法（插件可以按环境降级）；
  运行时多于声明 = 拒绝（host 按 7.8.3 核对）。
- 这样保证“批准时看到什么，运行时最多就只能做什么”。

#### 7.8.6 一眼看懂的总体图

```text
宿主 App.vue / AgentPane.vue / Sidebar.vue（布局归宿主）
│
├─ [slot: perspective]  ← 插件 A 提交统计工作台视角
├─ [slot: settings-tab:agent]
│    ├─ info / llm / timer / sec / ext   ← 宿主内置页签（同表）
│    └─ ui-hello                        ← 插件 B 提交（order=50）
├─ [slot: tool-result]  ← useToolResult 按 match 分发
│    ├─ bash / read / ...               ← 宿主内置
│    └─ ui_hello                        ← 插件 B 提交富渲染
└─ [slot: sidebar-action] ← 插件 C 提交“打开我的页面”按钮
```

### 7.9 安全边界（UI 代码 = 用户会话的 same-origin 代码）

必须写进代码与 UI 文案的信任模型：

1. **UI 插件运行在浏览器、与当前用户同源**：它读不到后端密钥，但能读到该用户
   可见的聊天、文件预览，并能调用该用户可调用的所有 API。授予 `ui` 等于“信任此
   代码在你的会话上下文里运行”。
2. 因此：
   - `ui` 是显式权限，approve 弹窗强制勾选并展示“UI 代码将被浏览器执行”提示；
   - staging 人审必须能看 `ui/dist/index.js`（见 §7.6）；
   - 默认只加载 `grantedPermissions` 含 `ui` 的插件。
3. 服务端静态路由守卫：`name` 必须匹配 `^[a-z0-9-]+$`；解析后路径必须落在
   `dir` 内；禁止符号链接逃逸；Content-Type 白名单（js/mjs/css/map/json/svg/png/webp）。
4. CSP 策略：生产 dist 的 CSP 允许 `self` + 内联样式（现有 UI 依赖），
   **不允许插件 entry 之外的任意 remote script**。
5. `global-style` 只接受“CSS 变量覆盖 + 以插件名为 class 前缀的规则”，UI 在注入前
   重写选择器前缀；禁止 `url()` 外链（P5.5 细化）。
6. `iframe isolated` 档（P5.5）：不信任插件可用隔离容器，桥接只暴露
   `request` 白名单子集 + 受控 `postMessage` 事件，不暴露 Vue/注册表。
   默认仍是 same-origin 高能力档（对齐 DSH）。

### 7.10 参考插件（P5 验收样例）

```text
workspace/plugins/admin/ui-hello/
├── manifest.json
├── index.mjs          # 后端：注册一个工具
└── ui/index.ts        # 前端入口（esbuild 构建为 ui/dist/index.js）
```

```jsonc
// manifest.json
{
  "name": "ui-hello",
  "version": "1.0.0",
  "entry": "index.mjs",
  "permissions": ["ui"],
  "ui": {
    "entry": "ui/dist/index.js",
    "slots": ["tool-result", "settings-tab:agent", "perspective"]
  }
}
```

```js
// index.mjs —— 后端仍是普通 cordis 插件
export const name = 'ui-hello'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register('ui-hello', [{
    name: 'ui_hello', label: 'UI Hello', requires: ['agent'],
    description: '返回一段结构化 hello（前端插件负责富渲染）',
    definition: { type: 'function', function: { name: 'ui_hello', description: '...', parameters: { type: 'object', properties: {} } } },
    execute: async () => JSON.stringify({ ok: true, text: 'hello from plugin' }),
  }])
}
```

```ts
// ui/index.ts —— 浏览器入口；不 import 'vue'，用桥接注入
import type { UiExtensionContext } from '@agentchat/ui-bridge'   // 类型包（P5.3）

export function install(ctx: UiExtensionContext): () => void {
  const { h, defineComponent, ref } = ctx.vue

  // ① 工具结果富视图
  const ResultView = defineComponent({
    props: { result: String },
    setup(props) {
      const parsed = JSON.parse(props.result)
      return () => h('div', { class: 'ui-hello-result' }, [
        h('b', parsed.text),
        h('button', { onClick: () => alert('插件 UI 已工作') }, '互动')
      ])
    },
  })
  ctx.registerToolResultView('ui_hello', ResultView)

  // ② Agent 设置新页签
  const SettingsTab = defineComponent({
    setup() {
      const n = ref(0)
      return () => h('div', { class: 'ui-hello-tab' }, [
        h('p', `点击次数 ${n.value}`),
        h('button', { onClick: () => n.value++ }, '+1'),
      ])
    },
  })
  ctx.registerAgentSettingsTab({ id: 'ui-hello', label: 'UI Hello', component: SettingsTab })

  // ③ 新视角（可选演示）
  ctx.registerPerspective({
    id: 'ui-hello-view', label: 'UI Hello', icon: 'sparkles',
    active: () => false,   // 默认不激活；可通过侧边栏动作切换
    component: SettingsTab,
  })

  // 卸载函数：host 卸载时撤销全部注册
  return () => { /* 桥接已记录 disposers，此返回值也会被执行 */ }
}
```

验收标准（P5 完成判据）：

1. `publish_plugin stage → approve`（勾选 `ui`）后，**不刷新页面**就能在 Agent 设置里看到新页签；
2. `ui_hello` 工具的结果用插件组件渲染，而不是纯文本；
3. `uninstall / unregister_plugin` 后页签与视图消失、WS 通知其他客户端；
4. 重启后端，UI 扩展随 registry 扫描自动恢复。

### 7.11 P5 文件改动清单

后端：

| 文件 | 改动 |
|---|---|
| `agent-config/src/manifest.ts` | `PluginPermission+'ui'`、`PluginUIManifest`、校验 |
| `plugins/src/permissions.ts` | explicitRequired 增加 `ui` |
| `plugins/src/webui-service.ts` | **新增** `WebUIService`（addEntry/list/remove） |
| `plugins/src/host.ts` | load/disposeRecord 接线 uiDisposer |
| `plugins/src/registry.ts` | publish 构建钩子、buildHash、uninstall/reject |
| `host/server/src/webui-server.ts` | 挂 `/ui-plugin/*`、`/api/ui/*` |
| `host/server/src/api/ui.ts` | **新增** extensions/slots 路由 + 路径守卫 |
| `boot/boot/src/bootstrap.ts` | 创建 `ctx.webui`（若插件未创建）+ 启动扫描 |
| `sdk/protocol/src/index.ts` | `UIExtensionDescriptor` 等共享类型 |
| `scripts/build-plugin-ui.mjs` | **新增** esbuild 构建入口（P5.2a） |

前端：

| 文件 | 改动 |
|---|---|
| `core/extensions/*` | **新增** host/bridge/slots/types |
| `core/registry/*` | 增加 `unregister*` / renderer map / disposer 返回 |
| `App.vue` | 启动时 `await uiExtensionHost.init()`（内置注册在前） |
| `settings/components/*` | 页签从静态数组改为 registry 驱动 |
| `Sidebar.vue` | `sidebarActions` 渲染 |
| `core/api/client.ts` | 复用；必要时加 typed request |
| `@shared/types` | 同步 UIExtensionDescriptor 类型 |

### 7.12 P5 子阶段与判据

| 子阶段 | 内容 | 完成判据 |
|---|---|---|
| P5.1 | ctx.webui Service + ui 权限 gate + `/api/ui/extensions` + `/ui-plugin/*` 守卫 + WS 事件 | ✅ 单测：add/remove/list、路径逃逸 403、未授予 ui 拒绝加载 |
| P5.2 | esbuild 发布构建 + staging 构建产物查看 + buildHash | ✅ 构建测试：同源码两次构建 hash 一致；坏 UI 构建拒绝 stage |
| P5.3 | UiExtensionHost + bridge + 注册表 unregister | ✅ 参考插件动态安装/卸载/重载；坏 entry 不拖垮宿主 UI |
| P5.4 | slot 目录 v1（settings tabs/sidebar/perspective/tool-result/message-view/ws-event）+ 参考插件全验收 | ✅ §7.10 四条验收全过 |
| P5.5 | iframe isolated 档 + global-style 限制 + CSP 审计 | ✅ 已实施：sandbox iframe（allow-scripts，无 allow-same-origin）+ request/event 白名单 + CSS 前缀重写/禁 url() + dist CSP 审计测试；真浏览器验收通过 |

---

## 8. 风险与决策记录（P5 追加）

7. **UI 插件与后端插件必须同生命周期**：后端 unload 时 UI entry 同步移除；
   `ui.disposer` 必须纳入 `LoadedPlugin` 记录，避免“后端卸了、页面组件还活着”。
8. **Vue 多副本问题**：插件一律经 `ctx.vue` 使用宿主 Vue，禁止插件自行打包 Vue；
   esbuild/Vite 配置固定 `external: ['vue']`。
9. **构建产物属于发布物**：hash 覆盖源码 + `ui/dist`；staging 查看器展示构建产物，
   人审的是“将要执行的代码”而不是“作者声称的源码”。
10. **动态 import 失败隔离**：单个 UI 插件坏代码只能影响自己的模块域，
    不得阻断 `UiExtensionHost.init()` 与其他插件（每个 import 独立 try/catch）。
11. **不开放任意 DOM 修改**：v1 只提供白名单 slot；这是与 DSH 一致的边界，
    也是防止插件互相打架的关键。
