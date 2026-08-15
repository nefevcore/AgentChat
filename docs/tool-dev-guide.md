# AgentChat 工具开发指引

> 面向 Agent / 开发者：如何在 5 层架构下开发、装配并热加载工具。
> 适用版本：v0.5.0（5 层架构：core ← agents ← plugins ← services ← app）。

---

## 1. 核心概念

AgentChat 的工具是 **OpenAI function-calling 工具**：LLM 通过 `tool_calls` 调用，工具执行后把结果字符串返回给 LLM。工具按**能力标签（requires）自动注入**——Agent 的 `tags` 匹配工具的 `requires`（AND 语义）即自动可用，无需在 `config.json` 里写死工具白名单。

关键特性：
- **统一工厂**：`defineTool()` 自动补全 `definition`，作者只写「参数 Schema + execute」
- **按领域聚合**：工具不按工具名分目录，而是按领域集中在一个 `.ts` 文件（如 `files.ts` 放 read/write/edit/bash）
- **per-Agent 烘焙**：工具工厂 `(config, services) => Tool` 每次投递按 Agent 配置烘焙（身份 from、沙箱、`tool.*` 命名空间、services 服务引用）
- **requires 门控**：`requires: ['agent']` 人人可用；`['dev']` 需 dev 标签；`['conductor']` 需 conductor；`['admin']` 需 admin

---

## 2. 目录结构

```
src/plugins/builtin/tools/
├── files.ts      # read / write / edit / bash（文件与命令）
├── agent.ts      # send_agent / list_agents / list_groups / list_tools / read_agent_info / update_agent_profile
├── session.ts    # query_history / inspect_session / continue_turn
├── timer.ts      # timer（action: set/list/disable）
├── subagent.ts   # subagent（action: spawn/list/await/kill）
├── app.ts        # system_restart / reload / ask_questions
└── web.ts        # code_search / read_logs / web_search / browser
```

聚合入口 `src/plugins/builtin/index.ts`：

```typescript
export function builtinTools(config: AgentConfig, services: PluginServices): Tool[] {
  return [
    ...makeFileTools(config),
    ...makeAgentTools(config, services),
    ...makeSessionTools(config, services),
    ...makeTimerTools(config, services),
    ...makeSubagentTools(config, services),
    ...makeAppTools(config, services),
    ...makeWebTools(config, services),
    // ...新增领域文件后在此追加
  ];
}
```

> math 插件同理：`src/plugins/builtin-math/tools.ts` 定义 `math` 工具，在 `src/plugins/builtin-math/index.ts` 导出。

---

## 3. 用 defineTool 定义工具

### 3.1 最小示例

```typescript
// src/plugins/builtin/tools/files.ts
import { defineTool } from '../../define-tool';
import type { AgentConfig } from '@agents/config';
import type { Tool } from '@core/types';

/** 读取文件工具（requires:['agent'] → 所有真实 Agent 自动注入） */
export function makeReadTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'read',
    label: '读取文件',
    requires: ['agent'],                 // 能力标签门控（可选；缺省=无限制）
    description: '读取文件内容或列出目录。文件默认启用 Hashline v2 格式（[PATH#TAG] 头 + 行号:内容），配合 edit 的 SWAP/INS 操作精确定位。目录返回 JSON 列表（name+type，目录在前）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或目录路径（相对工作区）' },
        lineHash: { type: 'boolean', description: '是否启用 Hashline v2 格式。默认 true；设 false 仅输出行号:内容。' },
      },
      required: ['path'],
    },
    execute: async ({ path: p }) => {
      // 实现逻辑
      return '返回给 LLM 的结果字符串';
    },
    extractLabel: (args) => args.path,   // 可选：从参数提取 UI 短标签
  });
}
```

### 3.2 DefineToolInput 全字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `name` | `string` | ✅ | 工具名（= `definition.function.name`，LLM 调用名），全局唯一 |
| `label` | `string` | ✅ | 前端 UI 中文标签 |
| `requires` | `string[]` | ❌ | 能力标签（AND 语义；缺省 = 无限制，需显式声明才有） |
| `ns` | `string` | ❌ | 命名空间（读取配置键，如 `"tool.bash"` → `config["tool.bash"]`；仅真实配置点设置） |
| `description` | `string` | ✅ | 给 LLM 看的描述（决定 LLM 何时调用） |
| `parameters` | `object` | ✅ | JSON Schema 参数定义 |
| `execute` | `function` | ✅ | 执行逻辑 `(args, stream?, signal?) => Promise<string>` |
| `extractLabel` | `function` | ❌ | 从参数提取 UI 短标签 |

