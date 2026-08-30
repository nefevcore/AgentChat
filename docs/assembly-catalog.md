# 装配目录速查：插件 / 工具 / 钩子 + 钩子默认装配顺序

> 版本：v0.7.1（2026-08-20）。本文是**当前代码实际注册情况**的横切速查表：
> 插件行（组合层）、工具目录（ctx.tools）、钩子目录（ctx.hooks）、以及钩子的默认装配顺序。
> 单包详情见 [plugins/README.md](plugins/README.md)；插件模型见 [plugin-system.md](plugin-system.md)。

**事实来源（改代码时同步更新本文）**：

| 内容 | 单一事实源 |
|------|-----------|
| 插件行与装载组合 | `src/boot/boot/src/composition.base.yml` + `composition.web-app.yml` |
| 内置插件目录（UI 用 label/description） | `src/boot/boot/src/loader.ts` 的 `BUILTIN_PLUGIN_CATALOG` |
| 工具 name/label/requires/description | 各域包 `src/**/tools.ts` / `tool.ts`（`defineTool` 定义） |
| 内置钩子目录（UI 用 label/description） | `src/core/hooks/src/hooks/index.ts` 的 `BUILTIN_HOOK_CATALOG` |
| 钩子推荐顺序（UI 排序 + 出厂默认） | `src/core/hooks/src/hooks/index.ts` 的 `RECOMMENDED_HOOK_ORDER` |
| 钩子注册（kind/name/owner/automatic） | 各域包 `register.ts` 的 `ctx.hooks.register(...)` |
| 新建 Agent 出厂装配 | `src/host/server/src/api/agents.ts`（POST /）+ `src/svc/workspace/src/workspace.ts`（首次运行 admin） |
| 预设 Agent 装配 | `src/agent-presets/agent-presets/src/presets/*/config.json` |

---

## 1. 插件目录（composition.base.yml 装载行）

> 行序无激活语义（Loader 按 `inject` 服务依赖推导启动顺序）；分组即装配一览图。
> 上层（表面 bundle / cordis.patch.yml / 机器层 / --patch）可按行 id 覆盖 config（整行替换）、disable 或追加。

### 1.1 基建

| 行 id | 包 | 说明 |
|-------|----|------|
| logger | @agentchat/cordis-timer（vendor 生态）→ logger | 日志（timestamp: true） |
| durable-interaction | @agentchat/durable-interaction/src/plugin | 通用持久化交互（durable suspension：open/reply/close，JSONL 后端） |
| timer | @agentchat/cordis-timer（vendor） | vendor 定时器原语 + loader 内部 fiber 暴露 |
| hmr | @agentchat/cordis-hmr | 主动模块重载机器（L1.5，配合 reload_modules 工具） |
| http-host | @agentchat/server/src/http-plugin | L3 传输层注册口（宿主只挂中间件/WS/SPA，业务路由由各域行注册） |

### 1.2 能力服务行（ctx.* 提供者）

| 行 id | 包 | 提供 |
|-------|----|------|
| agent-loop | @agentchat/agent-loop/src/plugin | `ctx.agentLoop`（ReAct 引擎入口） |
| llm | @agentchat/llm/src/plugin | `ctx.llm`（LLM 适配器注册表） |
| llm-deepseek | @agentchat/llm-deepseek/src/plugin | deepseek 适配器（inject: llm） |
| llm-glm | @agentchat/llm-glm/src/plugin | glm 适配器（智谱 GLM-5.3，inject: llm） |
| llm-openai | @agentchat/llm-openai/src/plugin | openai + default 适配器（inject: llm） |
| tools | @agentchat/tools/src/plugin | `ctx.tools`（工具注册中心） |
| hooks | @agentchat/hooks/src/plugin | `ctx.hooks`（钩子注册中心 + 内联 log-tool 钩子） |
| jobs | @agentchat/jobs/src/plugin | `ctx.jobs`（通用后台任务注册表；bash/subagent 按 kind 登记，owner 分桶/上限/完成通知） |
| plugin-host | @agentchat/plugins/src/plugin | `ctx.pluginHost`（动态插件装载器） |
| market | @agentchat/plugins/src/market/market-plugin | `ctx.market`（市场发现/暂存/安装；构造零网络） |
| market-http | @agentchat/plugins/src/market/http-plugin | `/api/plugins/market/*`（inject: http+market） |

