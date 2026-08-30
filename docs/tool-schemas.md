# 内置工具 Schema 全览

> 状态：**当前态参考**（随工具面演进同步更新）
> 生成日期：2026-08-19 · 最近更新：2026-08-20 第四轮（第二轮：参数统一 snake_case、edit 漂移修复、fs-search 补入默认 presets、register_tool 移除；第三轮：edit 极简化、query_history 拆分、inspect_session 移除、十个工具 schema 收敛；第四轮：全部 29 个描述按「口语化、有效指引、简单全面」重写——相信 Agent 理解能力，详细语义留在行为层与报错信息，效果由使用指标驱动迭代）
> 覆盖范围：标准 bundle（composition.base.yml + composition.web-app.yml）中全部 **29 个内置工具** 的完整 schema，逐字转录自源码。
> 关联文档：`docs/tool-capabilities.md`（能力标签设计）、`docs/tool-dev-guide.md`（工具开发指南）、`src/boot/boot/tests/tool-requires-inventory.test.ts`（requires 盘点测试）

---

## 1. 工具契约（schema 的载体）

工具经 `defineTool()`（`src/toolkit/toolkit/src/define-tool.ts`）定义，产出 `Tool` 接口（`src/core/contracts/src/engine.ts`）。LLM 实际看到的只有 `definition.function`（name / description / parameters 三件套）：

```ts
interface DefineToolInput {
  name: string;         // 工具名（= definition.function.name，LLM 调用名）
  label: string;        // 显示标签（UI）
  ns?: string;          // 配置命名空间（仅真实配置点设置，如 "tool.bash"）
  requires?: string[];  // 能力标签（受控词汇 base/dev/admin/conductor；AND 语义；缺省=默认关闭）
  description: string;  // 给 LLM 看
  parameters: Record<string, any>;  // JSON Schema
  execute: Tool['execute'];
  extractLabel?: (args) => string;  // UI 标签提取（可选）
}
```

- `requires` 语义：Agent `tags` 命中全部标签才可用；带 `base` 的工具对所有真实 Agent 默认可用。
- `ns` 现有读取点仅两个：`tool.bash`、`tool.web_search`（见 `toolkit/src/namespaces.ts`）。
- 参数命名约定（2026-08-20 定稿）：**snake_case 为正典**（schema 只声明 snake_case）；旧 camelCase/旧名参数在 execute 层保留兼容（会话历史重放不破）。**单工具单职责**：一处操作一次调用，批量交给 LLM 原生并行 tool_call，不开数组参数（edits[] 已按此移除）。
- 动态工具源（MCP / workspace Agent 自带工具）不在本文 29 个之列，见 §3。

## 2. 工具清单总表

| # | 工具名 | label | requires | ns | 参数数 | 所属 bundle 行 |
|---|--------|-------|----------|----|--------|----------------|
| 1 | read | 读取文件 | base | — | 3 | fs-tools |
| 2 | write | 写入文件 | base | — | 2 | fs-tools |
| 3 | edit | 编辑文件 | base | — | 3 | fs-tools |
| 4 | glob | 文件匹配 | base | — | 2 | fs-search-tools |
| 5 | grep | 内容搜索 | base | — | 3 | fs-search-tools |
| 6 | str_replace_editor | 字符串替换编辑器 | base | — | 7 | str-replace-editor-tools |
| 7 | bash | 执行命令 | base | tool.bash | 5 | shell-tools |
| 8 | job | 任务管理 | base | — | 3 | shell-tools |
| 9 | web_search | 网络搜索 | base | tool.web_search | 2 | web-tools |
| 10 | browser | 浏览器 | base | — | 9 | web-tools |
| 11 | read_logs | 读取日志 | dev | — | 4 | dev-tools |
| 12 | reload | 热加载 | dev | — | 1 | dev-tools |
| 13 | reload_modules | 热重载模块 | dev | — | 2 | dev-tools |
| 14 | register_plugin | 注册插件 | admin | — | 3 | dev-admin-tools |
| 15 | unregister_plugin | 卸载插件 | admin | — | 1 | dev-admin-tools |
| 16 | grep_history | 检索聊天历史 | base | — | 3 | session-tools |
| 17 | read_history | 读取聊天历史 | base | — | 4 | session-tools |
| 18 | system_restart | 重启后端 | admin | — | 1 | restart |
| 19 | ask_questions | 询问用户 | base | — | 2 | interaction |
| 20 | send_agent | 发送给 Agent | base | — | 3 | agent-tools |
| 21 | send_group | 发送到群组 | base | — | 2 | agent-tools |
| 22 | list_agents | Agent 清单 | base | — | 0 | agent-tools |
| 23 | list_groups | 群组清单 | base | — | 0 | agent-tools |
| 24 | list_tools | 工具清单 | base | — | 0 | agent-tools |
| 25 | read_agent_info | 读取 Agent 信息 | base | — | 1 | agent-tools |
| 26 | update_agent_profile | 更新个人档案 | base | — | 2 | agent-tools |
| 27 | timer | 定时任务 | base | — | 11 | timer-tools |
| 28 | subagent | 子 Agent 调度 | conductor | — | 7 | subagent-tools |
| 29 | math | 数学 | base | — | 1 | math-tools |