---

## 4. requires 门控（自动注入）

工具按 `requires` 自动注入，匹配 Agent 的 `tags`（`'agent'` 为隐式基础标签，所有真实 Agent 自动拥有）：

| requires | 效果 |
|----------|------|
| `['agent']` | 所有真实 Agent 自动可用（read/write/edit/bash/send_agent/query_history/ask_questions/timer 等） |
| `['dev']` | 需 `dev` 标签（code_search/reload/inspect_session/read_logs/browser） |
| `['conductor']` | 需 `conductor` 标签（subagent 子 Agent 调度） |
| `['admin']` | 需 `admin` 标签（system_restart） |

> 生命周期类工具合并约定（0.6.1）：同一对象上的多操作合并为单一工具 + `action` 枚举分发（如 `timer` 的 set/list/disable、`subagent` 的 spawn/list/await/kill），减少 LLM 心智负担与 tool 定义 token。新工具若有相似生命周期，优先采用此模式。

> `requires` 为空的工具**不会自动注入**，必须经 `config.plugins[].tools` 显式声明。给工具打上 requires 标签是让它"人人/按标签可用"的标准做法。

装配入口 `src/plugins/registry.ts`：

```typescript
resolveTools(names, config) {
  // 1. requires 自动注入（requires 非空且匹配 agentTags）
  // 2. 显式追加（config.plugins[].tools 声明的名字）
}
```

---

## 5. per-Agent 烘焙（config + services）

工具工厂可接收 `config` 与 `services`，实现 per-Agent 行为：

### 5.1 config —— 沙箱 / 身份 / 命名空间

```typescript
export function makeReadTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'read',
    requires: ['agent'],
    // ...
    execute: async ({ path: p }) => {
      const file = resolveSafePath(config, p);   // 沙箱路径解析（config.allowedPaths 白名单）
      // ...
    },
  });
}
```

常用 config 用法：
- `resolveSafePath(config, p)` — 沙箱路径解析（`src/plugins/builtin/tools/shared.ts`）
- `config.agent_id` — 当前 Agent 身份（send_agent 的 from）
- `config['tool.xxx']` — 工具命名空间配置

### 5.2 services —— 运行时服务注入

```typescript
export function makeSendAgentTool(config: AgentConfig, services: PluginServices): Tool {
  const from = config.agent_id;
  return defineTool({
    name: 'send_agent', requires: ['agent'],
    // ...
    execute: async ({ to, message }) => {
      const router = services.router;           // 消息路由
      // ...
    },
  });
}
```

`PluginServices` 可用服务（`src/plugins/types.ts`）：
- `router` — 消息路由（send_agent/send_group/list_agents 等）
- `llm` — 当前 Agent 的 LLM 实例
- `tools` — 当前 Agent 的工具集（subagent 受控工具筛选）
- `timer` — 定时任务管理器（timer 工具用）
- `subAgent` — 子 Agent 管理器
- `interaction` — 用户交互桥（ask_questions 用）
- `searchProviders` — 搜索 provider 池
- `agentsDir` — Agent 配置目录

> 依赖方向约束：**tools 只依赖 `src/core` + `@agents/config` + `@core/types` + `define-tool` + 本层 types**，不直接 import 上层（services/app）。运行时服务一律经 `PluginServices` 注入。

---

## 6. execute 返回值

| 返回类型 | 说明 |
|----------|------|
| `string` | 直接返回给 LLM 的文本 |
| `{ content: string }` | LLM 看到的文本 |

**推荐格式**（结构化 JSON，方便 LLM 解析）：
```typescript
// 成功
return JSON.stringify({ status: 'ok', data: { ... } });
// 失败
return JSON.stringify({ status: 'error', data: { message: '错误原因' } });
```

**语义化中断**（reload / system_restart 用）：
```typescript
import { ToolInterrupt } from '@core/interrupt';
throw new ToolInterrupt({ type: 'reload-requested', scope });   // loop 收尾后继续推理
throw new ToolInterrupt({ type: 'restart-requested', reason }); // supervisor 重启
```

---

## 7. 错误处理与最佳实践

### 7.1 错误处理
```typescript
execute: async (args) => {
  try {
    return JSON.stringify({ status: 'ok', data: result });
  } catch (err: any) {
    return JSON.stringify({ status: 'error', data: { message: err.message } });
  }
};
```

