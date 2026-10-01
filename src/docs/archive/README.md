# docs/archive —— 收官里程碑过程档案

> **归档策略（2026-09-18 · M30 收官后整理；2026-09-18 扩容至仓库外归档根；2026-10-01 cr-79 根目录完结批次收编）**：里程碑
> 过程文档（计划/评审/交接/复审/审计/清点）在其实施收口后移入本目录或仓库外归档根
> `C:\Users\xiaofeng\Documents\Dev\Note\AgentChat\docs-stale-2026-09-18\src-docs\`
> （M7-M25 终稿、对账套件、WebUI 适配器系列、程序化模式三件套、审计双档），
> **内容原样冻结**——它们是决策轨迹与踩坑实录（含被后续里程碑取代的裁决），
> 不随代码演进更新。动手前要查的是**现行事实源**，不是本目录：

| 现行事实源（在 `src/docs/` 根） | 职责 |
|---|---|
| `../ui-rows-and-slots.md` | 行/席对照册（域行 ↔ 席位 ↔ 贡献，随代码同步） |
| `../webui-slot-tree.md` | 调研树 + 实施状态注记（头部对照块随里程碑更新） |
| `../m30-slot-semantics-refinement-plan.md` | 席位语义收口裁决（elect/data 轴、D6 装饰批次容器裁决、D8 不做项与翻盘条件——P2 批次开工前必读） |
| `../webui-plugin-ownership.md` | 资产归属原案（物理落点已被 D19 改裁为行包 client/ 半边） |
| `../session-design.md` | Session 域目标设计（消息定义/落盘/三种会话形态） |

## 本目录索引

| 文档 | 类型 | 收官状态 | 备注 |
|---|---|---|---|

### WebUI 域（M27-M30）

| 文档 | 类型 | 收官状态 | 备注 |
|---|---|---|---|
| `m27-webui-slot-refactor-plan.md` | 计划（v2.3 终版） | M27 S0-S4 + M27.1/M27.2 全部收口 | hostLedger → M27.2-1 owning 件自声明；BUILTIN_SLOTS → M30 D7 退役；keyed/数据席位 → M30 D1/D2 elect/data 轴 |
| `m27-webui-slot-refactor-plan-review.md` | 首轮评审实录 | 修订已折叠进计划 v2 | — |
| `m27-webui-slot-refactor-plan-review2.md` | 二轮评审实录（对 v2.1） | 修订已折叠进计划 v2.2/v2.3 | — |
| `m27-handoff.md` | M27.1/M27.2 交接实录 | M27 关闭 | §4 后置清单已被 M28 计划 §9 收编 |
| `m28-ui-plugin-tree-plan.md` | 计划 + §10 进度实录 | M28 P0-P3 + §4.2 深批全部落地（2026-11-08） | 席位/行现状以 `../ui-rows-and-slots.md` 为准 |
| `m28-handoff.md` | §4.2 深批交接 | 同日收口，本文全程只读存档 | — |
| `m29-row-dep-hygiene-plan.md` | 计划（复审 F1-F5 收编） | 已全部实施（M29 关闭） | 守卫现况见 `scripts/check-deps.mjs` + `scripts/dep-cycles.yml` |
| `ui-rows-and-slots-review.md` | M28 后架构复审实录 | F1-F5 已被 M29 全部消化 | 行号级证据对拍基准 = 2026-11-08 快照，勿按本文直接对拍当前代码 |
| `conversation-view-split-plan.md` | 计划 | 已实施（2026-09-24 同日四动作落地） | ConversationView 762→258 行组合壳 |
| `webui-koishi-console-research.md` | 调研 | 已收官（root 即 slot 生态实证） | M27 参照系增补 |
| `m24-m25-ui-prototype.html` | 原型稿 | 目录 IA 已落地 | — |
| `ask-questions-suspension-plan.md` | 计划 | 挂起形态已实施 | ask_questions 发起即返 + 事件驱动恢复 |

### 远程接入与移动端（M1/M3 批次）

| 文档 | 类型 | 收官状态 | 备注 |
|---|---|---|---|
| `m1-remote-link-implementation-plan.md` | 计划 | M1/P0/P1 已实施（含已修复缺陷清单） | 总方案见根 `remote-client-relay-plan.md` |
| `m3-handoff-20260929.md` | 交接实录 | cr-43~54 移动端批收口于 2026-09-30 | — |
| `m3-realdevice-handoff-20260928.md` | 交接单（2026-09-28 真机轮） | 同轮收口 | 自 `.dsh/tmp` 收编（cr-79） |
| `m3-realdevice-checklist.md` | 验证实况 | Redmi K20 轮收口 | 模拟器掩盖的三处致命缺陷当轮修复（cr-13/14/15） |
| `m31-android-transport-implementation.md` | 实施实况 | M3.1 收口 | Kotlin Noise 模块 + relay 全链路 |
| `m32-android-loopback-bridge.md` | 实施实况 | M3.2 收口 | 回环桥 + WebView 面（4 处链路根因修复） |
| `m33-android-pairing-implementation.md` | 实施实况 | M3.3 收口 | 真机配对 + Keystore 身份（7 处真机缺陷） |
| `m34-http-proxy-and-reconnect.md` | 实施实况 | M3.4 收口 | 通用 HTTP 代理 + 断线自动重连 |
| `m35-self-hosted-distribution.md` | 实施实况 | M3.5 收口 | APK 自托管分发 + 版本更新提醒 |

### 安全审计

| 文档 | 类型 | 收官状态 | 备注 |
|---|---|---|---|
| `relay-security-audit-2026-10-01.md` | 审计报告（第一轮·代码面） | F-1~F-8 已修（cr-77） | F-5/F-7 维持现状裁决留档 |
| `relay-security-audit-round2-2026-10-01.md` | 审计报告（第二轮·PC 入侵链路） | R-1/R-2 已修（cr-77） | HTTPS/代码签名为部署成本项 |
| `relay-security-poc-2026-10-17.md` | 实战 PoC 审计（7 个 PoC 审计验证） | P0 KK 降级已修（cr-64 真 KK + responder 公钥校验）；P1/P2 与 cr-77 修复面重叠 | 自 `.dsh/tmp` 收编（cr-79） |

### LLM 与系统提示词域

| 文档 | 类型 | 收官状态 | 备注 |
|---|---|---|---|
| `llm-protocol-extensibility.md` | 设计备忘 | 已实施（cr-39） | 目标形态按原文落地 |
| `llm-provider-model-plan.md` | 调研与变更方案 | 已实施（P1-P7，2026-09-01） | 池 v2 + name@model |
| `multimodal-vision-input.md` | 实施档案 | M1-M4 已实施 | attachments 引用旁挂 + provider 边界物化 |
| `system-prompt-optimization-plan.md` | 优化方案 | 已实施（v3，P1-P4） | 三源融合 |
| `system-prompt-assembled-example.md` | 装配示例 | 已实施（v3 实装形态） | — |

### 记忆与治理

| 文档 | 类型 | 收官状态 | 备注 |
|---|---|---|---|
| `memory-timeline-plan.md` | 设计与裁决 | 已实施（cr-4，2026-09-27） | 两处落地偏差已在头部标注 |
| `memory-timeline-handover.md` | 施工交接 | 已收口 | 实施汇总/验证/生产迁移实况 |
| `security-access-tier-plan.md` | 重设计方案 | 已实施（2026-09-13） | 访问档位 + 双轴门禁 |
| `session-audit-backlog-2026-09-22.md` | 审查报告 | 三轮处置收口 | ac-session/subagent 精简轮 |
| `edit-tool-incident-report.md` | 事故分析报告 | 护栏已落地 | P0 匹配语义收口 |
| `patch-layer-hardening-plan.md` | 加固计划 | 已实施（cr-11） | Patch 层三面加固 |
| `sap-adt-config-layer-bug.md` | Bug 分析 | 已修复（2026-09-04） | 方向 A：对齐 mcp 语义 |

### 工程规范

| 文档 | 类型 | 收官状态 | 备注 |
|---|---|---|---|
| `epoch-inventory-2026-09-27.md` | 日期清点底册 | cr-1 整改配套，一次性产物 | 历史批次标记的事实底册 |

## 阅读须知

- 本目录文档中的行号、包体量、席位清单、路径均为**快照时点值**；其中相互
  引用（同目录文件名）仍可解析，指向根目录文档的相对位置已变为 `../`。
- 「勿\"顺手恢复\"显式接受的缩水」的纪律对本目录同样适用——被取代的
  裁决（如 hostLedger、BUILTIN_SLOTS）**不是**待办。
- 日期在文件名中的文档（如 `relay-security-audit-2026-10-01.md`）保持原名，
  归档不改名（epoch 规约：文件名日期是标识符）。
