# conv-settings 精简批交接档（cr-1090）

> 性质：交接——会话键域四批精简实施的接力入口；承接三轮头脑风暴调查（cr-1087/1088 已入契约档）。
> 状态：已完成（批④ cr-1091 ✓ · 批② cr-1092 ✓ · 批① cr-1093 ✓ · 批③ cr-1094 ✓）——四批全部落地，本档可归档 · cr-1090 2026-11-15。
> 读者：接手实施conv-settings 精简批的会话/人；先读 `docs/design/session/conv-settings-conventions.md`（§七实施轨道）再读本档。

## 一、当前进度

四批**均未动代码**——已完成的是调查与文档固化：

- ☑ cr-1086：契约文档数据流主线重组（七面清单 → 站点式）。
- ☑ cr-1087：深度调查订正——grants 验尸（六决定点宣称不实）、写时机裁决（消息边界写）、harnessTier 死键、运行中切换三键三时机实测。
- ☑ cr-1088：值域校验判无意义（enum 实为 UI 选项列表；pattern 零消费）。
- ☑ 批④ 值域校验退役（cr-1091：pattern/isValid/回读过滤三面删除，落盘即真相；全量 unit 3094 绿） → ☑ 批② grants 退役（cr-1092：web-tools 直读 max(Agent 档, 会话键)〔Agent 侧经 capabilitySetOf 保留 settings.browser 兼容线——交接档「直读 levels」锚点不完备处〕；sessionCapsOf 零消费整删 + toolAllowedFor 恒 true 链清零；ac-web-tools 包内首个测试 browser-gate.test.ts 4 例；全量 unit 3096 绿） → ☑ 批① 发送时写（cr-1093：控件表单化 + `prepareSend`/`flushConvSettings` 单次 patch；草稿三件套/偏好继承写/写失败回滚全蒸发；singles model 保持 session.json 即时〔信封模型源，见批①段实测差异〕；全量 unit 3091 绿 + build:channel 绿） → ☑ 批③ harnessTier 整键退役（cr-1094：删键注册 + disabled 拦截臂 + convSettings inject 依赖；run_harness 保留；全量 unit 3090 绿）。**四批全部完成。**

## 二、逐批锚点（改动面 + 关键文件 + 验证）

### 批④ 值域校验退役（纯删除，最小面，建议首战）

- `packages/ac-conv-settings/src/service.ts`：删 `pattern` 字段（interface + toolMode def 行）、`isValid` 方法、`set` 内键域过滤分支（`if (typeof value === 'string' && this.isValid(...))` → 直写）、`readSettings` 回读过滤（`this.keys.has(k) && this.isValid(k, v)` 条件移除——保留 typeof string 检查）。
- `enum` 保留但语义改注：interface 注释改「UI 选项列表」。
- 注册即归属的「存量值回读被清」语义随之消失——**这是有意的行为变化**（落盘即真相，垃圾值由消费方天然回落兜底；壳侧 Shim 从不校验已运行数月）。
- 测试重锁：`packages/ac-conv-settings/tests/conv-settings.test.ts`——**已完成（cr-1091）**：7 处用例按「落盘即真相」重锁；access/elevation 存量值改为原样透出（物理清理由 cr-1082 脚本负责）。
- 验证：`pnpm typecheck && pnpm test:unit`，定向 `npx vitest run packages/ac-conv-settings packages/ac-host-webui`。

### 批② grants 退役（纯删除 + web-tools 两行改直读）

- `packages/ac-web-tools/src/index.ts` browser 分层门禁（:349 附近）：`sessionCapsOf` 判层级改直读——`tier = max(Agent levels.browser 层级, effective().browserTier 映射)`，与 disabled 臂（:324）同读法同函数；「只升不降」语义等价（原注释自供「授权语义 = grants 并集」）。
- 删 `packages/ac-agents/src/service.ts`：`ConvSettingsKeyDef.grants` 字段、`sessionCapsOf` 的 grants 注入段（:136-141）、`toolAllowedFor`（:150-155 恒 true 函数本体）。
- 三处恒 true 调用点清理：`ac-agent-loop/src/service.ts` :557、`ac-collab-tools/src/index.ts` :550、`ac-run-code/src/tool.ts` :183（filter 链中去掉 `toolAllowedFor(t, caps)`；agent-loop :442 的 caps 若仅此用途一并删）。
- 测试重锁：`packages/ac-agents/tests/`（capability-settings / resolve 中 grants 与 toolAllowedFor 用例）、`packages/ac-web-tools/tests/`（分层门禁层级来源改直读）。
- 验证：typecheck + test:unit + 定向 vitest（ac-agents / ac-web-tools / ac-agent-loop / ac-collab-tools / ac-run-code）。

### 批① 发送时写（最大批次，动前端行为面）

- 核心语义：**设置随消息边界生效，进行中的 run 不受干扰**。草稿位选择只改表单状态；真实 sid 首条消息发送时一次 patch 写入；续聊改值随下一条消息生效（表单值即未生效态，无提示——用户已裁决）。
- `packages/ac-client-ui-conversation/client/ChatInput.vue`：
  - 五处控件（selectModel / selectToolMode / selectBrowserTier / selectEffort 无关 / selectExtKey / selectAccess 已退役）的「选择即写」分支删除——只改本地 reactive 值。
  - `setConvSetting` 写口保留但调用点收拢到发送链（或直接内联）；`convSettingStored` 回显逻辑保留。
  - 两个偏好继承 watch（toolMode :483 / browserTier :662）的「无显式键回放偏好并落写该会话」段删除——偏好只做表单初始值（`已存值 ?? 偏好`）。
  - 发送链（首条消息 dispatchDraft 前 / 续聊 send 前）：收集表单脏值（与已存值 diff）一次 `conv-settings/set` patch。
