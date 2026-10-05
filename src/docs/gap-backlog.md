# 缺口待修清单（gap-backlog）

> 来源：2026-10-14 全仓代码注释/文档字面搜索「缺口」（47 处：src 40 + mobile 5 +
> CHANGELOG 2），逐项核实当前状态后的**开放项**清单。排除范围：`sandbox/`（Agent
> 沙箱：临时工作区/测试数据根/工具链）、`workspace/`（会话数据落盘）。已核实剔除的闭环项见文末附录。
> 状态标记：☐ 开放待修 / ◐ 部分完成 / ☑ 已修但文档滞后（顺手修文档即可）。

## 一、开放缺口（按建议修复顺序）

### 1. ☑ 协议多态已落地（cr-39，2026-10-01 复核核销）

- **原缺口**：协议层 `ac-openai-completions` 是唯一协议实现，非兼容端点无法经
  `ac-llm-pool` 配置。
- **现状**：`ac-anthropic-completions`（/v1/messages）· `ac-gemini-completions`
  （generateContent）· `ac-ollama-completions`（/api/chat）三纯库已落地；池条目
  `protocol` 字段分发（'openai' | 'anthropic' | 'gemini' | 'ollama'，PROTOCOLS
  单源），llm-pool 协议注册表见 `src/ac-llm-pool/src/index.ts` 头注释。
- **出处**：`src/docs/archive/llm-protocol-extensibility.md`（设计草案已实施）。

### 2. ☐ 按 source 降档——Agent 间唆使链路无硬边界〔安全〕

- **出处**：`src/docs/archive/security-access-tier-plan.md` L55 / L292 / L416 / L448
- **内容**：full 档 Agent 被 source='agent' 消息触发的 run 应降档执行——当前
  只有 prompt 级软缓解（run 边界注入防御提示词），无硬边界。系统整体强度 =
  可达 Agent 最高档；`send_agent` 无 requiredTags，任何 Agent 可联系任何 Agent。
- **核实**：文档 §十 明确「延期」；grep 确认降档逻辑未实现。
- **seam 现成**：`router/before-deliver` / `loop/before-run`（文档 L55 已指出）。
- **注意**：§8.3 表中「prompt 级防御可被话术绕过」为显式接受项，非本条待修。

### 3. ☑ /models 真代理已落地（2026-10-05 复核核销）

- **原缺口**：`llm/providers` RPC 返回静态 meta.models 并集（M17 缩水项）。
- **现状**：`llm/models` RPC（`ac-web-api/src/index.ts` L1824 起）经 provider
  实例真实代理 /models——凭据从凭据库锚定 `pool:<name>` 附加、20s 探测超时、
  发现结果归一回写 `config.llmProviders[name].models` 缓存并热更重挂；AgentPane
  「读取」按钮已退役，改**自动读取**（无缓存才拉、每连接一次防抖——见
  AgentPane.vue L201 起；ChatInput ensureDiscovered 同款）。

### 4. ☐ 机制 run steer 拦截全类型覆盖审计

- **出处**：`src/ac-archive/tests/archive.integration.test.ts` L521（回归锁定）+
  `feed-core.ts` L187（认知缺口修复留档）
- **内容**：archive 整理 run 的 steer 拦截已修并带回归用例（2026-09-04）；但
  「机制 run（source='event'）进行中用户消息不得 steer 进机制 run」是否覆盖
  其他机制 run 类型待审计。
- **动作**：审计 ac-session deliver 侧对 source='event' run 的 steer 拦截是否
  全类型覆盖；有漏则补，无漏则关闭并在此登记。
- **2026-10-05 复核注记**：拦截判定单源 = `isArchiveReviewRun(meta)`
  （ac-agent-loop service.ts L171——见 meta 标记即跳过）；设置面现有两处：
  ac-archive（整理 run）与 ac-bench（bench-case run，service.ts L172）。源头上
  设标记的机制 run 已被两门（deliver steer 门 L483 + steerQueued 门 L649，
  ac-conversation）覆盖；**审计缺口收窄为**：其余 source='event' 发起但不设
  ARCHIVE_REVIEW_META 的 run（若有）是否需要同款拦截——grep `source: 'event'`
  逐处核对设置面即可关闭。

