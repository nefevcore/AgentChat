# 程序化模式（run_code / PTC）交接单

> 2026-09-17 收口（v2 精简版）。形态终态 = **会话级开关**（conv-settings `programmatic` → router 收窄 LLM 面为 `['run_code']`，投影源 = 能力面直取）；`__programmatic__` 预设已退役。经九次真模型实测迭代，全部代码就绪**未提交**（工作树混有既有批次，见 §四）。
> 历史：实施计划 `programmatic-mode-implementation-plan.md`；研究报告 `coding-mode-preset-research.md` v6（§十开关化终裁）；前交接单 `programmatic-mode-handoff.md`。

## 一、架构地图

```
ac-run-code/
  src/index.ts     工具注册（requiredTags ['code-exec']）+ 投影注入挂载
  src/tool.ts      executeRunCode 主链 + resolveEffectiveTools（scope 双口径）
                   + subcallBrief/trace + 串行纪律 + 预算/中止 + lib 会话级存储
  src/prompt.ts    loop/before-run 注入投影块（互斥/并存双版本；
                   形态判定读 run 级 request.tools 终值 ∩ 复算面）
  src/worker.ts    containment 宿主（IIFE 包裹→stripTypeScriptTypes→eval）
  src/protocol.ts  结构化克隆协议
ac-run-code-core/  buildSdkProjection 纯库（字典序稳定——KV cache 友好）+ DEFAULT_GUIDANCE
ac-client-ui-run-code/   ToolResultRunCode.vue 四段式卡（程序/时间线/返回值/错误）

开关链路（宿主锚点，摘 ac-run-code 插件后残留但无害）：
  ac-conv-settings   ConvSettings.programmatic?: boolean（wire 'true'/'false'→持久 boolean）
  ac-router          execute 工具面合成后：开关开且 run_code 在面 → llmTools=['run_code']；
                     不在面 → warn 忽略（惰性）
  ac-subagent        executeRun 信封装配点：发起会话开关开且 spawn 未点名 tools →
                     子 Agent 同收窄（转换随工具集流动；点名优先；无 code-exec 惰性）
  ac-web-api         conv-settings/set 透传 programmatic；agents/presets 透出 tags
  ac-client-ui-conversation  ChatInput「工具使用模式」dd（braces 图标）+
                     programmaticAvailable（无 code-exec 禁选提示）+ presetRetired 防御
  ac-agent-presets-builtin   __standard__ tags 含 code-exec（默认路由路径可开开关）
  ac-tools/ac-session/ac-tag-registry   runCodeSubcall 标记 / subcall 补行 / code-exec 预注册
组合根：run-code 单行（cordis.yml 与 TREE 同步）。
```

## 二、设计裁决（已定，勿重议）

| # | 裁决 | 落点 |
|---|---|---|
| 1 | 步记录 = 摘要 + trace 时间线（上限 50）+ programHash；程序体全文入 host 日志 | tool.ts |
| 2 | run_code 不挂 needPermission——子调用逐个走 ctx.tools.execute 全门禁 | index.ts |
| 3 | 确定性编排→run_code / 探索性研究→subagent | description+纪律 |
| 4 | **程序化 = 对工具集的转换**（工具集→SDK 投影→覆盖为 run_code 单入口），非显式注入；转换随工具集流动（router 主链 + subagent 传播） | router+subagent |
| 5 | 投影源 = 能力面直取（scope='projection' 跳过 include/开关收窄）——tags 即工具面的授权真理；递归防护 = 投影排除 run_code | tool.ts |
| 6 | prompt.ts 形态判定读 **run 级 request.tools 终值** ∩ 复算面（开关收窄不落 Agent 配置）；缺省（直调 loop）= 复算面全量 | prompt.ts |
| 7 | worker 引导双入口：dev worker.ts / bundle worker.mjs（existsSync 守卫；esbuild 对 Worker URL 引用原样保留——三变体全断链的实验结论） | tool.ts+build-bundle.mjs |
| 8 | wire 值域：布尔键经 set patch 以 `'true'`/null 写入，持久真 boolean；web-api 透传 | conv-settings+web-api |
| 9 | 词表单源 + 降级：运行时 require('ac-security') try/catch，缺席回落内置名单 | tool.ts |
| 10 | lib 临时库：会话级 `lib.define/resolve` 闭包注入（容量 64KB/32 条；失败 run 不回写）；声明 `resolve(): Record<string, unknown>`（防 as any 回流） | tool.ts+core |
| 11 | 开关惰性：run_code 不在生效面（无 code-exec）→ warn 忽略不拦截（router/subagent 同口径）；前端 programmaticAvailable 禁选提示 | router+ChatInput |

**否决项（防重议）**：跨程序变量/持久状态；程序内框架内置 helper 库（lib 是显式通道，复用决策归模型）；worker 内 tsc 检查（可擦除裁决——运行时错误秒级自纠足够）。

## 三、实测沉淀（九次，结论抽取）

| # | 会话 | 模型 | 任务 | 关键结论 |
|---|---|---|---|---|
| 1-3 | e7be6fca 等 | glm-5.3 | 冒烟级 | 投影注入生效；返回值 12.7KB→337B |
| 4 | 4cd1a90d | glm-5.3 | 真活修复 | 强模型互斥形态零犹豫；暴露五问题全修（§五） |
| 5 | a7828839 | glm-5.3 | 前端修复 | 量化收益坐实：58 子调用→27 程序；**强模型侧定性收口** |
| 6 | 0d55714a | glm-5.3 | CSS 修复 | 3.4 分钟；serializeValue 降级链 bug 修 |
| 7 | 9f58bfc9 | glm-5.3 | 开关化首战 | 默认路由路径全链路通：35 run_code 直调/传统直调 0 |
| 8 | 3b9db554 | glm-5.3 | lib 定向 | lib 七断言全过；**引导在场一次上手**（无引导归因闭环） |
| 9 | 7a571cac | deepseek-flash | 并发 subagent | 真并行坐实（墙钟≈max）；**弱模型主 Agent 编排可用**；子 Agent 指令遵循 1/3 跑偏（幻觉非串台） |