能力分布：base 21 个 · dev 3 个（read_logs / reload / reload_modules）· admin 3 个（register_plugin / unregister_plugin / system_restart）· conductor 1 个（subagent 仅 conductor）。参数总量 107（web_search 深度简化后）。

### 2.1 2026-08-20 工具面演进（三轮，均基于真实调用数据）

| 轮次 | 变更 | 依据 |
|------|------|------|
| 第一轮 | 参数统一 snake_case；edit schema/实现漂移修复；glob/grep 补入默认 presets；盘点测试补齐护栏 | 30 工具 schema 评审（本文档首轮产出 19 条疑点） |
| 第二轮 | **register_tool 移除**（动态能力收敛到 register_plugin 插件路径，grants 审批统一） | 与 register_plugin 功能重叠、代码注入面大 |
| 第三轮 | **edit 极简化**（收敛 file_path/old_string/new_string，DSL/行级/edits[] 全移除）；**query_history 拆分** grep_history + read_history；**inspect_session 移除**；read 加 offset/limit、write/bash/web_search/send_agent/timer/subagent 参数收敛（详见各明细块注记） | 5035 次 edit 调用统计（文本匹配 77.6%、DSL 7.4% 且成功率最低、11.6% 形态拼错全失败、83% 单条目）；inspect_session 近 7 天 46 次主要是"看会话尾部"（read_history 覆盖） |
| 第四轮 | **全部 29 个描述重写**：口语化表达、有效指引、简单全面；参数描述同步精简（如 read「文件或目录路径」替代「文件或目录路径（相对工作区）」）。详细语义（超时上限、模糊匹配规则、返回结构等）移出描述，留在行为层与报错信息里 | 相信 Agent 理解能力：描述过长本身是 token 负担与注意力稀释；效果由定期使用统计与成功率分析驱动迭代 |
| 第五轮 | **web_search 深度简化**（仅 query+description，DeepSeek 搜索只消费 query）；**遗留项清零**：job `lines`→`limit`（同语义统一）、grep_history/read_history 补 `oneOf` 二选一、`fields.hooks` 补完整 properties、数值参数补 minimum/maximum（12 处） | DeepSeek provider 参数消费核实；用户逐项裁决遗留清单（2 项明确不做） |

> **默认可见性**：新建 Agent（`/api/agents` 基线与 workspace admin 种子同源，见 `src/host/server/src/api/agents.ts` / `src/svc/workspace/src/workspace.ts`）的 presets 已含 `agentchat-fs-search-tools`（glob/grep），**仍不含** `agentchat-str-replace-editor-tools`（str_replace_editor，DSH 兼容定位，dsh-minimal 预设显式启用）。默认 presets 实际可见 **28 个工具**（29 − str_replace_editor），其中 base 20 个。

---

## 3. 动态工具源（无固定 schema，不在 29 个之列）

| 来源 | 机制 | 说明 |
|------|------|------|
| MCP | `agent-mcp` 插件（ns `agent.mcp`） | 从外部 MCP server 发现工具并注册，schema 由远端定义 |
| workspace Agent 自带 | `workspace/<ws>/agents/<id>/tools/*/tool.ts` | 旧格式 per-Agent 工具（`@core/types` 导入风格），如 agent_chat_dev 的 browser/code_search |

---

## 4. 全部工具 Schema 明细

> 每个工具给出：元信息（label / requires / ns / 源文件）+ description + parameters。**2026-08-20 第四轮：全部 29 个描述按「口语化、有效指引、简单全面」重写**（相信 Agent 理解能力；详细语义留在行为层与报错信息里，指标驱动的后续优化见各工具使用统计）。旧长描述可在 git 历史与本文档既往版本中查阅。

