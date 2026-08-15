# “一切皆插件”差距清单与下一会话实施计划

> 整理：2026-08-15（续·九·收尾 → 块 E）
> 状态：**块 A/B/C/D/E 已全部完成并验收** —— preview 已整体切换为根目录 `src/`（L4 完成）；根目录 `pnpm typecheck` 0 错误、`pnpm test` 406/406、`pnpm build`（WebUI vite build）通过、desktop Tauri NSIS+MSI 打包通过、`pnpm dev` Loader Ready（WebUI 3830）。
> 权威现状：`docs/block-e-migration.md`；目标设计：`docs/ui-web-pluginization-plan.md` §7、`docs/preview-knowledge-base.md` 阶段四/六。

---

## 0. 目标定义（先统一口径）

四个严格度：

| 级别 | 定义 | 当前进度 |
|---|---|---|
| L1 能力可插拔 | 引擎/LLM/工具/钩子/UI/插件宿主都是 cordis 插件行 | ✅ 已完成 |
| L2 编排也插件化 | boot 不直接 new 服务；L4 门面/archive/timer/subagent 各自成行 | ✅ 已完成（块 A） |
| L3 传输层插件化 | 各域插件自己挂 HTTP/WS 路由；SPA 与 API 均注册式 | ✅ HTTP 已完成（块 B）；WS 仍为宿主内置（可选优化） |
| L4 全量切 src | 仓库根 `src/*` 由 preview 替换 | ✅ 已完成（块 E） |

块 A–D 已实施完成；本文保留差距清单作为历史对照，并给出下一会话块 E 迁移计划。

---

## 1. 当前快照（可直接接手的事实）

- preview：**45 包**（含新增 `@agentchat/workspace`、vendor `@agentchat/cordis-timer`），`pnpm typecheck` 0 错误，`pnpm test` **406/406**，`pnpm dev`（含 HMR）正常。
- `cordis.yml`：**39 个插件行** —— 能力行 + boot 核心/收尾/诊断行 + workspace/archive/timer/subagent/server 服务行 + http 注册表/路由行 + HMR 行；WebUI 是 `@agentchat/webui` 插件（源码 + dist 自包含）。
- UI/Web 插件化：**P1–P5.5 全部完成**（iframe isolated 档 + global-style scoped CSS + 生产 CSP 审计）。
- 关键事实：`ctx.agentLoop / llm / tools / hooks / pluginHost / agents / timerManager / subagent / archive / l4 / http / server / webui` 均已插件化；boot 只做契约接线，`bootstrap.ts` 无任何 L4 业务 `new`。

---

## 2. 差距清单（按工作块）

### 块 A：boot 装配插件拆解（L2，最大）—— ✅ 已完成

现状位置：

- `preview/packages/boot/boot/src/bootstrap.ts`
  - `setupPlugins()` 里 `new TimerManager(...)`、`new SubAgentManager(...)`
  - `new ArchiveService(...)`
  - `new ServiceRegistry()` / `new RPCBridge(...)` / `new InteractionBridge(...)`
  - `new AgentService / GroupService / HistoryService`
  - `ensureWorkspaceFiles()`（默认 user/admin、首次引导、自我介绍）
  - pending flush、shutdown deps 接线
- `preview/packages/boot/boot/src/loader.ts`
  - `makeAgentAssembly` 仍是 boot 的中心装配实现

目标：boot 只做“契约接线”，上述每一项要么有独立插件行，要么作为 Service 由能力包提供。

建议新增/修改插件行：

