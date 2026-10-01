# Harness 桥接（方案 B）：本地 CLI harness 借力通道

> 状态：**方案稿（用户立项，待实施）**。用户场景：本机装有 Claude Code /
> Codex / DeepSeek Harness 等 harness 应用，希望在 AgentChat 会话中直接
> 借力这些应用的能力。经三轮方案对比（§二），裁决先行落地**方案 B
> （harness 工具行 + 委托子代理）**；provider 形态（方案 A）推后到
> `archive/llm-protocol-extensibility.md` 备忘实施后再评估。本文档给出 B 的
> 目标形态、数据形状、安全护栏与裁决点。
>
> 总立场：**零框架改动，纯增量行**——不新增事件、不动 core 四层、不新增
> 服务键；能力长在既有插槽上（`ctx.tools.register` 工具四轴 + 权限轴 +
> tags 门禁 + 预设 Agent 行 + ac-subagent/collab 委托先例）。

---

## 一、目标与范围

### 1.1 目标

1. **run_harness 工具**：Agent（含子 Agent）在会话中调用 `run_harness`，
   把一个完整任务委托给本地 CLI harness（首期 Claude Code、Codex）执行——
   harness 全权跑自己的 agent 循环（工具/文件/命令），终稿作为工具结果
   回流；过程事件（工具执行/文件变更/推理摘要）经 `call.onProgress` 直播
   进工具卡。
2. **委托子代理预设**：注册名为 `harness` 的预设 Agent——协作语境里
   `@harness <任务>` 或经 ac-collab-tools `spawn({ name: 'harness', task })`
   一句话委托；其他 Agent 也可通过 tags 自取 `run_harness` 工具。
3. **订阅额度复用**：harness 走自己的登录凭证（Claude 订阅 / ChatGPT
   计划），AgentChat 侧零 API key 管理。
4. **权限/审计全保留**：调用过 `needPermission` 权限轴（有人桶询问提权/
   本轮授权、无人桶拒绝），spawn 命令行与事件流摘要进 host 日志，工具
   结果过 transform-result 脱敏链——与任何出厂工具同待遇。

### 1.2 非目标（显式不做，首期）

- **方案 A（harness provider 入池）**：把 harness 伪装成 LLM 模型端点——
  依赖 `archive/llm-protocol-extensibility.md` 的 PROTOCOLS 注册表先落地，且语义
  错配（双 agent 循环嵌套、黑盒长步、usage/耗时失真）需要独立产品裁决，
  推后到该备忘实施后再评估；
- **方案 C（工具回接）**：把 harness 的工具请求转成 AgentChat 工具调用
  回填（claude canUseTool / codex approvals）——依赖各家实验性交互协议，
  收益/复杂度比最差，显式不做（不设观察条件）；
- **DSH 桥接**：DSH 无公开 exec CLI（web 服务形态，`npx @deepseek-ai/dsh
  web` → 127.0.0.1:3080），桥接需双侧开发（AgentChat 侧 provider + DSH 侧
  暴露插件）；且与 AgentChat 同源定位重叠，边际价值最低——观察（见 D9）；
- harness 侧配置管理（模型切换/登录/mcp 配置）——用户自己在 harness 应用
  里管，本域零越界；
- 流式正文直播到会话消息面（首期只进工具卡过程区；终稿即工具结果文本）。

---

## 二、词界与方案定位

**一词两义辨析**：本文档的 "harness" = 用户本机安装的**外部 agent 运行时
应用**（Claude Code、Codex CLI、DeepSeek Harness）。`ac-bench/README.md`
的 "harness" = 评测语境的**模型+编排组合体**概念（跑批差值衡量工程水位）——
两义上下文可分，词汇空间不交集（本域工具名 `run_harness` / 标签 `harness` /
行包 `ac-harness-tools`；bench 域工具只在评测链路内合成，不注册工具面）。

| 方案 | 形态 | 架构契合 | 工程量 | 语义损失 | 裁决 |
|---|---|---|---|---|---|
| A. harness provider | 池条目，黑盒长步伪装模型 | 中（缝在但嵌套循环） | 中 | 双循环/审计盲区/状态分裂 | 推后（备忘先行） |
| **B. harness 工具+子代理** | `run_harness` 工具 + 委托预设 | **高**（天然委托语义） | **低** | 无内部过程细节（同 A） | **本文档，先行** |
| C. 工具回接 | harness 工具请求→AgentChat 工具 | 高但深 | 高 | 最小 | 不做 |