### 4.1 fs-tools —— 文件读写（read / write / edit）

#### 1. read 读取文件

- 源文件：`src/fs/fs/src/tools.ts`
- requires: `base`

**description**：
> 读取文本文件并返回带有行号的内容。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "文件或目录路径"
    },
    "offset": {
      "type": "number",
      "description": "起始行号（默认 1）",
      "minimum": 1
    },
    "limit": {
      "type": "number",
      "description": "最多返回的行数（默认 2000，最大 5000）",
      "minimum": 1,
      "maximum": 5000
    }
  },
  "required": [
    "file_path"
  ]
}
```


#### 2. write 写入文件

- 源文件：`src/fs/fs/src/tools.ts`
- requires: `base`

**description**：
> 创建或覆盖文本文件。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "文件路径"
    },
    "content": {
      "type": "string",
      "description": "文件完整内容"
    }
  },
  "required": [
    "file_path",
    "content"
  ]
}
```

#### 3. edit 编辑文件

- 源文件：`src/edit/edit/src/tool.ts`
- requires: `base`

**description**：
> 通过替换文本内容来编辑文本文件。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "文件路径"
    },
    "old_string": {
      "type": "string",
      "description": "要替换的原文"
    },
    "new_string": {
      "type": "string",
      "description": "替换后的文本"
    }
  },
  "required": [
    "file_path",
    "old_string",
    "new_string"
  ]
}
```

### 4.2 fs-search-tools —— 文件检索（glob / grep）

#### 4. glob 文件匹配

- 源文件：`src/fs/fs-search/src/glob.ts`
- requires: `base`

**description**：
> 按 glob 模式查找文件（如 "**/*.ts"）。

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "glob 模式，如 \"**/*.ts\"、\"*.test.ts\""
    },
    "path": {
      "type": "string",
      "description": "搜索根目录（默认工作区根）"
    }
  },
  "required": [
    "pattern"
  ]
}
```

#### 5. grep 内容搜索

- 源文件：`src/fs/fs-search/src/grep.ts`
- requires: `base`

**description**：
> 按正则表达式搜索文件内容。

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "正则表达式（JS RegExp 语法）"
    },
    "path": {
      "type": "string",
      "description": "搜索的文件或目录（默认工作区根）"
    },
    "include": {
      "type": "string",
      "description": "文件名过滤 glob，如 \"*.ts\""
    }
  },
  "required": [
    "pattern"
  ]
}
```

### 4.3 str-replace-editor-tools —— 编辑器兼容

#### 6. str_replace_editor 字符串替换编辑器

- 源文件：`src/fs/str-replace-editor/src/tool.ts`
- requires: `base`

**description**：
> 四合一文件编辑器：view 查看文件（带行号）或目录、create 创建文件、str_replace 精确文本替换、insert 按行号插入。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "enum": [
        "view",
        "create",
        "str_replace",
        "insert"
      ],
      "description": "命令：view / create / str_replace / insert"
    },
    "path": {
      "type": "string",
      "description": "目标文件或目录路径"
    },
    "file_text": {
      "type": "string",
      "description": "create：新文件的完整内容"
    },
    "old_str": {
      "type": "string",
      "description": "str_replace：要替换的原文（须唯一）"
    },
    "new_str": {
      "type": "string",
      "description": "str_replace：替换后的文本（空 = 删除）；insert：要插入的文本"
    },
    "insert_line": {
      "type": "integer",
      "description": "insert：插到第几行之后（与 view 显示的行号一致，0 = 文件开头）"
    },
    "view_range": {
      "type": "array",
      "items": {
        "type": "integer"
      },
      "description": "view：[起始行, 结束行]，-1 表示到文件尾"
    }
  },
  "required": [
    "command",
    "path"
  ]
}
```

### 4.4 shell-tools —— 命令执行（bash / job）

#### 7. bash 执行命令

- 源文件：`src/shell/shell/src/tools.ts`
- requires: `base` · ns: `tool.bash`

