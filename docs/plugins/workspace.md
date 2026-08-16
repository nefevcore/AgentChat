# @agentchat/workspace
> 包路径 `src/svc/workspace` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
工作区初始化插件（块 A 从 boot 拆出）。boot 核心行只提供 `workspaceDir/agentsDir/srcRoot` 契约，不执行任何文件初始化；本行负责：复制 `files/shared/tool-dev-guide.md` 指引、确保默认 `user` 虚拟 Agent、首次运行检测（无 admin 且无 `.initialized`）后创建默认 `admin`（艾吉）并注入首次引导消息，最后调用 `core.loadAgents()` 完成注册扫描。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `src/svc/workspace/src/plugin.ts` | 插件行：`initializeWorkspace` + `WorkspaceService` + `core.loadAgents()` |
| `src/svc/workspace/src/workspace.ts` | 工作区初始化全部实现（指引复制、user/admin、首次引导） |
| `src/svc/workspace/src/index.ts` | re-export |

## 插件行

| 模块文件 | 插件 name | inject | 提供/注册内容 |
| --- | --- | --- | --- |
| `src/svc/workspace/src/plugin.ts` | `agentchat-workspace` | `['bootstrap']` | `ctx.workspace = WorkspaceService`（`.isFirstRun` / `.workspaceDir`）；初始化落盘后调用 `core.loadAgents()` |

插件 `Config`：`{ templateRoots?: string[] }`（额外模板根目录，优先级最高）。

## 提供的能力

### initializeWorkspace(core, templateRoots = []) 职责

1. `copyWorkspaceGuides`：创建 `<workspace>/files/shared/`，从候选模板目录复制 `tool-dev-guide.md`（目标已存在则跳过；全部候选不存在仅告警）。
2. `ensureDefaultUser`：确保 `<agentsDir>/user/config.json` 存在：`{ agent_id:'user', name:'用户', virtual:true }`。
3. `isFirstRun`：`<workspace>/.initialized` 存在 → 非首次；否则扫描 `<agentsDir>/*/config.json`，任一 `tags` 含 `admin` → 非首次；否则首次。
4. 首次运行时：
   - `ensureDefaultAdmin`：创建 `<agentsDir>/admin/config.json`（`agent_id:'admin'`，`name:'艾吉'`，`tags:['admin','dev','conductor']`（base 隐式），预设 `presets` 包含 fs/shell/web/dev/plugin/session/restart/interaction/agent/timer/subagent/math 及 hooks/prompt/session/memory/mcp/skill/security 等，`tools:{include:[],exclude:[]}`，`hooks` 七类启用清单）；写 `<workspace>/.initialized`。
   - `injectFirstRunIntro`：向 `sessions/chat~admin~user/messages.jsonl` 注入艾吉的自我介绍（仅文件不存在或为空时写，幂等）。
5. 返回 `{ isFirstRun, workspaceDir }`。

### 模板候选目录（resolveTemplateRoots）

优先级：`config.templateRoots` → `srcRoot/docs`（当前唯一真源）→ `srcRoot/plugins/builtin` → `srcRoot/src/plugins/builtin` → `srcRoot/dist/src/plugins/builtin`（兼容候选，由 `scripts/copy-dist-assets.js` postbuild 刷新）→ `srcRoot/../src/plugins/builtin` → `srcRoot/../dist/src/plugins/builtin` → `srcRoot/../docs`。

## 关键契约 / API

```ts
interface WorkspaceCoreLike {
  workspaceDir: string;
  agentsDir: string;
  srcRoot: string;
  loadAgents(): void;
}
interface WorkspaceInitResult { isFirstRun: boolean; workspaceDir: string }
function initializeWorkspace(core: WorkspaceCoreLike, templateRoots?: string[]): WorkspaceInitResult;
function injectFirstRunIntro(workspaceDir: string): void;

class WorkspaceService extends Service {
  readonly isFirstRun: boolean;
  readonly workspaceDir: string;
}
declare module '@agentchat/cordis' {
  interface Context { workspace: WorkspaceService }
}
```

## 配置

| 配置项 | 来源 | 默认值/行为 |
| --- | --- | --- |
| `templateRoots` | 插件行 config | `[]`；额外模板根目录，插入候选列表最前 |
| `workspaceDir` / `agentsDir` / `srcRoot` | `ctx.bootstrap` 契约 | 由 boot 核心行的 `loadGlobalConfig` 派生 |
| `.initialized` | 工作区标记文件 | 存在则跳过首次引导 |

默认 Agent 契约：`user` 为虚拟 Agent；`admin`（艾吉）为平台管理员（非 `virtual`，含 `tags: admin` 与完整 `presets/hooks`）。

## 与其他插件的关系
- 依赖：`@agentchat/agents`、`@agentchat/agent-session`、`@agentchat/cordis`、`@agentchat/util`。
- 使用方：`@agentchat/boot`（bootstrap.ts 装配顺序中第一个域插件；finalize inject `workspace`）；`@agentchat/server`（service-plugin inject `workspace`，保证默认 Agent 已注册后才构造 L4）；归档/历史等读取工作区目录结构。
- 方向约束：只依赖 boot 核心契约结构，不 import `@agentchat/boot`。

## 测试
本包无独立 `tests/` 目录；工作区初始化行为由 `@agentchat/boot` 的 e2e 测试间接覆盖。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
