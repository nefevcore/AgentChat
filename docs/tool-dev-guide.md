# AgentChat 工具开发指南

> 版本：v0.6.2（cordis 插件化架构）。工具统一经 `ctx.tools`（ToolsService）注册，由各工具域插件行装配；Agent 按 `requires` 标签自动获得。
> 本文从「定义一个工具」讲到「注册行 + 验证」。完整插件（manifest/发布/UI）见 [plugin-dev-guide.md](plugin-dev-guide.md)。
> 工作区内的运行时副本为 `workspace/default/files/shared/tool-dev-guide.md`（首次初始化时从本文复制；本文是唯一真源）。

---

## 1. 核心概念

- 工具是 **OpenAI function-calling 工具**：LLM 通过 `tool_calls` 调用，执行结果以字符串返回。
- **统一工厂 `defineTool()`**（`@agentchat/toolkit`）：写「参数 Schema + execute」即可，自动补全 `definition`。
- **per-Agent 烘焙**：工厂 `(config, services) => Tool` 每次投递按 Agent 配置烘焙（沙箱路径、身份 from、`tool.*` 命名空间、共享服务引用）。
- **requires 门控**：`requires`（AND 语义）匹配 Agent 能力标签即默认启用；`'base'` 为隐式基础能力层（旧 `agent` 归一化）。
- **owner 归属**：注册时 owner = 插件 name = preset id，支持按 Agent `presets` 过滤与动态插件卸载回收。

## 2. defineTool 快速上手

```typescript
// 示例形态与 src/math/math/src/tools.ts 一致
import { defineTool } from '@agentchat/toolkit';
import { CAPABILITY_BASE, type AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';

export function makeEchoTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'echo',                 // = definition.function.name，全局唯一
    label: '回声',                // UI 中文标签
    requires: [CAPABILITY_BASE],  // 能力标签（base=默认可用；dev/admin/conductor=权限门禁；缺省=默认关闭）
    description: '原样返回输入内容。参数 message 是要回显的消息。',
    parameters: {                 // JSON Schema（defineTool 自动放进 definition）
      type: 'object',
      properties: {
        message: { type: 'string', description: '要回显的消息' },
      },
      required: ['message'],
    },
    async execute(args, stream, signal) {
      return JSON.stringify({ status: 'ok', data: args });
    },
    extractLabel: (args) => args.message,   // 可选：UI 短标签
  });
}
```

### DefineToolInput 全字段

| 字段 | 必填 | 说明 |
|------|:---:|------|
| `name` | ✅ | 工具名（LLM 调用名） |
| `label` | ✅ | 前端显示标签 |
| `description` | ✅ | 给 LLM 看的说明（决定何时调用；建议英文、参数说明可中文） |
| `parameters` | ✅ | 参数 JSON Schema |
| `execute` | ✅ | `(args, stream?, signal?) => Promise<string \| { content, details? }>` |
| `requires` | ❌ | 能力标签数组（AND）；缺省需显式声明才启用 |
| `ns` | ❌ | 命名空间（有真实配置读取点才写，如 `tool.bash`） |
| `extractLabel` | ❌ | 从参数提取 UI 短标签 |

## 3. 注册：共享工具 vs 工厂

### 3.1 共享工具（无 per-Agent 差异）

```typescript
// 插件 apply(ctx) 内
ctx.tools.register(name, [toolA, toolB], { always: false, replace: false });
```

`@agentchat/math` 的 `math` 就是共享数组注册。

### 3.2 工具工厂（需要 config / services）

```typescript
ctx.tools.registerFactory(name, (config, services) => [
  makeEchoTool(config),
  makeSendAgentTool(config, services),
]);
```

`config` 常用：`agent_id`（身份）、`tags`、`config['tool.xxx']`（命名空间）、`security.allowedPaths`（配合 `resolveSafePath`）。
`services`（ToolContext/PluginServices）：`router`、`llm`、`tools`、`timer`、`subAgent`、`interaction`、`searchProviders`、`agentsDir`、`workspaceDir`、`archiveSession`、`idleReset` 等——运行时服务全部经此注入，**不要直接 import 上层包**。

## 4. requires 门控与 presets

| requires | 效果 |
|----------|------|
| `['base']` | 基础能力层，所有真实 Agent 默认可用（read/write/bash/web_search/browser/send_agent/timer 等；base 为隐式标签，无需写入 tags） |
| `['dev']` | 需 `dev` 标签（code_search/read_logs/reload/inspect_session） |
| `['conductor']` | 需 `conductor` 标签（subagent） |
| `['admin']` | 需 `admin` 标签（register_tool/register_plugin/system_restart） |
| 缺省 | **默认关闭**；必须写进 `tools.include` 显式启用 |

受控词汇表只有这四个：`base / dev / admin / conductor`（常量 `TOOL_CAPABILITIES`，来自 `@agentchat/agent-config`）。旧 `requires: ['agent']` 读取时归一化为 `base`，新代码不要再写。

`ctx.tools.resolveTools(config, services)` 三步：presets 过滤 owner → requires 权限门禁 → `tools.include/exclude` 意图覆盖（exclude 优先）。

```json
// Agent config.json（新契约）
{ "presets": ["agentchat-math"], "tools": { "include": ["echo"], "exclude": ["bash"] } }
```

> 生命周期类工具约定（0.6.1 起）：同一对象多操作合并为单一工具 + `action` 枚举分发（`timer` set/list/disable、`subagent` spawn/list/await/kill）。

## 5. execute 返回值与错误处理

| 返回 | 说明 |
|------|------|
| `string` | 直接给 LLM |
| `{ content, details }` | `content` 给 LLM；`details` 给 UI（富展示） |

