# @agentchat/boot
> 包路径 `src/boot/boot` · 版本 0.1.0 · 文档对应 v0.6.3（2026-08-16）

## 概述
装配域包：`AgentLoader`（扫描 `agents/`，全局基础 + Agent 差异合并）、装配工厂（`makeAgentAssembly` / `setupPlugins` / `makePluginManager`）、LLM/Search 池解析（五来源）、优雅关闭（42 重启约定）与 `Supervisor`。boot 只做契约接线，不 new 业务服务；业务服务由各域插件行持有，boot-finalize 最后接线。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `plugin.ts` | 插件行 `agentchat-bootstrap-core`：核心装配契约 |
| `bootstrap-core.ts` | `BootstrapCoreService`：`ctx.bootstrap` 最小契约 |
| `plugin-finalize.ts` | 插件行 `agentchat-bootstrap-finalize`：收尾接线 |
| `plugin-diagnostics.ts` | 插件行 `agentchat-boot-diagnostics`：装配缺口诊断 |
| `register-core.ts` | 共享装配函数（非插件行）：挂载核心服务行 + 能力插件行 |
| `loader.ts` | `loadGlobalConfig` / `resolveLLMPool` / `AgentLoader` / `makeAgentAssembly` / `makePluginManager` |
| `bootstrap.ts` | L5 主入口：编排 cordis 插件行装配顺序（直接调用路径） |
| `shutdown.ts` | `gracefulShutdown` / `requestRestart` / `EXIT_RESTART=42` |
| `supervisor.ts` | 父进程：spawn 工作进程，按退出码拉起 |
| `plugin-manager-service.ts` | `ctx.pluginManager` Service |
| `llm-schemas.ts` | LLM/Search Provider 表单 Schema |

## 插件行

| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| `plugin.ts` | `agentchat-bootstrap-core` | `['agentLoop','llm','tools','hooks']` | `ctx.bootstrap`（globalConfig/services/assembly/router/registry/loader/srcRoot/pluginEvents/pluginHost）；`ctx.agents`；`services.router/workspaceDir/agentsDir/searchProviders`；扫描全局插件库 |
| `plugin-finalize.ts` | `agentchat-bootstrap-finalize` | `['bootstrap','workspace','archive','timerManager','subagent','l4']` | `setRequestRestart` 注入；`PluginManager` 注册进 `serviceRegistry` + `ctx.pluginManager`；shutdown deps 接线；`timer.reloadAll()`；`flushPendingMessages` 后台（trigger 用完整 `triggerOptions` 恢复）；archive watcher；`ctx.webServerHost` |
| `plugin-diagnostics.ts` | `agentchat-boot-diagnostics` | `[]` | 5s 后检查 7 个必需服务并告警（不崩进程） |

`register-core.ts` 不是独立插件行，而是 `registerCoreServices(ctx)` 共享装配函数：依次 `ctx.plugin(agentLoop/llm/llm-deepseek/llm-openai/tools/pluginHost/fs/shell/web/dev/session-tools/restart/interaction/hooks/agent-prompt/agent-skill/agent-session/agent-memory/agent-mcp/security/agent-tools/timer/subagent/math)`；必须传模块对象并 `await`。

## 提供的能力

### ctx.bootstrap（BootstrapCoreService）

| 字段 | 说明 |
| --- | --- |
| `globalConfig` | `loadGlobalConfig()` 结果（默认值 + `workspace/config.json` + 路径派生） |
| `services` | `PluginServices` 共享实例（ToolContext；assembly 与工具烘焙共用） |
| `assembly` | `makeAgentAssembly()` 装配工厂产物 |
| `router` / `registry` | `AgentRouter` 与 `router.getRegistry()` |
| `loader` | `AgentLoader(globalConfig)` |
| `srcRoot` | `path.resolve(process.cwd())` |
| `pluginEvents` / `pluginHost` | 插件域事件总线与 `PluginHost`（事件 sink 已接） |
| `loadAgents()` | 由 workspace 插件调用：`loader.loadAll()` → 逐个 `registry.register(config)`，0 个时告警 |