B 的架构契合论据：harness 调用本质是**一次可审计的工具执行**而非一次模型
推理——工具行的权限轴、tags 门禁、journal、脱敏链全部天然适用；而 provider
缝（`LlmProvider` 契约）假设"无状态单步：messages 进、分片出"，嵌套一个
自带循环的 agent 运行时是对契约的错用。生态先例：DSH 的 `dsh-sub-cli` 插件
正是同形态（把 Codex / Claude Code 作为 DSH 下的委托 CLI 工具管理，注册持续
会话与无头派发工具）；`dsh-llm-agent-virtualization` 则是方案 A/C 杂交形态的
参照（标准 LLM 接缝 + 工具回接），复杂度高——侧证 B 的取舍。

---

## 三、现状对齐（落点插槽盘点）

| 插槽 | 现状 | 本方案怎么用 |
|---|---|---|
| `ctx.tools.register` | 工具四轴：requiredTags / needPermission / injection / requiresInteraction；`call.onProgress` 进度上报；ToolResult 抛错自动收敛 | `run_harness`：requiredTags `['harness']` + needPermission true；过程事件 onProgress 直播 |
| 权限轴（ac-security） | needPermission × 档位：base+有人桶 durableInteraction 询问（仅本次/本轮 scope=run）；无人桶拒绝；`files/<id>` 专属空间写免询问（D1 先例） | harness 调用走 base 档询问提权；cwd 缺省 Agent 专属空间则免询问（同口径） |
| tags 门禁 | tags 单源裁决能力面；词表登记制（tag-registry 包；新标签查 RESERVED 防漂移） | 新标签 `harness`——实施时查 RESERVED 词表并进 tag-registry 登记（D10） |
| 预设 Agent 行 | `ctx.agents.register({ id, model, system, tools, tags, settings })`；tags = 钥匙圈、点名不解锁 | `harness` 委托预设走此形态——不新造子代理机制 |
| ac-subagent / ac-collab-tools | 子 Agent 派生注册 + tierOf 继承；`@名称` 引用 + spawn({name, task}) 委托 | harness 子代理天然可被 @ / spawn；父 Agent 也可经 tags 直取工具 |
| journal / subcalls | run_code 子调用平铺先例（subcall 补行入档 + UI 平铺） | 工具结果走既有步记录通道零改动；事件流摘要进 host 日志 |
| settings 三层 | schemastery 校验 + `extension` 自述 + `settings.<域>.<键>` + config/changed 热更；per-Agent 经 `ctx.agents.settingsOf` | `settings.harness` 域（enabled / maxConcurrent / gateways）；行声明 respectsEnabled 自查 |

---

## 四、总体形态（两包分工）

```
ac-harness-core/     纯库（零 cordis）：HarnessGateway 接口 + 事件归一
                    + claude-code / codex 两个 exec 适配器 + probe 探测
ac-harness-tools/    行包：run_harness 工具 + harness 委托子代理预设 + settings 面
```

- **纯库/行分工**（设计决策 #4 惯例）：spawn/解析/归一算法全部住 core，
  可独立单测（JSONL fixture 矩阵，零真子进程）；行只做注册胶水与权限/
  并发/生命周期编排。
- **挂载**：`src/cordis.yml` 一行（id: `harness-tools`）+ `ac-app` TREE 同步；
  行包声明 `"agentchat": { "plugin": true }`；core 纯库不加（fail-closed）。
- **无新服务键 / 无新事件 / 无 core 改动**：纯工具行 + 预设行形态，零契约
  面变更（形态学对齐 ac-fs-tools）。

---

## 五、核心设计

### 5.1 网关接口与适配器（ac-harness-core）