| 插件行（包） | inject | 职责 |
|---|---|---|
| `@agentchat/workspace/src/plugin` | `agentLoop?` 或仅 logger | 工作区初始化：files 指引、默认 user、admin 模板、首次消息、`.initialized` |
| `@agentchat/archive/src/plugin` | `router`, `agents`, `agentLoop`?（按实现定） | `ArchiveService` 构造 + `ctx.archive` + pending watcher |
| `@agentchat/timer/src/service-plugin` | `router`, `tools` | TimerManager 由 timer 插件自己持有并提供 `ctx.timerManager`；工具注册用同一实例 |
| `@agentchat/subagent/src/service-plugin` | `agentLoop`, `router` | SubAgentManager 由 subagent 插件持有并提供 `ctx.subagentManager` |
| `@agentchat/server/src/service-plugin` 或 `@agentchat/services/src/plugin` | `agents`, `router`, `archive`, `timerManager`, `subagentManager`, `hooks`, `tools` | AgentService/GroupService/HistoryService/RPC/InteractionBridge/ServiceRegistry 的构造与 facade 包装 |
| `@agentchat/boot/src/plugin` | 只保留 `agentLoop, llm, tools, hooks` + 上述服务 | 装配 AgentAssembly、Router、AgentRegistry、Loader 的最小引导 |

注意运行环：`agents → timer → router → agents` 等历史环必须用**最小结构契约 + inject 拆环**（参考知识库 §4）。

### 块 B：HTTP 路由注册插件化（L3）—— ✅ 已完成

现状：`preview/packages/host/server/src/webui-server.ts` 构造函数硬编码：

```text
/api/agents /api/history /api/upload /api/config /api/plugins
/api/browse /api/workspace /api/backup /api/version /api/usage
/api/sessions /api/groups /api/ui + /ui-plugin 静态托管
```

目标形态：

```ts
// 宿主提供注册口（ctx.server 或新 ctx.http）
ctx.http.register('/api/agents', createAgentsRouter(...))
ctx.http.registerStatic('/ui-plugin', handler)
```

拆法建议：

1. `@agentchat/server` 增加 `HttpRouteRegistry`（`register(path, router|handler)`）；
2. WebUIServer 构造时只挂中间件、WS、SPA fallback 和 route registry；
3. 各域插件在自己的 `apply` 中注册路由：
   - agents-service 插件 → `/api/agents`
   - history 插件 → `/api/history`
   - plugin-manager 插件 → `/api/plugins`
   - webui 插件 → `/api/ui` + `/ui-plugin`
4. 保持所有旧测试 URL 不变。

### 块 C：静态行 HMR —— ✅ 已完成

- 现状：动态插件 `PluginHost.watch` 已热重载；cordis.yml 静态行没有 HMR。
- 前置：vendor `@agentchat/cordis-timer`（root 已有 pnpm 包引用但未 vendor/挂载）、loader 暴露内部 fiber 接口。
- 判据：改任一 `packages/*/src/plugin.ts` 后无需重启即生效，失败保留旧 fiber。

### 块 D：P5.5 收尾 —— ✅ 已完成

- iframe isolated 档：白名单 request + 受控 postMessage；不暴露 Vue/注册表。
- `global-style` slot：插件名前缀重写、禁 `url()` 外链。
- CSP 审计：生产 dist 只允许 `self` + 内联样式 + 插件 entry 的静态资源。

### 块 E：方向 D（整体切换 src）—— ✅ 已完成

- preview 已切换根目录：`packages/*/* → src 对应目录`、`preview/vendor/* → src/vendor/*`。
- 迁移后根目录全量验证全部通过：typecheck 0 错误、test 406/406、build + WebUI vite build、desktop Tauri NSIS+MSI、dev 冒烟 Loader Ready。

### 明确不做

- per-Agent cordis.yml / child Context（已决策暂停）。
- 插件任意改 DOM（slot 白名单是最终边界）。

---

## 3. 块 E 实施与验收（L4：preview 整体切换 src）—— ✅ 已完成

> “一切皆插件”的最后一公里已走完。详细执行记录见 `docs/block-e-migration.md`。

### 第 1 步：盘点与冻结 preview 状态