### makeAgentAssembly 装配面

| 成员 | 实现 |
| --- | --- |
| `engine` | `ctx.agentLoop` |
| `createLLM(raw)` | `resolveLLMPool(raw, globalConfig)` → `ctx.llm.create`；并写 `services.llm`（当前 Agent 约定） |
| `resolveTools(names, config)` | `ctx.tools.resolveTools(names, config, services)`；写 `services.tools` |
| `loadHistory(convKey)` | `@agentchat/agent-session` 的 `loadHistory` |
| `resolveHooks(names, config)` | `ctx.hooks.collect(names, config, services)` |
| `emit(type, payload, data)` | 包装为 router `message` 事件 |
| `systemPrompt(config)` | `agent-prompt.buildSystemPrompt(config, services, { sender:'user' })` |
| `services.redactSecrets` | 全局密钥收集，注入 `security.redact-output` 钩子工厂 |
| `reloadAgents(scope, config)` | 热重载：self/all → reloadAgent；global/all → 全部 registry id |
| `requestRestart(reason)` | 延迟 import `shutdown` 并调用 |

### AgentLoader / 配置解析

- `loadOne(agentDirPath)`：读 `config.json` 差异 → `deepMerge(buildGlobalBase(globalConfig), agentDiff)` → 强制 `agent_id = agentDiff.agent_id` → 解析 LLM（`agentDiff.llm ?? globalConfig.llm`）与 `tool.web_search` 池。
- `loadAll()`：扫描 `agentsDir/*/config.json`，缺配置跳过，失败单条告警不阻断。
- `buildGlobalBase`：排除 `$` 内部字段与 `namespaces`，并把 `namespaces` 展平到顶层。
- `resolveLLMPool` 五来源：① 无 raw → 池 `default:true` 条目或首个；② 字符串 → 池引用；③ `$ref` + 覆盖；④ 内嵌且 `model` 名匹配池条目 → 自动转池引用；⑤ 传统内嵌（有 provider 或 base_url）。均执行环境变量 `${VAR}` 替换与凭据回注。
- `resolveSearchPool`：Agent 显式 > 池 default > 池首项。

### 配置默认值（loadGlobalConfig）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `maxHops` | `5` | 历史路由最大跳数默认值（当前 AgentRouter 未消费，见 plugins/router.md） |
| `messageQueryDefaultLimit` | `20` | 消息查询默认条数 |
| `workspaceDir` | `AGENTCHAT_WORKSPACE` 或 `workspace/default` | 相对 cwd 解析 |
| `agentsDir` / `sessionsDir` / `groupsDir` | `''` → 由 workspaceDir 派生 | 文件内拼接 |
| `viewerId` | `'user'` | 默认观察者 |
| `llmProviders` / `searchProviders` | `{}` | 池 |
| `allowedPaths` | `[]` | 路径白名单 |
| `timezone` | `'Asia/Shanghai'` | 定时任务时区 |
| `namespaces` | `{}` | 含 `.` 的顶层键解析进此字典 |

### 优雅关闭与 Supervisor

- `gracefulShutdown(exitCode, reason)` 顺序：`router.enterShutdownMode()` → `enqueueResumeForActiveSessions()`（活跃会话入队 continue-trigger，序列化 `input/triggerOptions/placement` 后落盘）→ 逐 Agent `abortSession` → `waitRunningDrained(10s)`（保证 save-session 落盘）→ `interaction.abortAll()` → `timer.stopAll()` → 杀全部子 Agent → `webui.stop()` → `archive.dispose()` → `process.exit(exitCode)`。
- `requestRestart(reason)`：Supervisor 模式（`isSupervised()`）以 `EXIT_RESTART=42` 退出，非托管退化为 0。
- `supervisor.ts`：spawn 工作进程并设 `AGENTCHAT_SUPERVISED=1`；退出码 42 或崩溃非 0 → 1.5s 后重启；0 → 一并退出；SIGINT/SIGTERM 转发（Windows 上 SIGINT 转 SIGTERM）。