```ts
/** 网关 = 一个本地 harness 的程序化委托面（纯库接口，行侧组合调度） */
export interface HarnessGateway {
  readonly name: string;                  // 'claude-code' | 'codex'
  probe(): Promise<{ ok: boolean; version?: string; hint?: string }>;
  run(req: HarnessRunRequest, hooks: HarnessRunHooks): Promise<HarnessRunResult>;
}

export interface HarnessRunRequest {
  prompt: string;                         // 完整委托任务书（stdin 传入）
  cwd: string;                            // 工作目录（绝对路径，行侧解析）
  sandbox?: 'plan' | 'workspace-write';   // 两档；无 full 档（§5.5）
  model?: string;                         // harness 侧模型（可选）
  resumeKey?: string;                     // 二期：claude session_id / codex thread_id
  maxMs?: number;                         // 看门狗超时
  signal?: AbortSignal;                   // 中止（steer 停止/会话中止传播）
}

export interface HarnessRunHooks {
  onEvent?(e: HarnessEvent): void;        // 过程事件直播（onProgress 源）
}

export interface HarnessRunResult {
  ok: boolean;
  text: string;                           // 终稿全文
  finish: 'stop' | 'error' | 'timeout' | 'aborted';
  runKey?: string;                        // 续接凭据（一期透传不消费）
  usage?: { prompt?: number; completion?: number; total?: number;
            costUsd?: number; turns?: number; elapsedMs?: number };
  stats?: { unknownEvents: number; stderrTail?: string };
}
```

两个首期适配器（均为**官方文档化的一次性委托 exec 面**，不碰实验性协议）：

| | claude-code | codex |
|---|---|---|
| 命令 | `claude -p --output-format stream-json --verbose` | `codex exec --json -C <cwd>` |
| prompt 传入 | **stdin**（防 Windows 32k 命令行长度限制） | stdin（同） |
| 沙箱档 | `--permission-mode plan`（只读）/ `acceptEdits`（写工作区） | `--sandbox read-only` / `workspace-write`（保持默认禁网） |
| 模型选择 | `--model <m>`（可选） | `-m <m>`（可选） |
| 事件流（JSONL） | system(init: session_id/model) → assistant(text 块, usage) → result(终稿, cost, duration_ms, num_turns) | thread.started(thread_id) → item.completed(agent_message 等) → turn.completed(usage) / turn.failed |
| runKey | session_id | thread_id |

- 适配器只依赖 exec JSONL 面——Agent SDK / App Server / MCP 等交互式实验
  协议零依赖（版本漂移面最小化，见 D7）；claude 的 thinking 块首期不拆
  （stream-json 暴露不稳定，进 notice 摘要）。
- `probe()`：`<command> --version` 轻探测（0.5s 超时）；未装/不在 PATH 如实
  报错（fail-loud，错误文案带安装提示）。探测时机 = 首次调用（非 boot 期，
  未装不影响宿主启动——D8）。

### 5.2 事件归一（公共词汇）

```ts
/** 归一事件流（两家 JSONL 的公共形状；工具卡直播与结果 notices 共用） */
export type HarnessEvent =
  | { kind: 'started'; runKey?: string; model?: string }
  | { kind: 'delta'; text: string }             // 正文增量（claude assistant text / codex agent_message）
  | { kind: 'reasoning'; text: string }         // codex reasoning；claude 思考进 notice
  | { kind: 'notice'; label: string; detail?: string }  // 工具执行/文件变更等过程事件（label 短词 + detail 截断）
  | { kind: 'done'; finish: 'stop' | 'error'; summary: string };
```

归一规则：claude assistant text 块 / codex `item.completed agent_message` →
delta；工具执行与文件变更（codex `command_execution` / `file_change`、claude
tool_use 块）→ notice；终态事件 → done（终稿 + usage 归一：costUsd/turns/
elapsedMs 如实透传，token 两家口径差异保留 optional）。损坏行/未知事件类型
→ 丢弃 + 计数进 stats.unknownEvents（流不中断，前向兼容）。

### 5.3 run_harness 工具契约

| 参数 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| harness | 'claude-code' \| 'codex' | 必填 | 目标网关（settings.gateways 白名单交集） |
| task | string | 必填 | 完整委托任务书（原样进 prompt——续接前无上下文可依，task 是唯一信息载体） |
| cwd | string | Agent 专属空间 `files/<agentId>/harness/` | 工作目录（workspace 相对解析；外部路径触发权限轴复检） |
| sandbox | 'plan' \| 'workspace-write' | 'workspace-write' | 沙箱档（无 full 档——§5.5） |
| model | string | 网关缺省 | harness 侧模型（可选） |
| timeout_ms | number | settings.defaultTimeoutMs（缺省 600000） | 看门狗（上限 settings 可调） |