**description**：
> 执行 shell 命令并返回输出。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "要执行的命令"
    },
    "description": {
      "type": "string",
      "description": "命令作用的一句话说明（用于任务列表展示）"
    },
    "workdir": {
      "type": "string",
      "description": "工作目录（默认沙箱工作目录）"
    },
    "timeout": {
      "type": "number",
      "description": "超时毫秒（默认 30000，上限 120000）",
      "minimum": 1000,
      "maximum": 120000
    },
    "background": {
      "type": "boolean",
      "description": "后台执行，立即返回 job_id（用 job 工具管理）"
    }
  },
  "required": [
    "command"
  ]
}
```


#### 8. job 任务管理

- 源文件：`src/shell/shell/src/job.ts`
- requires: `base`

**description**：
> 管理后台任务：list 列出、kill 终止、logs 查看输出。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "list",
        "kill",
        "logs"
      ],
      "description": "操作"
    },
    "job_id": {
      "type": "string",
      "description": "[kill/logs] 任务 id（bash background / subagent 返回）"
    },
    "limit": {
      "type": "number",
      "description": "[logs] 返回尾部行数（默认 50，最大 500）",
      "minimum": 1,
      "maximum": 500
    }
  },
  "required": [
    "action"
  ]
}
```


### 4.5 web-tools —— 网络（web_search / browser）

#### 9. web_search 网络搜索

- 源文件：`src/web/web/src/tools.ts`
- requires: `base` · ns: `tool.web_search`

**description**：
> 搜索互联网，获取最新信息。

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "搜索关键词"
    },
    "description": {
      "type": "string",
      "description": "搜索目的的一句话说明（用于任务列表展示）"
    }
  },
  "required": [
    "query"
  ]
}
```

> 注：2026-08-20 简化——主用 DeepSeek 搜索（服务端 web_search 工具仅消费 query），其余 7 个参数（max_results/search_depth/topic/time_range/include_domains/exclude_domains/include_answer/include_raw_content）移出 schema；provider 级调优走 `tool.web_search` 命名空间配置（defaultResults/defaultDepth 等），execute 层仍兼容旧参数（其他 provider 部署可用）。

#### 10. browser 浏览器

- 源文件：`src/web/web/src/tools.ts`
- requires: `base`

**description**：
> 操作浏览器：open 打开页面、click 点击、type 输入、press 按键、content 提取文本、screenshot 截图、html 取源码、eval 执行 JS、close 关闭。可用 steps 批量执行多个动作。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "open",
        "click",
        "type",
        "press",
        "content",
        "screenshot",
        "html",
        "eval",
        "close"
      ],
      "description": "要执行的动作"
    },
    "url": {
      "type": "string",
      "description": "[open] 目标 URL"
    },
    "selector": {
      "type": "string",
      "description": "[click/type] CSS 选择器"
    },
    "text": {
      "type": "string",
      "description": "[type] 输入文本"
    },
    "key": {
      "type": "string",
      "description": "[press] 按键名，如 Enter"
    },
    "name": {
      "type": "string",
      "description": "[screenshot] 截图文件名"
    },
    "js": {
      "type": "string",
      "description": "[eval] JS 代码"
    },
    "steps": {
      "type": "array",
      "description": "批量模式：依次执行的动作序列",
      "items": {
        "type": "object",
        "properties": {
          "action": {
            "type": "string",
            "enum": [
              "open",
              "click",
              "type",
              "press",
              "content",
              "screenshot",
              "html",
              "eval",
              "close"
            ],
            "description": "动作"
          },
          "url": {
            "type": "string",
            "description": "目标 URL"
          },
          "selector": {
            "type": "string",
            "description": "CSS 选择器"
          },
          "text": {
            "type": "string",
            "description": "输入文本"
          },
          "key": {
            "type": "string",
            "description": "按键名"
          },
          "name": {
            "type": "string",
            "description": "截图文件名"
          },
          "js": {
            "type": "string",
            "description": "JS 代码"
          },
          "repeat": {
            "type": "number",
            "description": "重复次数（默认 1）",
            "minimum": 1,
            "maximum": 20
          },
          "delay_ms": {
            "type": "number",
            "description": "执行后等待毫秒（默认 0）",
            "minimum": 0
          }
        },
        "required": [
          "action"
        ]
      }
    },
    "continue_on_error": {
      "type": "boolean",
      "description": "批量模式：某步失败后是否继续（默认 false）"
    }
  }
}
```


### 4.6 dev-tools —— 开发调试（read_logs / reload / reload_modules）

#### 11. read_logs 读取日志

- 源文件：`src/dev/dev/src/tools.ts`
- requires: `dev`

