# docs/archive —— 收官里程碑过程档案

> **归档策略（2026-11 · M30 收官后整理；2026-12 扩容至仓库外归档根）**：里程碑
> 过程文档（计划/评审/交接/复审）在其实施收口后移入本目录或仓库外归档根
> `C:\Users\xiaofeng\Documents\Dev\Note\AgentChat\docs-stale-2026-12\src-docs\`
> （M7-M25 终稿、对账套件、WebUI 适配器系列、程序化模式三件套、审计双档），
> **内容原样冻结**——它们是决策轨迹与踩坑实录（含被后续里程碑取代的裁决），
> 不随代码演进更新。动手前要查的是**现行事实源**，不是本目录：

| 现行事实源（在 `docs/` 根） | 职责 |
|---|---|
| `../ui-rows-and-slots.md` | 行/席对照册（域行 ↔ 席位 ↔ 贡献，随代码同步） |
| `../webui-slot-tree.md` | 调研树 + 实施状态注记（头部对照块随里程碑更新） |
| `../m30-slot-semantics-refinement-plan.md` | 席位语义收口裁决（elect/data 轴、D6 装饰批次容器裁决、D8 不做项与翻盘条件——P2 批次开工前必读） |
| `../webui-plugin-ownership.md` | 资产归属原案（物理落点已被 D19 改裁为行包 client/ 半边） |

## 本目录索引

| 文档 | 类型 | 收官状态 | 后继去向 |
|---|---|---|---|
| `m27-webui-slot-refactor-plan.md` | 计划（v2.3 终版） | M27 S0-S4 + M27.1/M27.2 全部收口 | hostLedger → M27.2-1 owning 件自声明；BUILTIN_SLOTS 服务端白名单 → M30 D7 退役；keyed/数据席位 → M30 D1/D2 elect/data 轴 |
| `m27-webui-slot-refactor-plan-review.md` | 首轮评审实录 | 修订已折叠进计划 v2 | — |
| `m27-webui-slot-refactor-plan-review2.md` | 二轮评审实录（对 v2.1） | 修订已折叠进计划 v2.2/v2.3 | — |
| `m27-handoff.md` | M27.1/M27.2 交接实录 | M27 关闭 | §4 后置清单已被 M28 计划 §9 收编 |
| `m28-ui-plugin-tree-plan.md` | 计划 + §10 进度实录 | M28 P0-P3 + §4.2 深批全部落地（2026-11-08） | 席位/行现状以 `../ui-rows-and-slots.md` 为准 |
| `m28-handoff.md` | §4.2 深批交接 | 同日收口，本文全程只读存档 | — |
| `m29-row-dep-hygiene-plan.md` | 计划（复审 F1-F5 收编） | 已全部实施（M29 关闭） | 守卫现况见 `scripts/check-deps.mjs` + `scripts/dep-cycles.yml` |
| `ui-rows-and-slots-review.md` | M28 后架构复审实录 | F1-F5 已被 M29 全部消化 | 行号级证据对拍基准 = 2026-11-08 快照，勿按本文直接对拍当前代码 |

## 阅读须知

- 本目录文档中的行号、包体量、席位清单、`docs/…` 路径均为**快照时点
  值**；其中相互引用（同目录文件名）仍可解析，指向根目录文档的相对
  位置已变为 `../`。
- 「勿"顺手恢复"显式接受的缩水」的纪律对本目录同样适用——被取代的
  裁决（如 hostLedger、BUILTIN_SLOTS）**不是**待办。