### 1.3 工具域行（inject: tools，每域一行）

| 行 id | 包 | 注册的工具 |
|-------|----|-----------|
| fs-tools | @agentchat/fs/src/plugin | read / write / edit |
| fs-search-tools | @agentchat/fs-search/src/plugin | glob / grep（DSH dsh-tool-fs-search 语义移植） |
| str-replace-editor-tools | @agentchat/str-replace-editor/src/plugin | str_replace_editor（DSH dsh-tool-str-replace-editor 语义移植） |
| shell-tools | @agentchat/shell/src/plugin | bash / job（跨平台 shell 探测 + 后台任务管理） |
| web-tools | @agentchat/web/src/plugin | web_search / browser |
| dev-tools | @agentchat/dev/src/plugin | read_logs / reload / reload_modules（dev） |
| dev-admin-tools | @agentchat/dev/src/plugin-admin | register_plugin / unregister_plugin（admin） |
| session-tools | @agentchat/session-tools/src/plugin | grep_history / read_history |
| restart | @agentchat/restart/src/plugin | system_restart（admin） |
| interaction | @agentchat/interaction/src/plugin | ask_questions（用户交互） |

### 1.4 扩展域行（inject: hooks/tools，钩子域各自成行）

| 行 id | 包 | 说明 |
|-------|----|------|
| agent-prompt | @agentchat/agent-prompt/src/plugin | build-system-prompt 钩子 |
| agent-persona | @agentchat/agent-persona/src/plugin | persona 人设注入钩子（自 agent-prompt 拆出） |
| agent-datetime | @agentchat/agent-datetime/src/plugin | datetime 日期注入钩子（runStart 清单钩子，按 Agent 显式启用；独立会话跳过保持最大 KV cache） |
| agent-skill | @agentchat/agent-skill/src/plugin | discovered_skills 技能注入钩子 |
| agent-session | @agentchat/agent-session/src/plugin | load-history / save-session 等会话钩子 |
| agent-memory | @agentchat/agent-memory/src/plugin | load-memory / update-memory 钩子 |
| agent-mcp | @agentchat/agent-mcp/src/plugin | open-mcp 钩子（MCP 工具发现） |
| security | @agentchat/security/src/plugin | security-check 钩子 + 输出脱敏 |
| agent-tools | @agentchat/agent-tools/src/plugin | 协作工具（send_agent / list_agents 等，inject: tools） |

### 1.5 预设 / 服务 / 装配 / 路由行

| 行 id | 包 | 说明 |
|-------|----|------|
| agent-presets | @agentchat/agent-presets/src/plugin | `ctx.agentPresets`（内置预设 Agent 注册中心，server-l4 物化进注册表） |
| timer-tools | @agentchat/timer/src/plugin | timer 工具 |
| subagent-tools | @agentchat/subagent/src/plugin | subagent 工具（子 Agent 委托） |
| math-tools | @agentchat/math/src/plugin | math 共享工具（vm 沙箱求值） |
| boot-core | @agentchat/boot/src/plugin | 核心装配（L2：boot 只做契约接线）→ `ctx.bootstrap` / `ctx.agents` |
| workspace-init | @agentchat/workspace/src/plugin | `ctx.workspace`（工作区初始化） |
| archive | @agentchat/archive/src/plugin | `ctx.archive`（先整理后归档编排） |
| timer-service | @agentchat/timer/src/service-plugin | `ctx.timerManager`（TimerManager 宿主） |
| subagent-service | @agentchat/subagent/src/service-plugin | `ctx.subagent`（SubAgentManager 宿主） |
| server-l4 | @agentchat/server/src/service-plugin | `ctx.l4`（L4 门面聚合；注册 singles.auto-title 钩子） |
| boot-finalize | @agentchat/boot/src/plugin-finalize | `ctx.webServerHost`（webuiPort: 3830） |
| http-routes | @agentchat/server/src/http-routes-plugin | /api：upload/config/browse/workspace/backup/version/usage/sessions |
| plugins-http | @agentchat/plugins/src/http-plugin | /api/plugins（inject pluginManager） |
| diagnostics | @agentchat/boot/src/plugin-diagnostics | 装配缺口诊断（删服务行 5s 后告警） |
| hello | @agentchat/hello | 链路验证插件（最小 cordis 示例） |