**description**：
> 查看后端运行日志（最近 2000 条）。

```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "number",
      "description": "返回条数（默认 100，最大 500）",
      "minimum": 1,
      "maximum": 500
    },
    "level": {
      "type": "string",
      "enum": [
        "debug",
        "info",
        "warn",
        "error"
      ],
      "description": "最低日志级别"
    },
    "keyword": {
      "type": "string",
      "description": "关键词过滤"
    },
    "clear": {
      "type": "boolean",
      "description": "先清空缓冲再收集（默认 false）"
    }
  }
}
```


#### 12. reload 热加载

- 源文件：`src/dev/dev/src/tools.ts`
- requires: `dev`

**description**：
> 重新加载配置（改了 Agent 配置文件后调用）。改了源码请用 reload_modules。

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "enum": [
        "self",
        "global",
        "all"
      ],
      "description": "范围：self 本 Agent / global 全部 / all 两者（默认）"
    }
  }
}
```

#### 13. reload_modules 热重载模块

- 源文件：`src/dev/dev/src/module-reload.ts`
- requires: `dev`

**description**：
> 修改后端源码后热重载模块（无需重启进程）。框架/内核文件改动需用 system_restart。

```json
{
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "显式指定要重载的文件（通常留空，自动扫描变更）"
    },
    "reason": {
      "type": "string",
      "description": "重载原因（记入日志）"
    }
  }
}
```

### 4.7 dev-admin-tools —— 平台管理（register_plugin / unregister_plugin）

#### 14. register_plugin 注册插件

- 源文件：`src/dev/dev/src/plugin-tools.ts`
- requires: `admin`

**description**：
> 动态加载自己开发的插件（目录需含 manifest.json；高危权限 process/shell 须在 grants 显式授予）。仅调试用，正式发布走 git + 市场安装。

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "插件名（= 目录名 = manifest.name）"
    },
    "dir": {
      "type": "string",
      "description": "插件目录（默认 <workspace>/plugins/<本AgentId>/<name>/）"
    },
    "grants": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "fs",
          "network",
          "process",
          "shell",
          "ui"
        ]
      },
      "description": "显式授予的高危权限（process/shell）"
    }
  },
  "required": [
    "name"
  ]
}
```

#### 15. unregister_plugin 卸载插件

- 源文件：`src/dev/dev/src/plugin-tools.ts`
- requires: `admin`

**description**：
> 卸载由 register_plugin 加载的插件。

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "插件名"
    }
  },
  "required": [
    "name"
  ]
}
```

### 4.8 session-tools —— 会话历史（grep_history / read_history）

#### 16. grep_history 检索聊天历史

- 源文件：`src/session-tools/session-tools/src/tools.ts`
- requires: `base`

**description**：
> 按关键词检索聊天记录（自己和任何 Agent 的对话、或任何群聊）。

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "关键词（不区分大小写）"
    },
    "agent_id": {
      "type": "string",
      "description": "检索与该 Agent 的对话（\"user\" = 与用户的对话；与 group_id 二选一）"
    },
    "group_id": {
      "type": "string",
      "description": "检索该群聊（与 agent_id 二选一）"
    }
  },
  "required": [
    "pattern"
  ],
  "oneOf": [
    {
      "required": [
        "agent_id"
      ]
    },
    {
      "required": [
        "group_id"
      ]
    }
  ]
}
```


#### 17. read_history 读取聊天历史

- 源文件：`src/session-tools/session-tools/src/tools.ts`
- requires: `base`

**description**：
> 翻阅聊天记录（自己和任何 Agent 的对话、或任何群聊），返回最近的消息。

```json
{
  "type": "object",
  "properties": {
    "agent_id": {
      "type": "string",
      "description": "读取与该 Agent 的对话（\"user\" = 与用户的对话；与 group_id 二选一）"
    },
    "group_id": {
      "type": "string",
      "description": "读取该群聊（与 agent_id 二选一）"
    },
    "limit": {
      "type": "number",
      "description": "返回条数（默认 20，最大 100）",
      "minimum": 1,
      "maximum": 100
    },
    "offset": {
      "type": "number",
      "description": "分页偏移（默认 0 = 从最新往前）",
      "minimum": 0
    }
  },
  "oneOf": [
    {
      "required": [
        "agent_id"
      ]
    },
    {
      "required": [
        "group_id"
      ]
    }
  ]
}
```