- 确认基线：`preview/pnpm typecheck` 0 错误、`preview/pnpm test` 406/406、WebUI `typecheck/build` 通过、`pnpm dev` + HMR 正常。
- 确认 45 包、8 个 vendor 包、`preview/cordis.yml` 39 个插件行不再新增结构改动。
- 记录当前 workspace 数据为验证基线（备份到 preview 之外，勿带入 src）。

### 第 2 步：规划目录映射（先写迁移文档，再动手）

```text
preview/packages/*/*        → src/<domain>/<pkg> 对应目录
preview/vendor/*            → src 内部 vendor/*
preview/cordis.yml          → 根目录 cordis.yml（或 scripts/config）
preview/pnpm-workspace.yaml → 根 workspace 配置
preview/packages/ui/webui   → src/ui/webui（源码 + dist 自包含）
```

- 必须先列出“旧 src 哪些文件删除、哪些暂时保留为兼容垫片”的清单。
- 特别注意 `@shared` 路径映射、`preview` 内部所有相对路径（webui vite alias、boot 模板路径等）。
- desktop/Tauri 引用路径同步更新。

### 第 3 步：迁移 + 全量验证（不可只跑 preview 测试）

| 验证项 | 命令/判据 |
|---|---|
| 全量 typecheck | 根目录 `tsc --noEmit`（旧 src + 新包全部通过） |
| 全量测试 | 根目录 `pnpm test`：406/406 不回归 + 旧 src 测试通过或按计划删除 |
| 构建 | root build + WebUI `vite build` |
| dev 冒烟 | `pnpm dev`：Loader Ready + HMR 仍可用 |
| 桌面端 | desktop/Tauri 打包流程可用，静态资源/端口/自包含 dist 正常 |
| 旧行为回归 | 首启/非首启/已有 admin、模型保存热生效、错误消息只一条、失败后同文案重发、群聊加载/发送、头像 fallback |

### 第 4 步：收尾清理 —— ✅ 已完成

- 旧 src 轨道与 `preview/` 临时轨道已删除（源码基线备份在 `backups/`，不入库）；
- 根 README/交接文档已更新；
- `docs/everything-plugin-gap-plan.md` 状态已改为 L4 ✅。

### 验收结果（2026-08-15 块 E）

| 验证项 | 结果 |
|---|---|
| 根目录 `pnpm typecheck` | ✅ 0 错误 |
| 根目录 `pnpm test` | ✅ **406/406** |
| 根目录 `pnpm build`（WebUI vue-tsc + vite build） | ✅ 通过 |
| desktop `npm run build`（Tauri） | ✅ NSIS + MSI 两个 bundle 产出 |
| 根目录 `pnpm dev` 冒烟 | ✅ Loader Ready + WebUI 3830 |

### 可选优化（不影响主目标，有空再做）

1. **WS 注册化**：给 WebUI 宿主增加 `ctx.ws` 注册口，让插件域挂 WS 事件处理器（当前 HTTP 已注册化，WS 仍是宿主内置）。
2. **内置插件目录去硬编码**：`boot/loader.ts` 的 `BUILTIN_PLUGIN_CATALOG` 改为各插件行声明 provides/manifest。
3. **registerCoreServices 与 cordis.yml 合并**：无 Loader 兜底路径从同一份组合清单生成，避免双清单漂移。

## 3.5 实施记录（2026-08-15 续·九：块 A–D 完成；块 E：preview 整体切换 src 完成）