- 量级基线：return 均值 ~1.6KB/最大 11KB（32KB 预算未触顶）；互斥形态单调用程序占比 ~60%（「一切皆程序」为预期特征）；落盘三份冗余（partial 程序体/subcall 补行/收束行 ≈ 会话体积 60%——write-ahead 代价，读侧已收敛，量级稳定）。
- guidance 有效性已验证：信封解包/省 as any/lib 用法均被消费；唯一回流点（lib.resolve as any）已修。
- 弱模型开放项：子 Agent 首轮长模板指令遵循（可观察「任务更具体→跑偏率降」）；待更多样本。

## 四、待办（按优先级）

1. **弱模型补测**：开关 on 会话 + 弱模型多步任务（首份数据积极——待办 1 主项）；附带观察：子调用直播事件前端形态（直播期 N 张子调用卡 vs 刷新后单卡）。
2. **提交拆分**：工作树 70+ 文件混既有批次，分 commit：程序化主体 / 既有批次 A（durable-interaction 拆分）/ B（subagent client 改名）/ C（InteractionBar.vue 13 个 typecheck 错，**未修**）。
3. **bundle 冒烟**：`pnpm build:frontend && pnpm build:bundle` 后验证 dist/worker.mjs + run_code 回声（dev 已全覆盖，bundle 路径未实测）。
4. **webui:typecheck 基线**：InteractionBar.vue 13 错（挡 CI）。
5. **P1+ 缺口**（增量生态，均未动工）：钩子行（编辑后 lint 回喂）/ AGENT.md 架构速览（实测探索弯路主因）/ fileSnapshots.restore UI / git 工具 / plan mode / edit 结果带编辑后窗口（省复验轮）/ list_tools 对子 Agent 报全局清单与白名单不一致（权限感知对齐）/ 高频 lib promote 文件形态。

## 五、已修框架缺陷（防重引入）

- **worker 预检误杀**：`findBannedModuleSyntax` 必须先剥注释/字符串（掩蔽保留首尾引号）再匹配真模块语义——旧全文本正则会拒掉 pwsh 命令里的 require 字样。
- **卡片收束丢程序体**：ToolMessage 完成态 `{ ...args, ...resultData }`（结果字段优先）。
- **serializeValue 降级链**：stringify 抛错 → BigInt/Function/Symbol/Circular 占位 replacer；说明走 value 内 `__serializeNote`（**不能拼 text**——下游 parse 纯 JSON）。
- **glob 快照污染**：PERSISTENCE_TREES 收录 file-snapshots。
- **默认预设缺 code-exec**（3a8ea4f7 坑）：`__standard__` 已补授——开关对默认路由路径生效的前提。
- **开关不传 subagent**（7a571cac 坑）：已实施传播（裁决 #4）。

## 六、工程坑（防重踩）

1. 工具行内可选能力一律 `ctx.get('xxx', false)`（属性访问断链）；capabilitySetOf 需手工合成 caps。
2. worker 握手：worker 先发 ready，主线程收到才发 init（反向双等死锁）。
3. 类型擦除顺序：先 async IIFE 包裹再 strip（顶层 return 在 module 语境非法）；lib 程序体形态同坑。
4. resolveWorkerEntry 剥 `?v=` 后缀再 existsSync。
5. loop 的 request.tools 缺省 = 全部已注册（绕过能力面）——测试断言 LLM 面必须显式传 tools。
6. 测试环境坑：vitest URL 后缀；jsdom import 失败静默 undefined（先单跑该文件）；跨转义层字符串用运行时拼接。
7. 全仓并发跑测试有 flaky——按域单跑稳定。

## 七、测试基线

- 常跑：`pnpm vitest run src/ac-run-code src/ac-run-code-core src/ac-agent-presets-builtin src/ac-client-ui-run-code src/ac-subagent src/ac-router src/ac-conv-settings src/ac-web-api src/ac-client-ui-conversation src/webui/tests/clients-tool-cards.test.ts`
- 核心集成：`ac-run-code/tests/switch.test.ts`（开关端到端）；subagent 传播四用例；router 收窄三用例。
- 对账面：portb-e2e 扩展目录（run-code 单行）、web-api presets（两预设+tags）、reserved-consistency（BUILTIN_AGENT_IDS 无 __programmatic__）。
- 冒烟：`node --expose-internals --import tsx src/ac-app/src/smoke-run-code.ts`（开关装配端到端）。

## 八、相关索引

| 内容 | 位置 |
|---|---|
| 实施计划 + 验收遥测 | `src/docs/programmatic-mode-implementation-plan.md` |
| 研究报告（终裁 §十） | `src/docs/coding-mode-preset-research.md` v6 |
| 前交接单（P0 修复史） | `src/docs/programmatic-mode-handoff.md` |
| README 架构速览 | `src/README.md` §工具执行面后 |
| 实测会话数据 | `workspace/home/sessions/singles/ws-mtoc7l26-yfif/{4cd1a90d,a7828839,0d55714a,9f58bfc9,3b9db554,7a571cac,…}/` |
