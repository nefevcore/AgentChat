# AgentChat 插件系统

> 最后更新：2026-07-25 | 对应实现：方案 C（PluginManifest 容器模式）

---

## 设计原则

**不合并 Extension/Tool 类型。** `PluginManifest` 是纯打包容器，扩展、工具、拦截器各自保持独立的类型定义和生命周期。一个插件包可以同时包含这三者。

```
PluginManifest（容器）
├── extensions:  PluginEntry[]   →  preHook / postHook（ReAct 生命周期钩子）
├── tools:       PluginEntry[]   →  function-calling 工具（LLM 按需调用）
└── interceptors: PluginEntry[]  →  框架级强制拦截器（每次工具调用前执行）
```

---

## 目录结构

```
src/global/
├── agent-core/              ← 内置核心插件
│   ├── plugin.json          ← 清单（声明此包包含什么）
│   ├── extensions/
│   │   ├── agent-prompt/
│   │   │   ├── meta.ts
│   │   │   └── extension.ts
│   │   ├── agent-session/
│   │   └── agent-memory/
│   ├── tools/
│   │   ├── bash/
│   │   ├── read/
│   │   └── ...
│   └── interceptors/
│       ├── send_agent_from/
│       └── send_to_room_from/
│
└── agent-math/              ← 数学工具插件（独立包）
    ├── plugin.json
    └── tools/
        └── math/
```

---

## 核心类型

### PluginManifest

```typescript
// src/discovery/config-types.ts

interface PluginManifest {
  name: string;              // 插件唯一名称
  version?: string;          // 版本号
  label?: string;            // 显示标签
  description?: string;      // 描述
  extensions?: PluginEntry[];   // 扩展白名单
  tools?: PluginEntry[];        // 工具白名单
  interceptors?: PluginEntry[]; // 拦截器白名单
}
```

### PluginEntry

```typescript
interface PluginEntry {
  name: string;              // 条目名称（对应子目录名）
  path?: string;             // 子目录路径（相对于 plugin.json 所在目录）
                             // 省略时默认：{type}s/{name}（如 tools/bash）
}
```

**关键约定：**
- `name` 必须与 `meta.ts` 中导出的 `name` 一致 —— 这是单一数据源原则
- `path` 仅在自定义目录结构时需要指定
- **数组顺序 = 推荐加载顺序**（对 extensions 有意义；tools 和 interceptors 无序）

---

## plugin.json 示例

### 完整插件（扩展 + 工具 + 拦截器）

```json
{
  "name": "agent-core",
  "version": "1.0.0",
  "label": "内置插件",
  "description": "AgentChat 内置的扩展、工具和拦截器",

  "extensions": [
    { "name": "agent-prompt",  "path": "extensions/agent-prompt" },
    { "name": "agent-session", "path": "extensions/agent-session" },
    { "name": "agent-memory",  "path": "extensions/agent-memory" }
  ],
  "tools": [
    { "name": "bash", "path": "tools/bash" }
  ],
  "interceptors": [
    { "name": "send_agent_from", "path": "interceptors/send_agent_from" }
  ]
}
```

### 最简插件（仅工具，使用默认路径）

```json
{
  "name": "agent-math",
  "version": "1.0.0",
  "label": "数学工具",
  "description": "AgentChat 数学计算工具",

  "tools": [
    { "name": "math" }
  ]
}
```

`"name": "math"` 省略 `path` → 自动解析为 `tools/math/`。

---

## 发现与加载流程

```
AgentLoader.loadOne()
  │
  ├─ scanGlobalPlugins(globalDir)
  │   │  遍历 src/global/*/
  │   │  读取 plugin.json → PluginManifest
  │   │  按 PluginEntry.path 逐个加载:
  │   │    loadToolFromDir()       → tool.ts  → Tool
  │   │    loadExtensionFromDir()   → extension.ts → Extension
  │   │    loadInterceptorFromDir() → interceptor.ts → ToolInterceptor
  │   └─ 返回 { tools, extensions, interceptors }
  │
  ├─ 合并 Agent 专属目录的工具/扩展
  │
  ├─ validateReferences() — Fail Fast: 引用的工具/扩展必须存在
  │
  └─ 按 config.json 的 pre_hooks/post_hooks/tools 数组选配
```

**关键行为：**
- plugin.json 是**白名单**：未在列表中声明的条目不会被加载
- 未找到 `plugin.json` 的目录被静默跳过
- Agent 专属目录（`agents/<id>/tools/`、`agents/<id>/extensions/`）仍按目录约定自动扫描（向后兼容）

---

## Agent 配置中的引用

Agent 的 `config.json` 仍按名称引用插件中的条目：

```json
{
  "agent_id": "coding_agent",
  "name": "编程助手",
  "tools": ["read", "write", "edit", "bash", "math"],
  "pre_hooks": ["agent-prompt", "agent-memory", "agent-session"],
  "post_hooks": ["agent-memory", "agent-session"]
}
```

| 字段 | 含义 |
|------|------|
| `tools` | 启用的工具列表（名称来自各工具的 `meta.ts`） |
| `pre_hooks` | 前置钩子，**数组顺序 = 执行顺序** |
| `post_hooks` | 后置钩子，**数组顺序 = 执行顺序** |

拦截器是**框架级强制约束**，不由 Agent 配置控制 —— 所有已加载的拦截器对所有 Agent 生效。

---

## 扩展加载顺序

`pre_hooks` / `post_hooks` 数组的顺序即执行顺序，完全由用户在 Agent 配置中控制。

`plugin.json` 中 `extensions` 数组的顺序仅作为**建议顺序**参考，当 Agent 配置未指定时的推荐默认值。当前实现中 Agent 配置必须显式指定 `pre_hooks` / `post_hooks`。

---

## 内置插件清单

| 插件 | 路径 | 扩展 | 工具 | 拦截器 |
|------|------|------|------|--------|
| `agent-core` | `global/agent-core/` | agent-prompt, agent-session, agent-memory | read, write, edit, bash, web_search, list_agents, send_agent, list_rooms, send_to_room | send_agent_from, send_to_room_from |
| `agent-math` | `global/agent-math/` | — | math | — |

---

## 与旧架构的差异

| 旧（硬编码三目录） | 新（PluginManifest 容器） |
|-------------------|--------------------------|
| `global/tools/` 自动扫描所有子目录 | `global/*/plugin.json` 白名单声明 |
| `global/extensions/` 自动扫描 | 按 `PluginEntry.path` 精确加载 |
| `global/interceptors/` 自动扫描 | 不声明 = 不加载 |
| 无版本/描述信息 | `plugin.json` 集中声明元信息 |
| 扩展/工具/拦截器物理隔离 | 一个目录 = 一个可分发的包 |