### PluginManager（makePluginManager）

`boot-finalize` 注册为 `serviceRegistry['pluginManager']` 与 `ctx.pluginManager`。核心方法：

| 组 | 方法 |
| --- | --- |
| 目录 | `getCatalog()`（plugins: session > dev > installed > builtin 同名覆盖；hooks/tools 全量目录） |
| 装配 | `getAssembly(agentId)` / `saveAssembly(agentId, patch)`（原子写盘 + 热重载 + 失败回滚 + WS 广播） |
| 库生命周期 | `getLibrary()` / `stagePlugin` / `approvePlugin` / `rejectPlugin` / `uninstallPlugin` |
| 会话插件 | `getSessionPlugins` / `reloadSessionPlugin` / `unloadSessionPlugin` / `registerSessionPlugin` |
| 权限 | `getPermissions()`（vocabulary/defaultGranted/explicitRequired） |
| 暂存审查 | `getStagingTree` / `getStagingFile` |

`llm-schemas.ts`：`OPENAI_LLM_SCHEMA`、`DEEPSEEK_LLM_SCHEMA`、`OLLAMA_LLM_SCHEMA`、`SEARCH_PROVIDER_SCHEMAS`（tavily/serpapi/brave/duckduckgo）。

## 关键契约 / API

```ts
export interface BootstrapOptions {
  enableWebUI?: boolean; webuiPort?: number; workspace?: string;
  deferWebUI?: boolean; ctx?: Context;
}
export interface BootstrapResult {
  router; registry; globalConfig; loader;
  agentService; groupService; historyService; serviceRegistry; rpc;
  timer?; subAgent?; webui: WebUIServer | null;
}
export async function bootstrap(options?: BootstrapOptions): Promise<BootstrapResult>;
export { gracefulShutdown, requestRestart, EXIT_RESTART, setShutdownDeps } from './shutdown';
export { AgentLoader, loadGlobalConfig, resolveLLMPool, resolveSearchPool,
         setupPlugins, makeAgentAssembly, makePluginManager, buildGlobalBase, workspaceRoot } from './loader';
```

## 配置
- 插件行 `agentchat-bootstrap-core`：`{ workspace?: string }`（覆盖 `AGENTCHAT_WORKSPACE`）。
- 插件行 `agentchat-bootstrap-finalize`：`{ enableWebUI?: boolean; webuiPort?: number }`；`enableWebUI` 缺省 = `!(AGENTCHAT_NO_WEBUI === '1')`；`webuiPort` 缺省 3830。
- CLI：`--no-webui`、`--port=`、`--workspace=`。
- 环境变量：`AGENTCHAT_WORKSPACE`、`AGENTCHAT_NO_WEBUI`、`AGENTCHAT_SUPERVISED`。

## 与其他插件的关系
- 依赖（package.json 节选）：`@agentchat/agent-loop`、`agents`、`archive`、`backup`、`hooks`、`llm`、`plugins`、`protocol`、`router`、`server`、`subagent`、`timer`、`tools`、`util`、`cordis`、`agent-session`、`agent-prompt`、`security`、`agent-mcp`、`agent-memory`、`shell`、`agent-skill`、`math`、`toolkit`、`webui`、`workspace`、`agent-config`、`dotenv`。
- 使用方：进程主入口（`bootstrap()` / `supervisor.ts` / cordis Loader 的 `cordis.yml` 各行）。
- 方向约束：boot 允许依赖所有域包；域包只依赖 boot 契约结构（`ctx.bootstrap` 的类型），不反向 import boot。

## 测试
package.json 的 test 脚本为 `vitest run`。测试文件：`tests/bootstrap.test.ts`、`config-save-e2e.test.ts`、`http-routes-e2e.test.ts`、`message-flow.test.ts`、`plugin-manager.test.ts`、`plugin-ws-e2e.test.ts`。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