### 7.2 参数校验
```typescript
if (!args.filePath) {
  return JSON.stringify({ status: 'error', data: { message: '缺少 filePath 参数' } });
}
```

### 7.3 路径安全
```typescript
const safe = resolveSafePath(config, args.path);
if (!safe) return JSON.stringify({ status: 'error', data: { message: '路径越界' } });
```

### 7.4 工具描述撰写
- `description` 是 LLM 决定是否调用的关键依据
- 写清楚：**做什么、需要什么参数、返回什么**
- 用英文（与模型训练数据一致），参数描述可用中文

---

## 8. 新增工具 → 生效流程

新架构下工具是**内置插件源码**，Agent 专属 `tools/` 目录不再加载。流程：

```
1. 在 src/plugins/builtin/tools/<领域>.ts 用 defineTool 定义新工具
2. 在该领域 makeXxxTools 工厂中 return 数组里加入 makeXxxTool
   （或新建领域文件后，在 src/plugins/builtin/index.ts 的 builtinTools 里追加）
3. 生效方式：
   · reload(scope=global) — 仅配置/工具开关生效（重读全部 Agent 配置重新注册，当前 run 重烘焙工具后继续推理，不重启）；**不重载插件源码**
   · system_restart — 修改 src/plugins/builtin/ 工具/钩子源码，或 src/core、src/app、src/server 等核心代码后重启后端（Supervisor 自动拉起，WS 约 2s 重连）
4. 验证：list_tools 看到新工具（或配置对应 requires 标签后可见）
```

> `reload(scope=global)` 的 `performReload` 实现（`src/app/index.ts`）：重读磁盘配置 → 重新注册 → `createAgentContext` 重烘焙 `ctx.tools` → loop `continue` 继续推理。**仅配置/工具开关变更本轮即可用**，不会戛然而止。注意：插件源码改动（tools/hooks 的 .ts）不会随 reload 加载——tsx ESM 模块缓存使旧代码仍驻留，必须 `system_restart` 进程级重启。

**给 Agent 增加工具**：不需要改代码——只要该工具 `requires` 标签匹配 Agent 的 `tags` 即自动注入。用 `update_agent_profile` 管理自己的 `tags`（如加 `dev`/`conductor`/`admin`）即可解锁更多工具。

---

## 9. 钩子（可选扩展）

工具之外，还可以装配**生命周期钩子**（`src/plugins/builtin/hooks/`）：

| 钩子 kind | 时机 | 内置实现 |
|-----------|------|---------|
| `runStart` | 整次执行开始 | `agent-prompt.build-system-prompt` / `agent-memory.load-memory` / `agent-session.load-history` / `agent-mcp.open-mcp` / `agent-skill.discovered_skills` |
| `toolExecutionStart` | 工具执行前 | `security.security-check`（安全检查） |
| `toolExecutionEnd` | 工具执行后 | `hooks.log-tool` |
| `runEnd` | 整次执行结束 | `agent-session.save-session` / `agent-memory.update-memory` / `agent-session.idle-reset` / `agent-session.archive-session` / `agent-session.log-usage` |

钩子按名在 Agent 的 `config.plugins[].runStart/runEnd/...` 中声明（无自动注入，必须显式声明）。新增钩子在对应扩展域的 `register.ts` 注册，并加入 `@agentchat/hooks` 的 `BUILTIN_HOOK_CATALOG`（供前端"可用钩子"列表）。

---

## 10. 内存常驻状态

Tool 对象在 Agent 生命周期内是同一个引用，可用模块级闭包变量维持进程级常驻（浏览器实例、连接池等）：

```typescript
let cached: Browser | null = null;
export function makeBrowserTool(): Tool {
  return defineTool({
    name: 'browser', requires: ['dev'],
    // ...
    execute: async (args) => {
      if (!cached) cached = await launch();
      return use(cached, args);
    },
  });
}
```

---

## 11. 常见问题

- **工具不出现**：确认 `requires` 与 Agent tags 匹配；`requires` 为空须显式声明；`list_tools` 查看当前启用
- **改代码不生效**：`reload(scope=global)` 只重读 Agent 配置（config.json/工具开关），**不重载插件源码**；修改 `src/plugins/builtin/` 的 tools/hooks 代码必须 `system_restart`
- **沙箱拒绝**：路径须在 `config.allowedPaths` 白名单内；用 `resolveSafePath` 校验
- **services 未注入**：工具工厂第二参 `services` 由 L5 装配注入；确认 `makeXxxTools(config, services)` 传递了 services