- **块 E（L4：preview 整体切换 src）**：
  - 迁移前冻结基线：preview typecheck 0 错误 / test 406/406 / WebUI typecheck+build 通过；完整源码备份至 `backups/preview-block-e-baseline/`、旧 src 备份至 `backups/src-main-block-e-baseline/`。
  - `preview/packages/<domain>/<pkg>` → `src/<domain>/<pkg>`、`preview/vendor/*` → `src/vendor/*`；唯一保留兼容垫片 `src/shared/types/index.ts`（WebUI `@shared` alias）。
  - 根 workspace 切换为 pnpm（45 workspace projects）：`pnpm-workspace.yaml` = `src/*/*`；根 `cordis.yml` HMR root 改 `src`；根 tsconfig paths 全部 `packages/*` → `src/*`；vitest include `src/**/tests/**/*.test.ts`。
  - 路径修正：WebUI vite/tsconfig `@shared` 相对路径、webui-server 仓库根推导、webui 包 test script、boot supervisor 入口改为 cordis Loader。
  - 旧根 `tests/`（旧 src 架构测试）按计划删除，功能由各包 tests 覆盖；`preview/` 临时轨道删除。
  - 验收：根 `pnpm typecheck` 0 错误 / `pnpm test` 406/406 / `pnpm build` 通过 / desktop Tauri NSIS+MSI 打包通过 / `pnpm dev` Loader Ready + WebUI 3830。
- **块 A（boot 装配拆解）**：
  - 新增 `@agentchat/workspace` 包（workspace 初始化插件行，files 指引/默认 user/admin/首次引导）。
  - `@agentchat/archive/src/plugin`、`@agentchat/timer/src/service-plugin`、`@agentchat/subagent/src/service-plugin` 各自构造并持有 Manager，写入 `ctx.bootstrap.services`。
  - `@agentchat/server/src/service-plugin` 构造 InteractionBridge/ServiceRegistry/RPCBridge/AgentService/GroupService/HistoryService + ctx 门面。
  - boot 拆为 `plugin.ts`（核心契约 `ctx.bootstrap`）+ `plugin-finalize.ts`（收尾接线）+ `plugin-diagnostics.ts`（缺行诊断）；`bootstrap.ts` L4 `new` 清零。
  - `@agentchat/timer` 的 ctx 服务改名为 `ctx.timerManager`，把 `ctx.timer` 让给 vendored `@agentchat/cordis-timer`（HMR 前置）。
- **块 B（HTTP 路由注册插件化）**：
  - 新增 `HttpRouteRegistry`（ctx.http）：register/registerStatic/dispose 精确摘除 + 稳定 middleware。
  - WebUIServer 只挂 cors/json/static/routeRegistry/WS/SPA fallback；域路由由 server L4 行（agents/history/groups）、server http-routes 行（upload/config/browse/workspace/backup/version/usage/sessions）、plugins http 行（/api/plugins）、webui 行（/api/ui + /ui-plugin）注册。
