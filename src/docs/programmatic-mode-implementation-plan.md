# 程序化模式（run_code / PTC）实施计划

> 2026-09-17 制定。依据：`programmatic-mode-handoff.md`（交接单）+ `coding-mode-preset-research.md` v5.2（主报告）。
> 范围 = P0 三件套 + 随行：⑥ run_code 工具行 + SDK 投影纯库、⑦ 预设数据行 `__programmatic__`、code-exec 标签预注册 + 运行期集成测试。
> 本计划是一次完整现状勘探的产物——所有锚点（函数名/行为/行号）都经源码核对，非照抄报告。新增发现已并入相应步骤。

## 零、裁决（交接单 §一 的四开放问题 + 本轮新增两项）

| # | 问题 | 裁决 | 理由 |
|---|---|---|---|
| 1 | run_code 结果入会话步记录吗 | **入摘要 + 程序体哈希，不入全程序体** | 报告 §八建议采纳。大返回值经 ac-session 回放长期占上下文，把省下的 token 吃回去。步记录 `output = { summary, programHash, counts… }`；程序体全文入 host 日志（诊断去处），不进会话流 |
| 2 | code-exec 与 shell 的信任关系 | **等同（DSH 口径）**，但 run_code 不挂 `needPermission` | 程序内子调用逐个走全安全面（见 §四.3），档位/审批按子工具逐次生效——粗信任由子调用细信任实现，run_code 自身无需再设门。挂 needPermission 只会让 base 档 Agent 的 run_code 连只读编排都被拦，与「以代码编排成批**读**操作」的低门槛起点冲突 |
| 3 | PTC vs subagent 分工 | **写进指引**：确定性编排 → run_code；探索性研究 → subagent | 报告 §八建议采纳。进 run_code 工具 description（进 LLM 可见面） |
| 4 | 框架协作工具进 SDK 投影吗 | **不进** | 投影源 = 生效工具集（call 身份现算），框架协作工具（todo/goal/ask_questions…）与 run_code 同处工具注册面，桥接层天然可达——它们进投影只增加声明噪音 |
| 5（新） | worker 引导形态 | **双入口双文件 + 存在性探测**：dev 直跑 `./worker.ts`；bundle 由 build-bundle.mjs 加第二入口产出 `dist/worker.mjs`，运行时探测回退。eval 字符串自举为备选（桌面资源打包丢文件时启用） | 2026-09-17 本地实验锁定：esbuild 单入口 bundle 对 `new URL('./worker.ts', import.meta.url)` 等三种引用形态**原样保留字符串、文件不进 bundle**，bundle 形态运行时 `Cannot find module`。多入口是标准解且保住 worker 代码的 typecheck/单测性；详证见 §五.2 |
| 6（新） | 形态面（single）与投影的关系 | **投影同口径镜像形态面**（`excludeForms:['single']` 的工具不进投影） | 防投影面与 LLM 可见面（loop 实际送入的 specs）漂移。递归防护（排 run_code 自身）并入同一过滤 |

## 一、包结构（新增两个包，均纯类型消费、无新运行时依赖）

```
src/ac-run-code/                工具行 + worker 运行时（本包自含）
  package.json                  agentchat.plugin: true + keywords + workspace 依赖
  src/index.ts                  apply：run_code 注册（requiredTags:['code-exec']）+ ExtensionMeta
  src/tool.ts                   工具体：投影生成（resolveEffectiveTools）→ worker 执行 → 摘要
  src/bridge.ts                 worker 侧桥接层（结构化克隆协议）
  src/worker.ts                 worker 宿主引导（双入口形态，见 §五.2）+ 程序执行循环
  tests/run-code.test.ts        工具体单测（投影/桥接/预算/中断/并发）
src/ac-run-code-core/           SDK 投影纯库（零 cordis 依赖）
  package.json                  纯库（无 agentchat.plugin）
  src/index.ts                  buildSdkProjection()：ToolDefinition[] → 声明文件字符串
  tests/projection.test.ts      投影纯函数单测
```