返回：`{ ok, output: { ok, text, finish, usage?, runKey?, notices } }`——
text = 终稿全文；notices = 过程事件摘要（有界，≤20 条 + 截断标记）。失败
形态（未装/超时/中止/非零退出）全部如实收敛为工具结果（finish 区分，模型可
读可重试决策）；仅行内部 bug 抛错走 ToolResult 自动收敛。

进度：notice / delta 摘要经 `call.onProgress` 直播进工具卡过程区（对齐
run_code trace 时间线形态）。

### 5.4 委托子代理预设（ac-harness-tools 同包）

- `ctx.agents.register({ id: 'harness', label: 'harness 委托', tools: [],
  tags: ['harness'], system: <转述协议>, settings: { harness: { enabled: true } }, ... })`
  ——预设行形态（对齐 ac-agent-presets-builtin 先例）。
- 转述协议（system prompt 固定）：「收到任务 → 原样作为 task 调 run_harness →
  终稿原样回复；不自行扩写」。模型配便宜款（用户可改）——多一次转述调用
  的 token 成本换零新机制（直通形态见 D2）。
- 其他 Agent 取用：tags 加 `harness` 即可见 run_harness（点名不解锁、
  tags 即钥匙圈惯例）。

### 5.5 权限与安全护栏

1. **needPermission = true**：每次调用过权限轴——base+有人桶询问（仅本次 /
   本轮 scope=run 两档）；无人桶（机制唤醒/无人值守子代理）拒绝并说明。
2. **沙箱两档收死**：'plan'（只读分析）/ 'workspace-write'（写工作区，codex
   保持默认禁网）；**不暴露 full/bypass 档**——harness 内部工具执行是
   AgentChat 权限模型外的黑盒，只放受控档；需要更高权限时用户直接用 harness
   应用本身（信任边界自划）。
3. **cwd 限定**：缺省 = Agent 专属空间子目录（写免询问先例口径）；显式 cwd
   指到外部 → 权限轴按写路径复检同款口径；accessDenyPaths 持久化域树恒禁。
4. **审计**：spawn 命令行 + 事件流摘要进 host 日志；工具结果过
   transform-result 脱敏链（harness 终稿 = 外部内容，与 web_search 结果
   同级注入面）。
5. **prompt 注入面**：harness 终稿文本回 Agent 上下文可能携带指令注入——与
   一切外部内容同级，靠既有唆使防御注入 + 用户审视兜底，不新增机制。

### 5.6 生命周期与并发

- **spawn**：`node:child_process.spawn`（shell:false；command 经 settings
  解析，Windows .cmd shim 的 PATH 解析细节实施时定——倾向显式全路径）；
  prompt 经 stdin 写入后关闭。
- **中止**：调用方 signal（steer 停止/会话中止）→ kill 子进程（Windows
  `taskkill /T /PID` 递斩子树防孙进程残留；posix 进程组 kill），finish=
  'aborted' 如实收敛。
- **看门狗**：timeout_ms 到点 kill，finish='timeout'。
- **并发纪律**：**agent 维互斥**（同 Agent 同时仅一个 harness run——内存表
  agent+conversation 记载，对齐 run 级授权表形态；占线即工具结果报忙）；
  全局上限 maxConcurrent（缺省 2，超出报忙——不静默排队，模型自行决定
  等待策略）。
- **行卸载**：在飞 run kill + 注册面 cordis 自动回收（kill 编排是子进程
  副作用清理，不违零 dispose 纪律）。

---

## 六、配置形状

```jsonc
// settings.harness（全局默认层；per-Agent 差异层同键收窄）
{
  "enabled": true,
  "maxConcurrent": 2,
  "defaultTimeoutMs": 600000,
  "gateways": {
    "claude-code": { "command": "claude", "args": [], "enabled": true },
    "codex": { "command": "codex", "args": [], "enabled": true }
  }
}
```

per-Agent 层：`settings.harness = { enabled, gateways: ['claude-code'] }`
（enabled 自查 + respectsEnabled 声明——agentGate 停用口径；gateways 白名单
收窄该 Agent 可用网关）。

---

## 七、分期与优先级