推荐结构：`JSON.stringify({ status: 'ok'|'error', data: {...} })`。

**语义化中断**（reload / system_restart 用）：

```typescript
import { ToolInterrupt } from '@agentchat/agent-loop';
throw new ToolInterrupt({ type: 'reload-requested', scope: 'self' });
throw new ToolInterrupt({ type: 'restart-requested', reason: '升级代码后重启' });
```

**参数校验 / 路径安全 / 输出控制**：
- 校验参数后返回 `{status:'error'}` 而不是抛裸异常；
- 文件路径必须 `resolveSafePath(config, p)`（`@agentchat/toolkit`）——工作区 + `security.allowedPaths` 白名单；
- 长输出自行截断（shell 的 `outputMaxLen`/`maxBuffer` 目前只是 UI 表单声明，未强制截断，可作参考实现）；
- `signal` 支持外部中断（用户取消/优雅关闭）。

## 6. 内置工具现状（对照参考）

| 包 / 插件行 | 工具 | 学习点 |
|-------------|------|--------|
| `fs` → agentchat-fs-tools | read、write、edit | Hashline 快照、路径沙箱 |
| `fs-search` → agentchat-fs-search-tools | glob、grep | DSH dsh-tool-fs-search 语义移植（纯 TS）：无斜杠模式任意深度基名匹配、mtime 排序、内联上限（glob 100 / grep 250）、include 花括号交替、二进制跳过 |
| `str-replace-editor` → agentchat-str-replace-editor-tools | str_replace_editor | DSH dsh-tool-str-replace-editor 移植：单工具四命令（view/create/str_replace/insert）、字面量唯一匹配替换、零基行边界插入、快照同步（recordSnapshot） |
| `edit`（引擎包） | makeEditTool | 编辑引擎与工具定义分离，由 fs 行装配 |
| `shell` → agentchat-shell-tools | bash | 跨平台 shell、后台任务、杀进程树 |
| `web` → agentchat-web-tools | web_search、browser | provider 池解析（credits_used 透传，额度未强制） |
| `dev` → agentchat-dev-tools | code_search/read_logs/reload（dev） | 开发调试 |
| `dev` → agentchat-plugin-tools | register_tool + register_plugin/unregister_plugin（admin） | 插件/运行时扩展管理 |
| `session-tools` | query_history/continue_turn/inspect_session | JSONL 历史读取 |
| `restart` → agentchat-restart-tools | system_restart | ToolInterrupt / Supervisor 退出码重启链路 |
| `interaction` → agentchat-interaction-tools | ask_questions | InteractionBridge 交互桥 |
| `agent-tools` | send_agent 等 7 个 | 协作工具与防伪造 from |
| `timer` / `subagent` / `math` | timer / subagent / math | 工具行 + 服务行共用 Manager |

> ✅ `agentchat-fs-tools` 行注册 read/write/edit：`makeEditTool`（Hashline DSL 引擎）随 `@agentchat/edit` 独立，并由 `@agentchat/fs` 的 `makeFileTools` 一并返回（2026-08-16 修复）。详见 [plugins/edit.md](plugins/edit.md)。

## 7. 新增工具 → 生效流程（插件化时代）

**方式 A：写一个工作区插件（推荐，零改动核心）**

```
1. 建目录 my-tools/：manifest.json + index.ts
2. index.ts 的 apply 里 ctx.tools.registerFactory(name, ...) 注册新工具
3. register_plugin(name="my-tools", dir="<my-tools 目录>") 会话级加载调试
   —— 自动开启源码 watch（750ms 轮询；只监听该插件目录、只重载该插件，
      其他插件行不受影响、进程不重启；失败保留旧版本），并自动把 manifest.name
      追加进本 Agent config.presets + 触发 self reload，新工具立即可用（重启即失）
4. 开发完成：git 提交推送 + 挂 topic:agentchat-plugin → 宿主经市场安装
   （`agentchat plugin add <user>/<repo>` 或 WebUI 市场 tab；人审 + grants
   在市场路径统一；重启后自动加载，安装不回写 presets）
5. 其他 Agent 在自己的 config.presets 加 "my-tools" → reload(scope=global)
```

**方式 B：新增内置工具域行**

```
1. 在对应域包（如 src/fs/fs/src/tools.ts）用 defineTool 定义
2. 加入该域 makeXxxTools 返回值（registerFactory 已就位）
3. 确认 cordis.yml 挂载了该域插件行
4. reload(scope=global)：仅重读 Agent 配置并重烘焙工具（本 run 继续推理）
5. 修改了插件源码（.ts）→ system_restart（进程重启，Supervisor 自动拉起）
```

验证：`list_tools` 查看当前启用；或直接让 Agent 调用一次。

## 8. 常见问题

- **工具不出现**：requires 与 tags 不匹配（门禁）/ 未写 presets（新契约下 owner 被过滤）/ requires 为空未写 `tools.include` / 被 `tools.exclude` 停用。
- **改代码不生效**：`reload` 只重读配置与重烘焙，不重载源码；源码改动需 `system_restart`（`register_plugin` 加载的开发插件会自动 watch 热重载，是例外）。
- **沙箱拒绝**：路径不在 workspace 或 `security.allowedPaths` 白名单；用 `resolveSafePath`。
- **services 未注入**：工厂第二参由装配传入；确认 registerFactory 的 factory 签名为 `(config, services)` 并把 services 传进 `makeXxxTools`。
- **插件卸载后工具还在**：注册 owner 没有用插件 `name`——动态卸载靠 owner 回收。