- ac-run-code 运行时依赖：`@agentchat/cordis`、`ac-tools`、`ac-agents`（type + resolveToolNames/capabilitySetOf/toolAllowedFor）、`ac-security`（type，词表单源）、`ac-extension-core`（type）。
- ac-run-code-core 零运行时依赖（tests 里 vitest）。
- 仓库根 package.json 无需动（workspace 通配自动链接）。
- **不改 ac-tools 契约**（ToolCall/ToolDefinition 零改动）——工具行形态，not 能力域服务。

## 二、SDK 投影纯库（ac-run-code-core）

**同源纪律**（报告 §六.2 + 本轮源码核对）：投影源 = **resolveToolNames 解析后的生效工具集**，即 router `RouterService.execute` 的工具可见面合成链（`src/ac-router/src/service.ts` L200-224）：

```
caps = capabilitySetOf(ctx, agentId)          // L200
visible = tools.list().filter(t => toolAllowedFor(t, caps))   // L201
resolved = resolveToolNames(agent.tools, visible, …) ?? allNames  // L208-217
form   = conversationForm(conversationId)     // L218（singles 注册表命中 = 'single'）
final  = resolved.filter(formAllowed)         // L224（excludeForms 终滤）
```

**工具行内实现 `resolveEffectiveTools(ctx, agentId, conversationId)`**（不 export 服务方法，纯包内函数）：
- 同链复算（router 私有逻辑不 import 实现——三条红线），tag 展开告警回调接 `ctx.logger.warn`（对齐 router 文案）。
- 返回 `ToolDefinition[]`（含 parameters——投影需要 schema 文档）。
- **worker 每次启动现算、不缓存**（坑 #4：按 run 生成，防 HMR 窗口 + KV 前缀污染）。

**buildSdkProjection(defs: ToolDefinition[], opts)**（纯库，字典序稳定输出）：
- 每工具：`/** description */ read(args: {...}): Promise<...>` 形态；参数类型从 JSON Schema 生成宽松类型（required → 必选；`additionalProperties` 不强校验）；返回 `Promise<{ ok: boolean; output?: unknown; error?: string }>`（契约 = ToolResult）。
- 排除 run_code 自身（递归防护，坑 #3）。
- 头部注入程序书写纪律注释（可擦除 TS / 只读并行、写串行 / 预算 / 返回值压缩 / >3 步确定性序列优先 run_code——裁决 #3）。
- 输出零 npm 依赖（`stripTypeScriptTypes()` 原生可用）；拼装细节见 §四.2。

## 三、run_code 工具行（ac-run-code）

### 3.1 工具定义

- name `run_code`，`requiredTags: ['code-exec']`，无 needPermission（裁决 #2）。
- 参数 schema：`{ code: string（程序体，可擦除 TS 语法）, compute_ms?: number, max_output_bytes?: number }`。
- description（进 LLM）：「以代码编排成批工具调用……确定性编排用本工具、探索性研究用 subagent」+ 预算与中断语义一句话。

### 3.2 worker 生命周期

- 按 §五.2 引导形态启动 worker（dev 直跑 / bundle 探测 / eval 回退）。
- 启动消息携带：投影声明文本（prelude）、调用程序体、预算、身份快照 `{ agentId, conversationId }`。
- `unref()`：worker 不阻止宿主事件循环退出。
- 结算面：computeMs（子调用耗时累计）/ maxWallMs（含审批等待）/ maxOutputBytes（返回值截断）。
- 中断：主线程 `call.signal` → `worker.postMessage({type:'abort'})`，worker 内 AbortController 传递到子调用；被 abort 时工具体返回 `ok:false, interrupted:true`（循环收束检测把 run 收为 interrupted——ac-agent-loop L372-382 的既有语义）。

### 3.3 worker 内执行循环（src/worker.ts）

1. eval(prelude)：挂 `tools` proxy——属性访问按投影声明的方法名派发。
2. eval(程序体)：async Function 构造，await 执行；超预算/中止 → 拒绝。
3. 返回值 JSON 序列化（maxOutputBytes 截断）+ 执行摘要（子调用计数/耗时/被拒清单）。
4. 全程结构化克隆传值（无引用逃逸面）。

## 四、桥接层与并发纪律（src/bridge.ts）