| 期 | 内容 | 依赖 |
|---|---|---|
| P1 | ac-harness-core（两适配器 + 事件归一 + probe）+ ac-harness-tools（工具 + 子代理 + 权限/并发/生命周期 + settings 面） | 无 |
| P2 | 会话续接：runKey 持久化（Agent 专属空间映射表 conversationId → session/thread id）+ resume 参数 | P1 |
| P3（观察） | DSH web 桥（需双侧开发）；方案 A provider 形态（PROTOCOLS 注册表实施后） | 外部条件 |

---

## 八、裁决点

| # | 决策 | 裁决/倾向 |
|---|---|---|
| D1 | 工具与子代理关系 | 同包两件：子代理只是便利预设（转述层），非必需机制——工具独立成立 |
| D2 | 子代理直通形态（零转述模型） | 一期转述层（便宜模型 + 固定协议）；直通需 loop 外执行路径（新机制），观察使用量再裁 |
| D3 | 会话续接策略 | 一期 run 级（每次全量任务书，runKey 只透传）；会话级映射二期 |
| D4 | 并发纪律 | agent 维互斥 + 全局上限；占线报忙不排队 |
| D5 | 中断/超时语义 | signal → kill 子树；看门狗 maxMs；finish 四态如实收敛 |
| D6 | 是否占 jobs 后台面 | 不占——工具执行天然同步（loop 步内等待），时长由 timeout 管 |
| D7 | 版本漂移防线 | 只依赖文档化 exec JSONL；核心字段缺失 fail-loud；未知事件行丢弃 + 计数（前向兼容） |
| D8 | 预装探测时机 | 首次调用 probe（非 boot 期——未装不影响宿主启动） |
| D9 | DSH 桥接 | 显式不做（web 服务无 exec 面、双侧开发、定位重叠）；出现公开 CLI 桥接面再评估 |
| D10 | 新标签登记 | `harness` 进 tag-registry（实施时查 RESERVED 词表防撞） |

---

## 九、风险与边界

1. **外部接口漂移**：claude/codex CLI 快速演进（flag 更名/事件形状变化）——
   依赖面收窄到文档化 exec 面 + 未知事件容错（D7）；适配器逐家小步跟随。
2. **黑盒执行**：harness 内部行为不可审计到工具级——以沙箱档 + cwd 限定 +
   过程 notice 直播缓解；深度审计非本方案目标（那是方案 C 的领地）。
3. **资源占用**：harness run 是真实子进程（node CLI 冷启动 + 模型调用分钟级）——
   并发纪律 + 看门狗防堆积；长任务建议显式放宽 timeout_ms。
4. **Windows 细节**：stdin 编码（UTF-8 无 BOM）、taskkill 递斩、PATH 解析
   （pnpm/npm global shim .cmd）——实施时逐项过，倾向 settings 显式全路径。
5. **成本重复**：转述层多一次模型调用（D2）+ harness 侧自身计费——委托
   任务书要求自足完整（task 是唯一信息载体）。

---

## 十、测试计划

- **core 单测**（JSONL fixture 矩阵，零 spawn）：claude/codex 事件样本 → 归一
  断言（delta/notice/done 映射、损坏行容错、usage 归一、session/thread_id
  提取）；probe mock；stdin 组装。
- **行测试**（mock gateway 注入，boot 脚手架同 ac-llm/tests 姿势）：工具
  注册四轴（requiredTags 门禁 / needPermission 生效）；权限轴路径（有人桶
  询问 / 无人桶拒绝 / 专属空间免询问）；并发互斥与占线报忙；超时 kill /
  中止传播（signal → kill 调用断言）；agentGate 停用；dispose 回收（在飞
  run kill）。
- **集成档**（`*.integration.test.ts`，env 开关 `AGENTCHAT_HARNESS_E2E=1`
  且本机装了对应 CLI 才跑）：真 spawn 一轮只读最小任务（plan 档），断言终稿
  与事件流完整性。

---

## 十一、影响面清单（实施时照此展开）

```
src/ac-harness-core/            新纯库（gateway.ts + adapters/claude-code.ts +
                                adapters/codex.ts + events.ts + tests/）
src/ac-harness-tools/           新行包（tool.ts + agent.ts + index.ts + tests/）
src/cordis.yml                  +1 行（id: harness-tools）
src/ac-app/src/index.ts         TREE +1 行
src/README.md                   布局 + 工具行清单；设计档案索引加本文档
tag-registry                    'harness' 标签登记（查 RESERVED 后）
既有域（core 四层/security/subagent/collab）   零改动
```