### 1.6 表面行（profile: web-app 叠加）

| 行 id | 包 | 说明 |
|-------|----|------|
| webui | @agentchat/webui/src/plugin | Web 表面：HTTP + WS + SPA 托管（webuiPort: 3830） |
| boot-finalize（覆盖） | — | enableWebUI: true（表面级决策） |

---

## 2. 工具目录（27 个，requires 标签门禁）

> 解析优先级：`presets`（owner 过滤）→ `requires`（能力标签 AND 门禁；标签不足永不可用）→ `tools.exclude` → `tools.include` → 默认（requires 非空的候选默认启用）。
> 能力标签：`base`（隐式） / `dev` / `admin` / `conductor`。

| 工具 | label | requires | owner 插件（preset id） | 描述（给 LLM 看，摘要） |
|------|-------|----------|------------------------|------------------------|
| read | 读取文件 | base | agentchat-fs-tools | 读取文件内容或列出目录；「行号:内容」格式（old_string 可直接复制），目录返回 JSON 列表 |
| write | 写入文件 | base | agentchat-fs-tools | 写入/覆盖文本文件（自动建父目录，受沙箱限制）；整体覆盖，改现有文件优先 edit |
| edit | 编辑文件 | base | agentchat-fs-tools | 修改现有文件：old_string→new_string 文本替换（三级模糊匹配 + 唯一性校验）；多处修改并行发多个 edit |
| glob | 文件匹配 | base | agentchat-fs-search-tools | 按路径模式查找文件（不用 shell find）；支持 ** / * / ? / {a,b} / [...]；只返回文件，按修改时间新→旧，最多 100 条 |
| grep | 内容搜索 | base | agentchat-fs-search-tools | 按正则搜索文件内容（不用 shell grep/rg）；按文件分组返回 `Line N:` 预览，最多内联 250 条 |
| str_replace_editor | 字符串替换编辑器 | base | agentchat-str-replace-editor-tools | 单工具编辑器四命令：view / create / str_replace（原文唯一匹配）/ insert（行号 1 基） |
| bash | 执行命令 | base | agentchat-shell-tools | 工作区内执行 shell（Windows: PowerShell 7→PowerShell→cmd）；Unix 命令自动翻译，超长输出中截，支持 timeout/background/stdin |
| job | 任务管理 | base | agentchat-shell-tools | 管理后台任务（bash background / subagent）：list（本 Agent 任务+状态）/ kill（按 job_id，仅已登记）/ logs（bash 日志尾、subagent 结果）；完成有平台通知 |
| web_search | 网络搜索 | base | agentchat-web-tools | 实时网络搜索（新闻/文档/事实核查等）；结构化结果 + 可选 AI 摘要；需管理员配置 Provider/Key |
| browser | 浏览器 | base | agentchat-web-tools | 操作真实 Chromium：open/click/type/press/content/screenshot/html/eval/close；支持 steps 批量 + repeat/delay_ms |
| read_logs | 读取日志 | dev | agentchat-dev-tools | 从内存环形缓冲读后端日志（最近 2000 条），可按 level/keyword/limit 过滤 |
| reload | 热加载 | dev | agentchat-dev-tools | 热重载配置：scope=self/global/all（仅配置，不重载源码） |
| reload_modules | 热重载模块 | dev | agentchat-dev-tools | 宣告源码修改完成并热重载模块（扫描发现 + files 补充）；多文件修改是一个事务；失败自动回滚 |
| register_plugin | 注册插件 | admin | agentchat-plugin-tools | 会话级动态加载工作区开发插件（自动 watch 热重载；process/shell 权限需显式 grants） |
| unregister_plugin | 卸载插件 | admin | agentchat-plugin-tools | 卸载会话级插件并从 presets 移除后热重载 |
| grep_history | 检索聊天历史 | base | agentchat-session-tools | 按关键词检索自身与任何 Agent 的 1:1 对话或任意群聊历史（全量命中） |
| read_history | 读取聊天历史 | base | agentchat-session-tools | 翻阅聊天历史（1:1/群聊），limit/offset 分页，默认最近 20 条 |
| system_restart | 重启后端 | admin | agentchat-restart-tools | 请求进程级重启（退出码 42 + supervisor 拉起）；框架/内核/.env/依赖变更用；普通源码改动用 reload_modules |
| ask_questions | 询问用户 | base | agentchat-interaction-tools | 向用户提选择题组（最多 5 题），暂停推理等回答（默认永久等待、跨重启恢复；显式 timeout_ms 才有时限） |
| send_agent | 发送给 Agent | base | agentchat-agent-tools | 向另一 Agent 发消息（默认异步 fire-and-forget；wait=true 阻塞等回复） |
| send_group | 发送到群组 | base | agentchat-agent-tools | 向群组发消息，其他参与者自主决定是否回应；返回触发回应数 |
| list_agents | Agent 清单 | base | agentchat-agent-tools | 列出全部 Agent 的 ID/名称/类型（配合 send_agent） |
| list_groups | 群组清单 | base | agentchat-agent-tools | 列出当前 Agent 所在群组及参与者 |
| list_tools | 工具清单 | base | agentchat-agent-tools | 列出当前 Agent 实际启用的工具及简短说明 |
| read_agent_info | 读取 Agent 信息 | base | agentchat-agent-tools | 读指定 Agent 公开信息（名称/类型/标签/LLM）；查他人附带回对自己的印象（记忆） |
| update_agent_profile | 更新个人档案 | base | agentchat-agent-tools | 更新 name/description/persona/avatar/tags/presets/tools/hooks；admin 可更新他人 |
| timer | 定时任务 | base | agentchat-timer-tools | 定时任务管理：set（delay/random/time/workday/holiday 五种调度）/list/disable |
| subagent | 子 Agent 调度 | conductor | agentchat-subagent-tools | 独立上下文并行执行单元：spawn/list/await/kill |
| math | 数学 | base | agentchat-math | 数学表达式沙箱求值（+ - * / % ** 与常用函数/常量） |