### 4.1 协议（结构化克隆）

```
主线程 → worker：{ type:'invoke', seq, name, args, meta }   // meta = 身份快照
worker → 主线程：{ type:'result', seq, ok, output?, error? }
主线程 → worker：{ type:'abort' }
```

### 4.2 prelude（主线程拼装、worker eval）

```ts
declare const tools: { [name: string]: (args: any) => Promise<{ ok: boolean; output?: unknown; error?: string }> };
// + buildSdkProjection 产物（declare const tools: { read(...): ... }）——工具行启动时拼装
```

（实现手法：投影纯库生成声明文本（供模型阅读 + 拼入指引）；worker eval 的只有 runtime 桥接（proxy 挂载）与程序体。程序体的可擦除 TS 语法擦除用 `node:module` 的 `stripTypeScriptTypes()`（Node ≥22.13 原生，与仓库 engines ≥22.18 对齐）——零 npm 依赖，兑现 §一「无新运行时依赖」。）

### 4.3 并发纪律（坑 #2：工具粒度，非标签粒度）

- 串行名单 = `WRITE_PATH_TOOLS ∪ COMMAND_TOOLS`（ac-security/src/index.ts L44-50 **单源 import**，不建第二份词表）。
- 其余可 Promise.all（上限 5，对齐 loop mapLimit——`src/ac-agent-loop/src/service.ts` L349）。
- 分类元数据随启动消息下放 worker。

### 4.4 安全面复用（双重校验）

worker 侧子调用发回主线程执行——**不经 ctx.tools.execute 就不是复用**。主线程桥接监听器对每个子调用组装 ToolCall：`{ name, args, agentId, conversationId, toolCallId: runId#seq, signal: workerAbortSignal, elevation }`（身份随程序出生时快照，坑 #1 之外的执行身份不变量）。能力轴/档位门/黑名单/扫描/脱敏/事件面自动生效（tool/before-execute、tool/after-execute、tool/transform-result 全链路）。

### 4.5 审批等待（坑 #5）

needPermission 子工具询问提权时主线程阻塞等待——**审批时间不计入 computeMs**（只累计子调用工具体执行耗时）；maxWallMs 独立给余量。

### 4.6 并发纪律实现

主线程侧同 run 内的子调用若涉及写路径/命令类工具，按提交序串行（对齐 §四.3 语义）。写串行的执行点在主线程桥接（seq 序）——worker 内只是控制流（Promise.all 与否是程序作者的事，纪律进指引）。

## 五、worker 引导形态（裁决 #5 的完整证据与设计）

### 5.1 问题事实（2026-09-17 本地实验，仓库 esbuild 同参数 + Node 24.18 实跑）

- dev（TS 源直跑）：`new Worker(new URL('./worker.ts', import.meta.url))` 三种写法（new URL 静态 / 字符串拼接 / fileURLToPath）**全部正常**——worker 以主进程相同加载器条件解析，.ts 由 Node 原生 strip-only 处理。
- bundle：`build-bundle.mjs` 的打包参数（bundle:true、单入口、无 splitting）下，esbuild 对上述三种引用**全部原样保留字符串、worker.ts 不进 bundle、文件不复制**——部署目录运行时 `Cannot find module ...\worker.ts`，三变体无一幸免。

### 5.2 双入口双文件 + 存在性探测（选定方案）

```
dev：     new Worker(new URL('./worker.ts', import.meta.url))          // 直跑 TS
bundle：  build-bundle.mjs 增第二入口 src/ac-run-code/src/worker.ts
          → dist/worker.mjs；主线程探测 dist 同目录 worker.mjs 存在
          → new Worker(new URL('./worker.mjs', import.meta.url))
回退：    两处都不可达（如桌面壳资源打包丢文件）→ eval 字符串自举
          （BOOTSTRAP 一行式：动态 import 主 bundle 暴露的 worker 工厂）
```