### 4.9 restart —— 系统

#### 18. system_restart 重启后端

- 源文件：`src/restart/restart/src/tools.ts`
- requires: `admin`

**description**：
> 重启后端进程。改了框架/内核文件、环境变量或依赖后使用；普通源码改动用 reload_modules。

```json
{
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "description": "重启原因（记入日志）"
    }
  }
}
```

### 4.10 interaction —— 用户交互

#### 19. ask_questions 询问用户

- 源文件：`src/interaction/interaction/src/tools.ts`
- requires: `base`

**description**：
> 向用户提问并等待回答。用于需要用户决策或确认的场景。

```json
{
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "question": {
            "type": "string",
            "description": "问题"
          },
          "options": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "选项"
          }
        },
        "required": [
          "question",
          "options"
        ]
      },
      "description": "选择题列表（最多 5 题）"
    },
    "timeout_ms": {
      "type": "number",
      "description": "等待超时毫秒（不设 = 一直等）",
      "minimum": 0
    }
  },
  "required": [
    "questions"
  ]
}
```


### 4.11 agent-tools —— Agent 协作（7 个）

#### 20. send_agent 发送给 Agent

- 源文件：`src/agent-tools/agent-tools/src/tools.ts`
- requires: `base`

**description**：
> 给另一个 Agent（或自己）发消息。默认异步发出即返回；wait=true 等对方回复。

```json
{
  "type": "object",
  "properties": {
    "to": {
      "type": "string",
      "description": "目标 Agent ID"
    },
    "message": {
      "type": "string",
      "description": "消息内容"
    },
    "wait": {
      "type": "boolean",
      "description": "是否等待回复（默认 false）"
    }
  },
  "required": [
    "to",
    "message"
  ]
}
```

#### 21. send_group 发送到群组

- 源文件：`src/agent-tools/agent-tools/src/tools.ts`
- requires: `base`

**description**：
> 在群组里发消息，群内其他成员会自主决定是否回应。

```json
{
  "type": "object",
  "properties": {
    "group_id": {
      "type": "string",
      "description": "群组 ID"
    },
    "message": {
      "type": "string",
      "description": "消息内容"
    }
  },
  "required": [
    "group_id",
    "message"
  ]
}
```

#### 22. list_agents Agent 清单

- 源文件：`src/agent-tools/agent-tools/src/tools.ts`
- requires: `base`

**description**：
> 列出所有 Agent。

```json
{
  "type": "object",
  "properties": {}
}
```

#### 23. list_groups 群组清单

- 源文件：`src/agent-tools/agent-tools/src/tools.ts`
- requires: `base`

**description**：
> 列出自己所在的群组。

```json
{
  "type": "object",
  "properties": {}
}
```

#### 24. list_tools 工具清单

- 源文件：`src/agent-tools/agent-tools/src/tools.ts`
- requires: `base`

**description**：
> 列出自己可用的全部工具。

```json
{
  "type": "object",
  "properties": {}
}
```

#### 25. read_agent_info 读取 Agent 信息

- 源文件：`src/agent-tools/agent-tools/src/tools.ts`
- requires: `base`

**description**：
> 查看一个 Agent 的资料（不传 agent_id 看自己）。

```json
{
  "type": "object",
  "properties": {
    "agent_id": {
      "type": "string",
      "description": "目标 Agent ID（可选，默认自己）"
    }
  }
}
```

#### 26. update_agent_profile 更新个人档案

- 源文件：`src/agent-tools/agent-tools/src/tools.ts`
- requires: `base`

**description**：
> 更新 Agent 档案（name/description/persona/avatar/tags/presets/tools/hooks）。默认改自己，admin 可改他人。