> code_search 已于 v0.7.1 移除（2026-08-20）：与 grep 重叠，不再双维护；dev 场景请用 grep（path 定位到项目根）。

> MCP 工具（agent-mcp.open-mcp 钩子发现）在运行时按 `mcp服务器名.工具名` 动态注入，不在静态目录内。

---

## 3. 钩子目录（七类，20 个内置注册）

> 七类钩子与 L1 CurrentContext 一一对齐：`runStart` ↔ chat.start、`runEnd` ↔ chat.end、`stepStart`/`stepEnd` ↔ chat.step.*、`toolExecutionStart`/`toolExecutionEnd` ↔ chat.tool_execution.*、`fallback`（失败兜底）。
> **automatic** = 基础设施钩子：不受 config.hooks 清单控制，自动进入每个 run（仍受 owner preset 过滤）。
> 推荐顺序统一见 §4.1 的 `RECOMMENDED_HOOK_ORDER`（UI「按推荐顺序排序」按钮与出厂清单共用）。

### runStart（整次执行开始）

| 注册名 | label | 描述 | owner | automatic |
|--------|-------|------|-------|-----------|
| agent-mcp.open-mcp | MCP 工具发现 | 启动 MCP 并注册工具（配置 ns: agent.mcp） | agentchat-agent-mcp | |
| agent-skill.discovered_skills | 技能注入 | 发现并注入 Agent 技能清单 | agentchat-agent-skill | |
| agent-prompt.build-system-prompt | 系统提示装配 | 构建系统提示（角色/标签/指引/存储/对话信息） | agentchat-agent-prompt | |
| agent-persona.persona | 人设注入 | AGENT.md / config.persona 角色块前置注入 system prompt；SYSTEM.md 存在时跳过；子 Agent 不装配 | agentchat-agent-persona | |
| agent-datetime.datetime | 日期注入 | system prompt 尾部追加 [当前时间] 日期行（配置 ns: agent.datetime，enabled 开关） | agentchat-agent-datetime | |
| agent-memory.load-memory | 记忆加载 | 加载长期记忆（配置 ns: agent.memory） | agentchat-agent-memory | |
| agent-session.load-history | 历史加载 | 加载对话历史（配置 ns: agent.session） | agentchat-agent-session | |
| agent-session.recover-history | 历史恢复调和 | 恢复 ask_questions 等中断交互 | agentchat-agent-session | ✔ |
| agent-session.group-contract | 群聊行为契约 | 群聊触发时注入行为契约（send_group 回复/沉默权/不刷屏） | agentchat-agent-session | ✔ |