- worker.ts 始终是**真模块**（可 typecheck、可单测）——bundle 里它是独立第二入口产物，主 bundle 不含其代码（无递归打包）。
- 主线程按存在性探测选择（fs.existsSync + import.meta.url 相对解析），无环境变量开关；eval 自举备选保留为三级回退（仅异常部署触发，正常路径不经过）。
- 集成测试覆盖引导选择逻辑（dev 直跑即单测路径；bundle 探测/回退用 mock 存在性验证选择分支）。

### 5.3 额外约束

- worker 是 containment 不是 boundary（DSH 口径）：主线程才执行工具，worker 只做资源约束（computeMs/maxWallMs/maxOutputBytes + unref）。
- worker 不自 `process.exit`；结束 = 主线程 `terminate()`（预算耗尽/中止）或 worker `parentPort.close()`（正常收尾）。

### 5.4 中断语义（坑 #7 依赖的前置修复已合入）

ac-agent-loop abort 归因修复已合入（handoff §三）：signal 中止 → finish:'interrupted'。run_code 的中断 = loop 检测到 interrupted 工具结果时收束 run（L372-382 既有检测，run_code 工具体带 interrupt 载荷即可复用）。

## 六、预设数据行（ac-agent-presets-builtin 增补）+ 随行

### 6.1 PROGRAMMATIC 预设（ac-agent-presets-builtin/src/index.ts）

```ts
const PROGRAMMATIC: AgentPresetDefinition = {
  meta: {
    label: '程序化模式',
    description: '以代码编排成批工具调用，大幅降低 token 消耗：模型写一段程序组合多步操作，只有最终返回值回上下文',
    order: 3,
  },
  agent: {
    id: '__programmatic__',
    name: '程序化模式',
    preset: true,
    tags: ['fs', 'infra', 'shell', 'web', 'delegation', 'code-exec'],
    tools: { include: ['run_code', 'tag:fs', 'tag:shell', 'tag:infra', 'tag:web', 'tag:delegation'] },
    settings: { memory:{enabled:false}, skill:{enabled:false}, datetime:{enabled:false} },
  },
};
```

- include 头条 `run_code` 点名（与 dsh-minimal 的 `str_replace_editor` 点名同款——此工具不能从标签展开，因为它是 include 的目的）。
- 物化层 tag:shell 占位解析（ac-agent-presets L109-122）自动生效，无需改动。
- tags 里 code-exec 与 shell 并存（裁决 #2 同等信任，预设默认开）；无 collab/history（对齐 2026-09-17 标准模式精简）。
- settings 三停对齐 STANDARD/DSH_MINIMAL（无记忆语义）。
- ExtensionMeta description 同步加第三模式；portb-e2e 扩展目录期望清单加 `'run-code'`。

### 6.2 code-exec 标签预注册（ac-tag-registry/src/service.ts RESERVED 表）

```ts
{ tag: 'code-exec', category: 'capability', description: '程序执行（run_code：以代码编排成批工具调用）' },
```

### 6.3 运行期集成测试（§七 步 5 的新面）

boot 全 TREE → resolve __programmatic__ 的 include → 断言每个 tag: 展开非空（tag:fs 事故教训：静态断言抓不住空展开）。落点：ac-agent-presets-builtin/tests（新增 integration.test.ts）。bootTree 全启可能偏重——可 boot 最小行集（agents/presets/builtin + fs-tools/fs-search/shell-tools/math + web-tools/subagent/delegation 面）按 §三 链路解析断言。另外 run-code 行 boot 后 tag-registry catalog 须含 code-exec 条目（reserved 预注册 + run_code 工具消费计数 = 1）。

## 六.5、（预留）研究行沉淀期可能的其他随行

- sap-adt-preset 先例（独立子行注入预设）：本计划不采——程序化模式是通用能力，不绑 SAP 域，随 preset-builtin 同行注入。
- `src/README.md` 契约归属总表不新增服务（工具行 + 纯库，无新 ctx key）——但**工具面/标签词表/预设清单**三处注记随行更新（README 有「tags 即工具面」限定语节）。