- `packages/ac-client-ui-singles/client/index.ts`：`setConvOverride`/`convOverrideValue`/`PendingMeta.convOverrides` 三件套删——草稿键值并入表单状态；`dispatchDraft` :506-512 逐键搬运改单次 patch RPC。
- 服务端哨兵闸（web-api :522）保留为保险丝。
- 测试重锁：`packages/ac-client-ui-conversation/tests/draft-conv-settings.test.ts`（直写面收口断言保留；「五写口全经 setConvSetting」语义改为「发送时单点」）、`packages/ac-client-ui-singles/tests/draft-single.test.ts`（convOverrides 留存往返用例删/改）。
- 验证：typecheck + test:unit + `pnpm webui:typecheck` + `pnpm build:channel` + 定向 vitest 两包。
- 行为差异提示：续聊位「改设置后不发送」不再即时落盘——上轮对话中 approval 变化的即时通知链路（会话设置通知行）会变为随下次发送出现，属预期。

**已完成（cr-1093）——与锚点的实测差异**：

- 实现形状：`convBaseline`（读面已存值快照）+ `dirtyConvPatch()`（表单 vs 基线）+ `flushConvSettings()`（一次 patch，失败不回滚不 toast，下次发送重试）+ `prepareSend()`（草稿物化 → 拿签发 sid → flush；send/sendNow 共用）。`setConvSetting`/`convSettingStored`/`onDraft` 三件套 → 前者删除、`onDraft` 保留（语义改为「草稿位跳过服务端回读」）。
- **model 例外（锚点未覆盖）**：singles 的 model 保持 `updateSession` 即时写——信封模型取自会话上下文（`chat-core` deliver 带 `ctx.model`），延迟写会造信封/session.json 双源。1v1 的 model 已表单化（走同一 patch；`dirtyConvPatch` 对 singles 形态剔除 model 键）。
- 偏好继承写整机制退役：`toolModeInherit.ts`（persistToolMode/settleToolMode）+ 其测试文件删除，`chat-core.deliver` 的 `settleToolMode` 等待与 `toolModeKeyOf` 一并删除。
- 快照 bump（`store.setConvToolMode`/`setConvBrowserTier`）挪到 flush 成功后——表单值即未生效态，选择不再提前改预览/估算面。
- `pnpm build:channel` 实为 `apps/ui` 子包脚本（根无此名）：`cd apps/ui; node scripts/build-channel.mjs`。

### 批③ harnessTier 处置（依赖双树裁决，最后做）

- 现状：死键——双树裂痕致宿主 set 面静默清值 + `'harness'` 标签零消费方，实际行为恒缺省 enabled。
- 裁决轨道：`docs/design/session/permission-gate-handoff.md` 遗留项④（宿主注册表聚合 / 键迁移 BUILTIN_KEYS / 整键退役三选）。
- 用户倾向（未最终定）：整键退役（先例已死）——若采纳：删 `packages/ac-harness-tools/src/index.ts` HARNESS_TIER_KEY + registerKey 调用 + disabled 拦截臂 + grants 声明；run_harness 工具保留。
- 批②先做则 grants 字段已删，本批只剩键注册与拦截臂。

**已完成（cr-1094，用户定案整键退役）**：

- 删 `HARNESS_TIER_KEY` 定义 + `ctx.convSettings.registerKey` 调用 + `execute` 的 disabled 拦截臂 + 行头注释的会话开关段；`ConvSettingsKeyDef` import 一并删。
- `inject` 由 `['tools', 'convSettings']` → `['tools']`——行不再依赖会话设置域（可摘除性提升）。
- 测试：删 `tests/activation-order.test.ts`（专测乱序激活下 harnessTier 注册，随键退役失去对象）；`harness-tools.test.ts` 两用例 → 一个「键不再注册 + 行不依赖 convSettings + 工具本体保留」用例。
- `run_harness` 工具保留；会话级禁用改由 Agent 行卸载表达。

## 三、统一目录树（并入批①或独立批，实施前需定案）

用户草图的键目录树：workspace / agent / model（+reasoning_effort）分组 / toolMode / 会话设置分组（browserTier / issueSubmit / approval / harnessTier）。两级形态：分组 → 会话属性 → 可选值。

- workspace / agent 是草稿身份字段（PendingMeta），不进 conv-settings 文件——进树但叶子归宿不同。
- model 需 def 增 `dynamic` 标记（值域从池菜单 RPC 拉）。
- reasoning_effort 现为消息级参数（组合偏好不落盘），进树 = 会话键化 = 行为变化，产品裁决未定。
- 专用控件（模型菜单 / 三档钮 / 二级菜单）收编进统一目录树渲染。

## 四、红线提醒

- 动 `packages/` 必跑 `pnpm typecheck && pnpm test:unit && pnpm check:deps` + 定向 lint。
- 动 ChatInput 前端面加 `pnpm webui:typecheck` + `pnpm build:channel`。
- 每批一个 CR；实施完把契约文档对应节从「目标态」翻「现行实况」。
- grants/isValid 删除波及声明方（ac-conv-settings 的 contract/service 导出面）——先 grep 全部 import 消费再动手，防 typecheck 全仓红。
- 改代码不重启验证 = 白改：本批全在装载行源码内（宿主 ac-conv-settings / ac-host-webui、壳 ac-agents 等行集点名包），运行时验证前按 restart_host / restart_shell 判据重启。