### toolExecutionStart（工具执行前）

| 注册名 | label | 描述 | owner | automatic |
|--------|-------|------|-------|-----------|
| security.security-check | 安全检查 | 拦截敏感工具（档案权限/危险路径） | agentchat-security | |
| agent-session.tool-persist | 工具前持久化 | 工具副作用执行前把 assistant(tool_calls) 落盘；失败阻止工具执行 | agentchat-agent-session | ✔ |

### toolExecutionEnd（工具执行后）

| 注册名 | label | 描述 | owner | automatic |
|--------|-------|------|-------|-----------|
| security.redact-output | 输出脱敏 | 工具结果写入前脱敏密钥/敏感值 | agentchat-security | |
| hooks.log-tool | 工具日志 | 工具执行轻量日志 | agentchat-hooks | |

### stepEnd（步骤结束）

| 注册名 | label | 描述 | owner | automatic |
|--------|-------|------|-------|-----------|
| agent-session.step-persist | 步骤持久化 | 每步结束后增量落盘本步消息 | agentchat-agent-session | ✔ |
| singles.auto-title | 会话标题生成 | 独立会话首个推理步结束时 LLM 自动生成标题；失败回落首条消息截断 | （无主，server-l4 行注册） | ✔ |

### runEnd（整次执行结束）

| 注册名 | label | 描述 | owner | automatic |
|--------|-------|------|-------|-----------|
| agent-session.save-session | 会话持久化 | run 结束最终 flush（step 级增量已持续落盘） | agentchat-agent-session | ✔ |
| agent-memory.update-memory | 记忆更新 | 会话级记忆审查标记 | agentchat-agent-memory | |
| agent-session.idle-reset | 空闲计时重置 | 重置空闲归档计时器 | agentchat-agent-session | |
| agent-session.archive-session | 超长归档 | 上下文超长归档（配置 ns: agent.session） | agentchat-agent-session | |
| agent-session.log-usage | Token 用量记录 | 记录 Token 用量 | agentchat-agent-session | |

### stepStart / fallback

当前**无内置注册**（机制保留：stepStart 供步骤级观察，fallback 供失败路径兜底；第三方插件可注册）。

---

## 4. 钩子的默认装配顺序

### 4.1 装配规则与推荐顺序表

**运行时规则**（`HooksService.collect`，单一 config 来源）：

1. **顺序表 = 启用清单**：`config.hooks.{kind}` 数组顺序即执行顺序；不在数组里 = 停用（没有第二个 disabled 数组）。旧 `disabledHooks` 读入时剔除、写盘时移除。
2. **旧名归一化**：清单中的 `builtin.*` 别名（如 `builtin.save-session`）经 `normalizeHookName` 映射到正典名。
3. **owner preset 过滤**：钩子 owner 不在 `config.presets` 中 → 跳过（presets 缺省 = 旧契约兼容不过滤）。
4. **未注册跳过**：清单里尚未注册的名字跳过（允许先配置、后安装插件）。
5. **automatic 追加**：基础设施钩子不受清单控制，**追加在显式钩子之后**，按注册顺序排列；同名已在清单中启用时去重（此时按清单位置执行）。

**推荐顺序表**（`RECOMMENDED_HOOK_ORDER`，`src/core/hooks/src/hooks/index.ts`）——单一事实源，两处消费：

- 后端 `getCatalog` 的 `HookInfo.order`（表内位置；未收录的第三方钩子按注册序排在收录项之后）→ 前端「按推荐顺序排序」按钮、未启用区排序、开启钩子时的锚点插入；
- 新建 Agent 的出厂 `config.hooks` 清单（§4.2）。

```ts
runStart:           [open-mcp, discovered_skills, persona, build-system-prompt,
                      datetime, load-memory, load-history, recover-historyᵃ, group-contractᵃ]
toolExecutionStart: [security-check, tool-persistᵃ]
toolExecutionEnd:   [redact-output, log-tool]
stepStart:          []
stepEnd:            [step-persistᵃ, auto-titleᵃ]
runEnd:             [save-session, update-memory, idle-reset, archive-session, log-usage]
fallback:           []
```

（ᵃ = automatic；表中 name 均带 `域.` 前缀，此处省略。）

### 4.2 新建 Agent 的出厂清单（WebUI 创建 / 首次运行 admin 同基线）