## 七、实施顺序（可暂停的 6 步）

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | **ac-run-code-core 纯库**：buildSdkProjection + 单测 | vitest 纯函数测试 |
| 2 | **worker 引导形态验证**（§五.2 已定方案）：dev 直跑 echo 已由 2026-09-17 预实验证实；包骨架就位后补第二入口 bundle 产物 + 探测回退的实跑确认 | 两形态 worker 全链路 echo |
| 3 | **ac-run-code 骨架**：包/package.json/工具注册（worker 先 return error 占位）+ 组合根双表 + tag-registry 预注册 | boot 注册面 + catalog 含 code-exec |
| 4 | **桥接层 + worker 执行循环**：协议 + 主线程执行器（ctx.tools.execute + 串行纪律 + abort 传递）+ prelude/程序体 eval + 预算与审批计时口径（§四.5）+ 程序书写纪律进 description | 单测覆盖协议/预算/中断/并发；真实 worker 启动测试 |
| 5 | **预设数据行 + 集成测试**：PROGRAMMATIC 定义 + portb-e2e 期望 + 运行期集成测试（tag: 展开非空、子 Agent 继承 code-exec） | bootTree 断言 |
| 6 | **文档与验收**：README 工具面/标签/预设注记 + bundle 冒烟（dev/bundle 两形态 run_code 回声） | typecheck + pnpm smoke + §十清单 |

## 八、踩坑对照表（交接单 §四 + 本轮源码核对）

| # | 坑 | 计划回应 |
|---|---|---|
| 1 | SDK 投影源 = resolveToolNames 解析后的生效工具集 | §二 resolveEffectiveTools 同链复算 + worker 按调用现算 |
| 2 | 并发分类按工具粒度不按标签粒度；单源 WRITE_PATH_TOOLS/COMMAND_TOOLS | §四.3 import 单源；fs 族内 glob/grep 是只读，按工具名分类 |
| 3 | 投影排除 run_code 自身；子 Agent 投影同排；递归防护（subagent 等编排工具按 requiredTags 由能力轴自然拦截——子 Agent 派生身份剥 delegation/admin，subagent 对子 Agent 不可见；run_code 在子 Agent 可见但投影排自身，程序内不能 spawn run_code 程序） | §二 buildSdkProjection 过滤 + §六.3 集成测试断言 |
| 4 | 投影快照按 run 生成、不跨 run 缓存 | §二：worker 每次启动现算 |
| 5 | 审批等待与预算：needPermission 阻塞 | §四.5 computeMs 不计审批 + maxWallMs 余量 |
| 6 | 预设 tag: 引用要运行期集成测试 | §六.3 集成测试（每个 tag: 展开非空断言） |
| 7 | worker 是 containment 不是 boundary | §五.3：主线程才执行工具 |
| 8 | 指引双版本（互斥注入纪律/并存加选择策略） | §二 投影头部注释 + §七 步 4（description） |
| 9（新） | esbuild bundle 对 worker URL 引用原样保留、worker.ts 不进 bundle | §五.2 双入口 + 存在性探测（2026-09-17 本地实验证实，三变体 bundle 形态全断链） |
| 10（新） | 形态面 single 与投影 | 裁决 #6：resolveEffectiveTools 同口径镜像 |
| 11（新） | 子 Agent 派生身份继承 code-exec（STRIPPED_TAGS 无 code-exec），run_code 在子 Agent 会话可用 | 无需实现——派生身份机制既有；§六.3 集成测试加断言（子 Agent tags 含 code-exec） |

## 九、交付物清单

1. `src/ac-run-code-core/`（投影纯库 + 单测）
2. `src/ac-run-code/`（工具行 + worker/桥接 + 单测）
3. `src/ac-agent-presets-builtin/src/index.ts`（+PROGRAMMATIC）+ `tests/integration.test.ts`
4. `src/ac-tag-registry/src/service.ts`（RESERVED + code-exec）
5. `src/cordis.yml` + `src/ac-app/src/index.ts`（run-code 行）
6. `src/README.md`（工具面/标签词表/预设清单注记）
7. 测试随行：portb-e2e 期望清单 + reserved-consistency（BUILTIN_TOOL_NAMES + 'run_code'、BUILTIN_AGENT_IDS + '__programmatic__'）+ tag-registry tests（若锁定 RESERVED 面）
8. 本计划文档 `src/docs/programmatic-mode-implementation-plan.md`（即本文件）

