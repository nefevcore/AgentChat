# 缺口待修清单（gap-backlog）

> 来源：2026-10-14 全仓代码注释/文档字面搜索「缺口」（47 处：src 40 + mobile 5 +
> CHANGELOG 2），逐项核实当前状态后的**开放项**清单。排除范围：`.dsh/tmp/`（外部
> 项目快照）、`workspace/`（会话数据落盘）。已核实剔除的闭环项见文末附录。
> 状态标记：☐ 开放待修 / ◐ 部分完成 / ☑ 已修但文档滞后（顺手修文档即可）。

## 一、开放缺口（按建议修复顺序）

### 1. ☐ 协议写死 OpenAI 兼容——非兼容端点无法经池配置〔大缺口〕

- **出处**：`src/docs/llm-protocol-extensibility.md` L25（本文档主题）
- **内容**：协议层 `ac-openai-completions` 是唯一协议实现，Anthropic 原生
  `/v1/messages`、Gemini 原生 `generateContent`、Ollama 原生 `/api/chat` 等
  非兼容端点无法经 `ac-llm-pool` 配置，只能走 `templates/provider-row` 手写
  适配行（每协议一个）。
- **核实**：`src/**/*anthropic*` 零命中——至今无第二协议实现。
- **建议起点**：该文档 §设计草案（协议中立抽象 + 适配行形态）已较完整，可按
  文档直接立项。

### 2. ☐ 按 source 降档——Agent 间唆使链路无硬边界〔安全〕

- **出处**：`src/docs/security-access-tier-plan.md` L55 / L292 / L416 / L448
- **内容**：full 档 Agent 被 source='agent' 消息触发的 run 应降档执行——当前
  只有 prompt 级软缓解（run 边界注入防御提示词），无硬边界。系统整体强度 =
  可达 Agent 最高档；`send_agent` 无 requiredTags，任何 Agent 可联系任何 Agent。
- **核实**：文档 §十 明确「延期」；grep 确认降档逻辑未实现。
- **seam 现成**：`router/before-deliver` / `loop/before-run`（文档 L55 已指出）。
- **注意**：§8.3 表中「prompt 级防御可被话术绕过」为显式接受项，非本条待修。

### 3. ☐ /models 发现仍是假代理——AgentPane「读取」按钮静态并集

- **出处**：`src/docs/llm-provider-model-plan.md` §1.5（L89-95）
- **内容**：AgentPane「读取」按钮注释宣称「走后端代理，从凭据库附加认证」，
  实际 `llm/providers` RPC（`ac-web-api/src/index.ts` L1684）返回**静态
  meta.models 并集**——假代理（M17 缩水项，从未补）。
- **核实**：协议层 `ac-openai-completions` `listModels()` 已实现（带
  `tests/list-models.test.ts`）；缺的是 web-api 侧经真实端点发现模型。
- **提醒**：plan 文档 §1.5「listModels 不存在」表述已过时——修此项时顺手更新。

### 4. ☐ 机制 run steer 拦截全类型覆盖审计

- **出处**：`src/ac-archive/tests/archive.integration.test.ts` L521（回归锁定）+
  `feed-core.ts` L187（认知缺口修复留档）
- **内容**：archive 整理 run 的 steer 拦截已修并带回归用例（2026-09-04）；但
  「机制 run（source='event'）进行中用户消息不得 steer 进机制 run」是否覆盖
  其他机制 run 类型待审计。
- **动作**：审计 ac-session deliver 侧对 source='event' run 的 steer 拦截是否
  全类型覆盖；有漏则补，无漏则关闭并在此登记。

### 5. ☐ 真机 WebView 兼容缺口残余（mobile 三份 legacy-runtime 副本）

- **出处**：`mobile/app/www/legacy-runtime.js` L5、
  `mobile/app/android/.../assets/public/legacy-runtime.js` L5、
  `src/webui/public/legacy-runtime.js` L5
- **内容**：模拟器/桌面 Chromium 版本更新长期掩盖旧 WebView 缺口（M3 真机
  §1.1 暴露）；三份副本同源（构建投递），本体在 `src/webui/public/`。
- **动作**：对目标真机 WebView 版本跑 `m3-realdevice-checklist.md` §1.1 核验；
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
| A | `llm-protocol-extensibility.md` | 小缺口 headers/timeoutMs 已标落地；大缺口描述与 §D3 行口径需复查统一 | L19-24 落地标注 |
| B | `llm-provider-model-plan.md` §1.5 | 「ac-openai-completions 无 listModels()」已过时——协议层已实现并带测试 | `ac-openai-completions/src/index.ts` L421 |
| C | `llm-provider-model-plan.md` L82 | 「provider 跟随 Agent 不跟覆盖」已修——router 支持 `name@model` 拆 provider | `ac-router/src/service.ts` L58-59/L185 |

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
> 引用以 cr-log 序列为准）。
>
> 维护约定：每修一项，把对应条目改为 ☑ 并注明 cr 号与日期；全部闭环后本文件
> 可归档至 archive/。