### 5. ☐ 真机 WebView 兼容缺口残余（mobile 三份 legacy-runtime 副本）

- **出处**：`mobile/app/www/legacy-runtime.js` L5、
  `mobile/app/android/.../assets/public/legacy-runtime.js` L5、
  `src/webui/public/legacy-runtime.js` L5
- **内容**：模拟器/桌面 Chromium 版本更新长期掩盖旧 WebView 缺口（M3 真机
  §1.1 暴露）；三份副本同源（构建投递），本体在 `src/webui/public/`。
- **动作**：对目标真机 WebView 版本跑 `archive/m3-realdevice-checklist.md` §1.1 核验；
  对照 MDN/Chrome 状态更新垫片覆盖面（如 `Object.hasOwn`、`structuredClone`、
  `Array.prototype.at` 等按真机版本裁剪）。

### 6. ☐ 模板串转义税——方向一重量部分（传输层根治）未做

- **出处**：`src/docs/run-code-hardening-backlog.md` 立项②（L42 起）——「已落地
  （部分）」：方向二 SDK 投影纪律行 + 方向一轻量版（hintSyntaxRecovery）已落地，
  **重量部分未做**。
- **内容**：嵌套模板串在传输层被转义破坏，edit 反复失败迫使走「代码进 lib
  函数体」旁路；根治 = 消除模板串传输层的形状假设。
- **关联事故**：run_code worker 死锁事故的连锁因素②（backlog 事故实录）。

## 二、文档滞后项（☑ 代码已修，顺手更文档）

| # | 文档 | 滞后内容 | 核实依据 |
|---|---|---|---|
| A | `archive/llm-protocol-extensibility.md` | ☑ 已核销（2026-10-05，cr-267）：大缺口（协议多态）随 cr-39 落地——见一、节第 1 项 | `ac-anthropic-completions` 等三纯库 |
| B | `archive/llm-provider-model-plan.md` §1.5 | ☑ 已核销（2026-10-05，cr-267）：listModels 已实装 + web-api 侧 `llm/models` 真代理——见一、节第 3 项 | `ac-web-api/src/index.ts` L1824 |
| C | `archive/llm-provider-model-plan.md` L82 | ☑ 已核销（2026-10-05，cr-267）：「provider 跟随 Agent 不跟覆盖」已修——router 支持 `name@model` 拆 provider | `ac-router/src/service.ts` L58-59/L185 |

## 附录：核实后剔除的闭环项（修复时不必再看）

- run_code dev worker 回退（backlog 立项①）——2026-09-21 落地（快照链 + 
  `bootDegraded` 告警，`ac-run-code/src/tool.ts` L456）。
- m32 白屏四处真实缺陷——文档自标「全部修复」。
- m28 UI 插件树三个 P0 缺口——存档标注「已全部实施（2026-11-08 收口）」。
- 「地图 §3.4」工具行五件套（突变队列/预算截断/遍历统一/str_replace 串行/
  text-budget）——注释均为「已收敛」留档形态。
- M3.x 真机系列（X25519/LoopbackBridge/deviceId 信令/loopback 绕过）——均已闭环。
- ac-subagent journal append 失败窗口、ac-workspace M11、ac-web-api 映射、
  ac-app bootDist 迁移、feed-core 历史对账、webui 可见性恢复——均已闭环（注释留档）。

> 本清单的变更登记 = cr-log `cr-23`（首登时误取号 cr-31，随 cr-24 勘误改号；
> 引用以 cr-log 序列为准）。2026-10-05 复核批登记 = `cr-267`（第 1/3 项核销、
> 第 4 项补判定面注记、滞后表 A/B/C 三行核销）。
>
> 维护约定：每修一项，把对应条目改为 ☑ 并注明 cr 号与日期；全部闭环后本文件
> 可归档至 archive/。