## 十、版本验收标准

- `pnpm typecheck` 通过。
- `pnpm --filter ac-run-code-core test` / `pnpm --filter ac-run-code test` / `pnpm --filter ac-agent-presets-builtin test` / `pnpm --filter ac-tag-registry test` / `pnpm --filter ac-plugin-registry test`（reserved-consistency）/ webui portb-e2e 全绿。
- dev 形态与 bundle 形态（build-bundle 后）各跑一次 run_code 冒烟：`run_code({ code: 'return 1+1' })` → `2`（或等价 echo）。
- 预设集成测试断言：__programmatic__ 物化 tags 含 code-exec；include 每项展开非空；run_code 在生效工具面。
- tag-registry catalog 含 code-exec（tools 计数 = 1）。

## 十一、验收遥测（2026-09-17 P0 实施完成时记录）

| 验收项 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 通过（含新包 ac-run-code / ac-run-code-core） |
| `pnpm vitest run src/ac-run-code src/ac-run-code-core` | ✅ 20/20（注册/投影/递归防护/桥接/串行/import 拒绝/类型擦除/步记录/预算/中止） |
| `pnpm vitest run src/ac-agent-presets-builtin src/ac-tag-registry` | ✅ 16/16（含新增 integration.test.ts 4 用例：tag: 展开非空 / catalog code-exec / 投影递归防护 / 子 Agent 继承） |
| reserved-consistency（boot 全 TREE） | ✅ 2/2（BUILTIN_TOOL_NAMES + run_code；BUILTIN_AGENT_IDS + __programmatic__） |
| web-api + portb-e2e | ✅ 58/58 + 5/5（期望清单随行更新） |
| `node scripts/check-deps.mjs` | ✅ 通过（R1-R7；无用声明已清） |
| `pnpm smoke` | ⚠️ 失败但**与本批无关**（基线验证：stash 全部改动后同样失败——smoke.ts 硬编码 gpt-4o-mini 而本机 fixture 无 openai 连接，NO_PROVIDER 既有问题） |
| bundle 形态冒烟（build-bundle 后 run_code 回声） | ⏭ 未跑（build:bundle 需先 build:frontend——发布流程活，非 P0 验收阻塞项；第二入口 worker.mjs 已接线，dev 形态真 worker 链路由 20 个用例覆盖） |

### 实施与计划的偏差记录

1. **握手方向**：原设计「主线程等 ready 再发 init」→ 实现「worker 启动即主动发 ready，主线程收到即发 init」——避免双等死锁（实测复现后修正）。
2. **类型擦除顺序**：原设计「先擦除再包裹」→ 实现「先 async IIFE 包裹再 stripTypeScriptTypes」——顶层 return 在 module 语境非法，包裹后合法且类型标注照常擦除。
3. **vitest URL 查询后缀**：`resolveWorkerEntry` 剥 `?v=` 后缀再判存在（transformer 环境兼容）。
4. **computeMs 口径**：以子调用墙钟近似（含排队，不含 before-execute waterfall 内审批等待——ac-tools durationMs 在 waterfall 后起算，与计划口径一致但实现为保守方向：审批等待若发生在子调用内会略微高估 compute，预算宁可早停）。
5. **capabilitySetOf 不直接调用**：工具行 inject 只声明 tools，受限调用方 fiber 下 `ctx.agents` 属性访问断链——按同款合成逻辑（{'base','agent:<id>'} ∪ tags）手工实现，与 ac-agents 单源语义一致（capabilitySetOf 本体归 router/服务侧使用）。

### 实测复盘修复批（2026-09-17，singles e7be6fca 首次真模型会话）