- **块 C（静态行 HMR）**：
  - vendor `@agentchat/cordis-timer@1.1.3`；dev 脚本加 `--expose-internals`；cordis.yml 挂 timer + hmr 行（root=packages，`followSymlinks: false`）。
  - 实测改 `packages/examples/hello/src/index.ts` 无需重启即重载；坏语法改动期间旧 fiber 保留，恢复后再次热生效。
  - 坑：Windows/pnpm 下若 HMR watcher 跟随 packages/*/node_modules 符号链接，会扫描 pnpm store → CPU 100%、HTTP 请求挂起（表现为页面黑屏）；必须 `followSymlinks: false`。
- **块 D（P5.5 收尾）**：
  - isolated 档：`ui-plugin-iframe.html` + `isolated-runtime.ts` + `isolated.ts`，sandbox=allow-scripts（无 allow-same-origin），桥接仅 request（父窗口白名单 GET）/onEvent（白名单事件）/onUnload，不暴露 Vue/注册表。
  - global-style：`p5.5-policy.rewriteGlobalStyle` 强制 `.ui-plugin-<scope>` 前缀重写、`:root` CSS 变量、禁 url()/@import/at-rule/javascript:。
  - CSP：主 SPA `script-src 'self'` + 内联样式 + ws；isolated 容器 `default-src 'none'` + `script-src 'self'` + `frame-ancestors 'self'`。
  - 验证：`scripts/verify-p5.5.mjs` 真 Edge headless 验收（白名单 request 成功、越权 /api/agents 被拒）；`pnpm test` 406/406 全绿（含 CSP/策略单测）。
- **随后的运行时修复（续·九补）**：
  - 保存全局配置后 `ConfigService.reloadGlobalConfig` 改为「默认值合并 + 原地更新同一 globalConfig 引用」：`viewerId:'user'` 等默认值不再丢失（修复 `chat~admin~undefined` 会话），AgentLoader/Assembly 捕获的引用同步看到新配置。
  - `POST /api/config` 保存后自动热重载所有已注册 Agent：新 LLM 池保存后立即生效（修复“保存了 LLM 仍用旧 provider 无法会话”）。
  - HMR watcher 增加 `followSymlinks: false`（修复 Windows/pnpm 符号链接扫描导致 CPU 100%/页面黑屏）。
  - `agent-prompt` 1v1 对话对象从 `dialogId` 反解 counterpart（修复 admin 把 user 当成“艾吉”）。
  - `agent-loop` 流式错误去重：`chat.message.error` 只发一次（修复前端两条 API Key 错误）。
  - `chat.send` 幂等键改为客户端 `requestId`，失败后同文案重发不再被 30s 内容去重吞掉；`deduped` ack 会重置前端进行中状态。
  - 群聊历史：空群聊不再 `hasMore=true` + direct 自动续拉，修复加载历史无限递归卡死。
  - 群聊发送：前端监听 `group.delivered` 解锁输入框 + 10s 兜底，修复一直“Agent 回复中”。
  - Avatar 增加 `@error` 首字 fallback，Sidebar 不再硬编码空头像 URL。
  - System Prompt 预览改为复用 `ctx.hooks` 的 `agent-prompt.build-system-prompt` 钩子（旧 ServiceRegistry 通道兜底）。

---

## 4. 关键文件地图（下一会话 = 块 E，先读这些）

```text
preview/cordis.yml                                  ← 当前 39 个插件行（迁移到根目录的清单）
preview/pnpm-workspace.yaml                          ← packages/*/* + vendor/*（迁移 workspace 配置）
preview/packages/*/*/package.json                    ← 45 包依赖关系（迁移 package 边界）
preview/vendor/*                                     ← 8 个 vendored cordis 包（迁入 src 内部 vendor）
preview/packages/ui/webui                            ← WebUI 源码+dist 自包含（迁移重点）
preview/packages/ui/webui/vite.config.ts             ← @shared 别名（迁到 src 后要重新对齐）
preview/packages/boot/boot/src/{plugin,plugin-finalize,plugin-diagnostics}.ts ← boot 三行（保持不动）
preview/packages/host/server/src/{webui-server,http-routes,service-plugin}.ts ← 宿主/路由（保持不动）
docs/preview-knowledge-base.md                       ← 权威架构/坑位
docs/preview-next-session.md                          ← 本轮完整实施记录
desktop/                                             ← Tauri 打包引用路径（块 E 判据）
```

## 5. 验证命令

### 当前 preview 基线（已通过）

```powershell
cd C:\Users\xiaofeng\Documents\Dev\AgentChat\preview
pnpm install
pnpm typecheck
pnpm test
pnpm dev          # http://localhost:3830

# WebUI 插件包独立校验
cd preview\packages\ui\webui
pnpm typecheck    # vue-tsc + tsc(plugin)
pnpm build        # 包内产出 dist
```

### 块 E 完成后必须额外跑（根目录）

```powershell
cd C:\Users\xiaofeng\Documents\Dev\AgentChat
pnpm install
pnpm typecheck
pnpm test
pnpm build
# + desktop/Tauri 打包 + pnpm dev 全链路冒烟
```

## 6. 一句话交接

> 现状：**L1/L2/L3/L4 全部完成（块 E：preview 已整体切换 src）**；根目录 `pnpm typecheck` 0 错误、`pnpm test` 406/406、`pnpm build` 通过、desktop Tauri NSIS+MSI 打包通过、`pnpm dev` Loader Ready。