```json
{
  "type": "object",
  "properties": {
    "agent_id": {
      "type": "string",
      "description": "目标 Agent（默认自己；仅 admin 可改他人）"
    },
    "fields": {
      "type": "object",
      "description": "要更新的字段",
      "properties": {
        "name": {
          "type": "string",
          "description": "显示名称"
        },
        "description": {
          "type": "string",
          "description": "简短描述"
        },
        "persona": {
          "type": "string",
          "description": "人物设定（写入 AGENT.md）"
        },
        "avatar": {
          "type": "string",
          "description": "头像文件名/URL"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "能力标签（base/dev/admin/conductor）"
        },
        "presets": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "启用的插件列表"
        },
        "tools": {
          "type": "object",
          "description": "工具开关：{ include?: string[], exclude?: string[] }",
          "properties": {
            "include": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "显式启用的工具"
            },
            "exclude": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "显式停用的工具"
            }
          }
        },
        "hooks": {
          "type": "object",
          "description": "钩子启用清单（数组顺序即执行顺序，不在清单里即停用）",
          "properties": {
            "runStart": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "run 开始钩子"
            },
            "runEnd": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "run 结束钩子"
            },
            "stepStart": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "step 开始钩子"
            },
            "stepEnd": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "step 结束钩子"
            },
            "toolExecutionStart": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "工具执行前钩子"
            },
            "toolExecutionEnd": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "工具执行后钩子"
            },
            "fallback": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "兜底钩子"
            }
          }
        }
      }
    }
  },
  "required": [
    "fields"
  ]
}
```


### 4.12 timer-tools —— 定时任务

#### 27. timer 定时任务

- 源文件：`src/svc/timer/src/tool.ts`
- requires: `base`

**description**：
> 管理定时任务：set 创建/修改、list 查看、disable 禁用。模式：delay 固定间隔 / random 随机间隔 / time 每天定点 / workday 工作日 / holiday 节假日；repeat_count=0 永久重复，N 次后自动归档。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "set",
        "list",
        "disable"
      ],
      "description": "操作"
    },
    "id": {
      "type": "string",
      "description": "[set] 任务 ID（更新时必填）；[disable] 要禁用的任务"
    },
    "mode": {
      "type": "string",
      "description": "[set] 模式",
      "enum": [
        "delay",
        "random",
        "time",
        "workday",
        "holiday"
      ]
    },
    "delay": {
      "type": "string",
      "description": "[set] 间隔（如 5m/1h）"
    },
    "delay_min": {
      "type": "string",
      "description": "[set] 最小间隔（random 模式）"
    },
    "delay_max": {
      "type": "string",
      "description": "[set] 最大间隔（random 模式）"
    },
    "time": {
      "type": "string",
      "description": "[set] 触发时刻（如 08:00 或 2026-07-27 14:30）"
    },
    "repeat_count": {
      "type": "number",
      "description": "[set] 重复次数（0 = 永久）",
      "minimum": 0
    },
    "hint": {
      "type": "string",
      "description": "[set] 触发时发给 Agent 的提示"
    },
    "target": {
      "type": "string",
      "description": "[set] 发送目标（逗号分隔，默认 user）"
    },
    "source": {
      "type": "string",
      "description": "[set] 来源标识"
    }
  },
  "required": [
    "action"
  ]
}
```


### 4.13 subagent-tools —— 子 Agent 调度

#### 28. subagent 子 Agent 调度

- 源文件：`src/svc/subagent/src/tool.ts`
- requires: `conductor`

**description**：
> 派出子 Agent 独立执行子任务（独立上下文，可并行多个）：spawn 创建、await 取结果、list 查看、kill 终止。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "spawn",
        "list",
        "await",
        "kill"
      ],
      "description": "操作"
    },
    "task": {
      "type": "string",
      "description": "[spawn] 任务描述（需完整自包含）"
    },
    "name": {
      "type": "string",
      "description": "[spawn] 子 Agent 名称"
    },
    "tools": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "[spawn] 可用工具名（留空 = 纯推理）"
    },
    "context": {
      "type": "string",
      "description": "[spawn] 附加上下文"
    },
    "subagent_id": {
      "type": "string",
      "description": "[await/kill] 子 Agent ID"
    },
    "wait_time": {
      "type": "number",
      "description": "等待秒数。[spawn] 传正值 = 等到完成（默认 0 = 立即返回）；[await] 默认 60",
      "minimum": 0,
      "maximum": 600
    }
  },
  "required": [
    "action"
  ]
}
```


### 4.14 math-tools —— 数学

#### 29. math 数学

- 源文件：`src/math/math/src/tools.ts`
- requires: `base`

**description**：
> 计算数学表达式（如 "1+2*3"、"sqrt(16)"、"(1+2**10)/4"）。

```json
{
  "type": "object",
  "properties": {
    "expression": {
      "type": "string",
      "description": "数学表达式"
    }
  },
  "required": [
    "expression"
  ]
}
```

---

## 5. 评审疑点与处置状态

> 首轮（2026-08-19）流出 19 条疑点；四轮工具面演进后大部分已处置（5.1），剩余遗留见 5.2。