| # | 问题 | 修复 |
|---|---|---|
| A1 | SDK 投影「发送即丢弃」（工具体算完发 worker，worker 存而不用——模型盲调 API，实测第一轮即因 read 目录返回类型猜错失败） | 新增 `src/prompt.ts`：`loop/before-run` 主档注入投影块（SDK 声明 + 书写纪律）进 system 尾部；run_code 不在生效面时不注入；每次 run 现算（与工具体同源 resolveEffectiveTools）。WorkerInit 删 projection 字段 |
| A2 | 返回值压缩纪律未送达（实测 12.7KB 原样包回，token 主张落空） | 与 A1 同块注入：DEFAULT_GUIDANCE（纪律基线）+ 并存形态附「执行形态选择」策略（report §六.8 指引双版本落地） |
| B | 子调用入账与模型直调同形（UI 会出现无主工具卡；会话文件结果双写） | ToolCall 契约补 `runCodeSubcall?: boolean`（开放词汇面）；桥接层组装子调用时置 true；ac-session tool-result 补行透传 `subcall` 字段（UI 据此折叠；审计面保持全量——会话文件双写为既有 KV 保真语义，接受） |
| C | 写路径串行零真覆盖（旧探针 wtool 不在词表内，断言测的是回填序非串行） | 单测改注册 name='write' 探针（真词表命中）——锁定「提交序执行」（seq 1 delay30 先完成才算 2/3）+ summary.serialized 断言 |
| D | 程序体全文入 host 日志未实现（裁决 #1 的诊断去处缺失） | 工具体启动前 `logger.debug` 全文（带哈希锚）+ 收束 `logger.info` 一行（run/ok/calls/compute/wall/hash 可检索） |

实测另两项记录在案不修：worker 冷启动 ~100ms/次（无池化，DSH 同款，可接受）；glob 对 `target==='.'` 跳过黑名单导致的列名穿透（既有工具语义，非本批引入——安全面复审项）。

### 二次实测验证（2026-09-17，singles c77f7352——修复批生效确认 + 新发现两修）

修复批四项全部实证生效：投影块入 system（前缀快照 8569 字符含全签名 + 选择策略）；返回值 12.7KB→337B（结构探测结论——token 主张首次兑现）；subcall 标记落盘（UI 可区分）；会话文件 51KB→19KB。新发现随修：

| # | 问题 | 修复 |
|---|---|---|
| E1 | `read` 工具 description 与实态不符（「目录则返回列表」——实为 `{path, type:'directory', items:[{name,type}], count}` 对象）——二次测试第一轮仍猜错类型的根因：模型**按投影文档**猜（首测是无文档盲猜） | `ac-fs-tools/src/index.ts` read description 改为精确形态描述（文件/目录两分支的 output 形状全写明） |
| E2 | 投影库 JSDoc 转义过激：`*/ → *∕`（U+2215 除号斜线）把 glob 模式 `**/*.ts` 转成怪字符 `**∕*.ts` | `ac-run-code-core` 转义改 `*\/`（反斜杠保形，模型熟悉的惯用形）；单测补 glob 模式断言 |

### 三次实测：dev 形态 bootTree 冒烟脚本收口（2026-09-17）

新增 `src/ac-app/src/smoke-run-code.ts`（`node src/ac-app/src/smoke-run-code.ts` 直跑）：补齐 §十「dev 形态 run_code 冒烟」缺的**真 bootTree 全 TREE** 链路面（此前 dev 形态由单测最小行集覆盖）。22 项断言全绿：预设物化（tags/inclu­de）/ catalog code-exec / 纯计算 `return 1+1→2` / 真 fs 工具编排（read 目录 + glob + 只读 Promise.all，5 子调用，真 worker + 桥接 + ctx.tools.execute 全链）/ 递归防护 / subcall 标记 / LLM 端到端（scripted provider 首轮出 run_code 调用 → 投影块注入 #A1 + 选择策略 #A2 → value=42 → 文本收束）。代码级基线同批复验：typecheck ✅、四域 39/39、plugin-registry+web-api 117/117、portb-e2e 5/5。

| # | 问题 | 修复 |
|---|---|---|
| E3 | `glob`/`grep` description 未写 output 形态与 **paths 锚点语义**（返回 paths 相对工作区锚点、非搜索根——拼绝对路径再 read 会路径双写，实测踩坑：`files\probe\files\probe\a.txt` ENOENT） | `ac-fs-search/src/index.ts` 两工具 description 对齐 E1 风格补全 output 形状 + 「paths 条目可直接作为 read/grep 相对路径参数（同锚点解析）」联动语义 |