`POST /api/agents` 与首次运行 `ensureDefaultAdmin` 写入的 `config.hooks`（= 推荐顺序表的显式子集；automatic 不写，交给 collect 追加）：

```jsonc
{
  "runStart":             ["agent-mcp.open-mcp", "agent-skill.discovered_skills",
                            "agent-persona.persona", "agent-prompt.build-system-prompt",
                            "agent-datetime.datetime", "agent-memory.load-memory",
                            "agent-session.load-history"],
  "toolExecutionStart":   ["security.security-check"],
  "toolExecutionEnd":     ["security.redact-output", "hooks.log-tool"],
  "runEnd":               ["agent-session.save-session", "agent-memory.update-memory",
                            "agent-session.idle-reset", "agent-session.archive-session",
                            "agent-session.log-usage"]
  // stepStart / stepEnd / fallback 不写（交给 automatic）
}
```

配套 `presets` 相应启用 `agentchat-agent-persona` 与 `agentchat-agent-datetime`（否则 owner 过滤会裁掉这两个钩子）。

### 4.3 出厂态的有效装配结果（显式清单 + automatic 追加）

| kind | 有效执行顺序（→ 即执行方向） |
|------|------------------------------|
| runStart | agent-mcp.open-mcp → agent-skill.discovered_skills → agent-persona.persona → agent-prompt.build-system-prompt → agent-datetime.datetime → agent-memory.load-memory → agent-session.load-history → **agent-session.recover-history**ᵃ → **agent-session.group-contract**ᵃ |
| toolExecutionStart | security.security-check → **agent-session.tool-persist**ᵃ |
| toolExecutionEnd | security.redact-output → hooks.log-tool |
| stepEnd | **agent-session.step-persist**ᵃ → **singles.auto-title**ᵃ（纯 automatic） |
| runEnd | agent-session.save-session → agent-memory.update-memory → agent-session.idle-reset → agent-session.archive-session → agent-session.log-usage |
| stepStart / fallback | （空） |

ᵃ = automatic 追加（不在清单也生效；runEnd 的 save-session 为 automatic 但已显式列出，按清单首位执行，去重不重复追加）。

> 存量 Agent 的 config.json 不会被自动迁移——新默认只作用于新建 Agent；旧 Agent 可在 WebUI 钩子面板点「按推荐顺序排序」对齐（persona/datetime 需先启用对应插件行）。

### 4.4 预设 Agent 的装配清单

**standard（标准模式）**——presets 含 agent-persona，不含 mcp/memory/skill：

```jsonc
{
  "runStart":           ["agent-persona.persona", "agent-prompt.build-system-prompt", "agent-session.load-history"],
  "runEnd":             ["agent-session.save-session", "agent-session.log-usage"],
  "toolExecutionStart": ["security.security-check"],
  "toolExecutionEnd":   ["hooks.log-tool"]
}
```

**dsh-minimal（极简模式，DSH-Like）**——仅 str_replace_editor/bash 工具（exclude read/write/edit），钩子与 standard 同构（无 build-system-prompt 之外的注入，无 persona）。

### 4.5 run 内七类钩子的执行时序（L1 loop）

```
chat.start
→ runStartHook（顺序执行，单钩子失败仅记日志不中断）
→ 每个 ReAct 步：
    stepStartHook → LLM 流式推理
    → 每个工具调用：toolExecutionStartHook（可拦截/阻止执行）
                   → 工具执行
                   → toolExecutionEndHook（可观察/替换结果内容）
    → stepEndHook
→ runEndHook（观察整次结果，含致命兜底路径）
→ chat.end
（致命错误路径：fallbackHook 兜底 → 产出 error 消息；正常中断不触发 fallback）
```

---

## 5. 已知缺口（整理时发现，待修）

1. ~~`BUILTIN_HOOK_CATALOG` 缺 persona/datetime 两条~~ —— 已补（2026-08-20，含 datetime 的 configNs/fields 与 agent.datetime schema）。
2. ~~`BUILTIN_PLUGIN_CATALOG` 缺 persona/datetime 两个 preset 行~~ —— 已补（2026-08-20）。
3. [plugins/README.md](plugins/README.md) 的工具/钩子速查停留在 v0.6.3：缺 glob/grep/str_replace_editor、persona/datetime/group-contract/redact-output/auto-title 等条目。