### 5.1 已处置（按轮次）

| 原编号 | 问题 | 处置（轮次） |
|--------|------|------|
| A1-A4 | 参数命名三种风格并存（snake_case/camelCase/裸词混用；同领域分裂；超时单位三种表达） | 统一 snake_case 为正典；后续轮次进一步收敛 `file_path`（read/write/bash 域）、`workdir`、`wait_time`（1-3 轮渐进） |
| B5-B7 | edit extractLabel 读 `args.oldString` 与 schema 漂移；`ns: 'tool.edit'` 无读取点；ask_questions 残留 `args.convKey` | 全部修复（第 1 轮）；edit 后续整体极简化（第 3 轮） |
| B8 | math 描述矛盾（"无需 Math. 前缀" vs "可用 Math.*"） | 实现两者皆可，描述以参数描述为准（低优先，未动） |
| C10 | str_replace_editor 与 read/write/edit 重叠 | 默认 presets 不含其 owner，不构成双轨；保留 DSH 兼容层（维持现状） |
| C11 | glob/grep 高价值却不在默认 presets | 新建基线与 admin 种子补入 `agentchat-fs-search-tools`（第 1 轮） |
| C12 | 旧名兼容参数长期占 schema（no_wait 等） | send_agent/subagent 的 `no_wait`/`wait`/`wait_s`/`max_steps`/`timeout_s`、timer 的 `replace`/`max_steps`、bash 的 `stdin` 全部移出 schema（第 3 轮；execute 层兼容） |
| D14 | "二选一必填"无法用 JSON Schema 表达 | query_history/inspect_session 已拆分/移除；grep_history/read_history 的 agent_id/group_id 二选一、subagent 的 task、browser 的单动作/steps 仍靠运行时报错兜底（遗留 → 5.2.3） |
| F19 | 盘点测试漏 glob/grep/str_replace_editor | 已补齐；后续随拆分/移除同步更新（现 29 个全覆盖） |
| — | edit 多形态并发散（DSL/行级/edits[]/顶层平铺 camelCase 11.6% 全失败） | **edit 极简化**：单一三参数形态 + 旧形态迁移引导（第 3 轮） |
| — | query_history 检索与翻阅耦合；inspect_session 定位模糊 | 拆分 grep_history/read_history；inspect_session 移除（第 3 轮） |
| — | 描述冗长（read ~100 字、bash ~200 字、browser ~380 字）：token 负担 + 注意力稀释 | **全部 29 个描述按「口语化、有效指引、简单全面」重写**；参数描述同步精简（第 4 轮） |

### 5.2 遗留项处置（2026-08-20 第五轮，用户逐项裁决）

| # | 遗留项 | 处置 |
|---|--------|------|
| 1 | "行数/条数"参数命名不一（job `lines` vs 其他 `limit`） | ✅ job `lines` → `limit`（execute 层兼容旧名）；read 的 `limit` 语义是行数，保留 |
| 2 | str_replace_editor UI 标注"DSH 兼容编辑器" | ❌ 不做——确实可以当成四合一工具，无需标注 |
| 3 | "二选一必填"表达 | ✅ grep_history/read_history 补 `oneOf: [{required:[agent_id]}, {required:[group_id]}]`（体积小收益直接）；subagent/browser 的或关系定义 oneOf/anyOf 体积太大，维持运行时报错兜底 |
| 4 | update_agent_profile `fields.hooks` 无 properties | ✅ 补全七类钩子完整定义（runStart/runEnd/stepStart/stepEnd/toolExecutionStart/toolExecutionEnd/fallback，均 string[]） |
| 5 | 数值参数无 min/max 约束 | ✅ 补齐：read offset(≥1)/limit(1-5000)、bash timeout(1000-maxTimeout)、job limit(1-500)、read_logs limit(1-500)、read_history limit(1-100)/offset(≥0)、timer repeat_count(≥0)、subagent wait_time(0-600)、ask_questions timeout_ms(≥0)、browser steps repeat(1-20)/delay_ms(≥0)——LLM 在生成阶段即可见边界 |
| 6 | browser eval 无约束声明 | ❌ 不管——页面上下文受限，风险可控 |
| 7 | 默认值/上限硬编码 | ❌ 维持现状 |

遗留清零：5 项落地、2 项明确不做、维持现状 1 项（默认值硬编码）。
