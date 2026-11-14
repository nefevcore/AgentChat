# 权限门交接（permission-gate-handoff）

> 性质：交接——cr-1066 权限门批 1（1a 契约 / 1b 门行 / 1c 装配）实施完成后的现场快照：已落成面、验证结论、未竟事项与接力入口；批 2 裁撤（cr-1072）与批 3 精确信任面（cr-1074/1075/1076）已回填。
> 状态：现行 · cr-1076 2026-11-14 · 主档 [permission-gate-plan.md](permission-gate-plan.md)（V1-V7 已回填；批 2 裁撤 / 批 3 落地已注记）。
> 读者：后续维护者（开工前通读本文 + 主档；本档是起点索引，不是二次事实源）。**批 1/2/3 全部收口，无未竟实施项**（§三仅剩独立跟进项）。

## 一、当前进度（全部已落地）

| 件 | 状态 | 落点 |
|---|---|---|
| 批 1a 契约：`risk?: (args) => 'allow'\|'ask'\|'deny'` 纯函数建议字段 | ☑ | `packages/ac-tools/src/contract.ts` + `tests/risk-contract.test.ts` |
| 批 1b 门行：决策序 0-5 主门 / 信任面简化版 / 设置链三层 / approval 生产 / run 缓存 / notice 文案 | ☑ | `packages/ac-permission-gate/`（15 用例全绿） |
| 批 1c 装配：shell.yml v6 骨架行 + IMPORTED_ROWS + README + gen | ☑ | `apps/catalog/profile/shell.yml`（v6，66 行）+ `packages/ac-shell-rows/src/index.ts` |
| approval 会话键（内置键非 registerKey） | ☑ | `packages/ac-conv-settings/src/service.ts` BUILTIN_KEYS + `contract.ts` 类型 |
| `tools.getWithOwner`（门取 owner 正路） | ☑ | `packages/ac-tools/src/service.ts` |
| 验证阶梯 | ☑ | typecheck / check:deps / eslint / 全量 `pnpm test` 438 文件 3145 用例绿 |
| 部署 | ☑ | 数据根 122 身份 rebase v6；宿主与壳已重启（活壳 rows=29 含门行） |
| V1-V7 验证目标 | ☑ | 活体：pwsh 弹卡→批准→同轮免问（V1+V2，interactions.jsonl `dur-mwfz5igb`）；其余单测覆盖。V2 缓存命中路径 cr-1071 补同权 full-access 注入（免问 ≠ 降权） |
| 其他 Agent 默认全通行（用户指示） | ☑ | 19 身份写 `agents/<id>/permission-gate.json` = `{"onAsk":"allow"}`（读链端到端核实） |

## 二、关键事实（接手即需，防重新踩坑）

1. **决策序实现在 `packages/ac-permission-gate/src/index.ts` 头注释**——门行为规格以它 + 主档 §二为准。**cr-1070 裁决（用户纠错）**：档位不参与审批决策——cr-1069 曾按旧「sandbox+ 档自由」语义补 4.5 档位免审环，属旧框架回潮，已回滚并以守护测试固化（sandbox/full 档 ask 建议仍走设置链）。access 轴与 approval 轴正交：前者管执行边界（full 跳复检/扫描），后者管 ask 归宿。
2. **实施中三处与主档初稿的偏差**（已回填主档批 1c 注记，勿回潮）：
   - approval 会话键进 conv-settings BUILTIN_KEYS 而非门行 registerKey——壳/宿主分树下垫片注册键宿主 set 面不认识，读写链会静默断（harnessTier 先例正受害）。
   - D7 无人桶（self 桶）判定**先于**设置链——「设置 allow 不豁免」的字面义。
   - 批准 = 变异 `execution.call.access = 'full-access'`（ToolCall.access 合法来源第 3 处）——否则 base 档批准后仍撞工具内沙箱墙。
3. **信任面是批 1 简化版**：owner = 注册 fiber 名，`ac-` 前缀即可信；插件（无前缀）恒 ask。精确信任面（manifest permissions 第 6 词 `risk`）是批 3 的事。
4. **Agent 级设置落盘形态**：`agents/<id>/permission-gate.json` 单元文件（writePluginConfigAt 原子写 / readPluginConfigs 合成读 / settingsOf 两层合成）。层级：会话键 > Agent settings > 行 config 缺省（ask）。
5. **有活体数据可看**：`workspace/home/agents/__creator__/interactions.jsonl` 尾部 `dur-mwfz5igb`（kind=approval, answered, scope=run）——V1/V2 的实证。
6. **`__creator__` 保持缺省 ask**（未写单元文件）——审批链演示/验证口；用户若要全免随时可补。
7. **简化信任面的伪造向量与闭环（cr-1071/1073 侦察 → cr-1074/1075 已修）**：`trusted()` 仅查注册 fiber 名 `ac-` 前缀，而 manifest NAME_RE 不保留 `ac-` 命名空间、动态插件 fiber 名 = 源码 `export const name`（约定非强制，无装配期对账）——第三方插件任取 `ac-xxx` 名即骗过前缀判定，其 risk 自评被采信（恒 allow 直通）。行集护栏只对账行 id（mergeRowsetCatalog），不查 fiber 名。**堵法定级（cr-1073 订正）**：fiber 名是插件源码自选字段（`Plugin.Base.name`——cordis 类型原文「display name used for fiber diagnostics」，可省略、不受任何校验），与 `manifest.name` 相互独立。故 **manifest 层封禁（validatePluginManifest 拒 `ac-` 前缀）堵不住**——恶意包可 manifest 叫 `evil`、fiber 名 `export const name = 'ac-fs-tools'`。**已闭环（cr-1074 + cr-1075 订正）**：① 命名空间规则单源在 `ac-plugin-core`（`isReservedPluginName`——`ac-` / `shell-` 前缀 + `root`），安装期 `validatePluginManifest` 早失败（体验面：用户当场见可诊断错误并改名）；② 装载期硬闸 `plugin-guard.ts` 在 `ctx.plugin(mod)` **之前**校验 **manifest.name 与模块 name 两处**（只查模块名会漏 manifest 叫 `ac-evil` 的冒充——钉死后 fiber 名照样骗过前缀判定），命中即 fail-closed 拒载；③ fiber 名钉死 `manifest.name`（cordis 无名 fiber 继承祖先名，不钉死则 owner 错挂装载行，D11 查授予无稳定键）；④ 门行 `trusted()` 双臂 = 官方 fiber 名 ∪ `riskGranted(owner)`（boot 注入 registry.json 授予快照），不依赖命名约定的正路终态。

## 三、未竟事项（批 2 / 批 3）——均已收口，仅余独立跟进项

主档 §六（原 permission-model 分批映射）未随 cr-1065 重写展开——批 2/3 开工前需先补设计再动码：

| 批 | 内容 | 状态 |
|---|---|---|
| 批 2 | ~~accessCapsOf~~ 已裁撤（cr-1072）：概念源出已删旧框架，代码零残留；access 轴执行边界职责由 effectiveAccessOfCall（ac-agents 单源，fs-search/fs-tools/str-replace-editor/shell-tools 四行消费）承担；cr-1070 裁决档位不参与审批——无未满足需求 | ☑ 已裁撤 |
| 批 3 | 精确信任面 D11：permissions 第 6 词 `risk`（REVIEW 面人审授予）+ 装载边界硬闸 + fiber 名钉死 + 门行 grants 查询 | ☑ 已实施（cr-1074）——详见 cr-1074 日志 |
| 批 3 补丁 | 去包内循环依赖（guard 不 import 包索引，改前缀规则）+ 命名空间规则单源化到 ac-plugin-core（安装期 + 装载期双检）+ 补 manifest.name 冒充校验 | ☑ 已实施（cr-1075）——详见 cr-1075 日志 |
| 批 3 文档 | 插件技能（模板 + __creator__ 物化副本）同步：permissions 词表增 risk + manifest name 禁占官方命名空间 | ☑ 已实施（cr-1076） |
| 跟进 | harnessTier 键宿主侧设不进的既有 bug（垫片注册键宿主 set 面不认）——是否照 approval 内置键先例修 | ☐ 待用户裁决 |

## 四、接力入口

1. 读主档 `permission-gate-plan.md`（V1-V7 回填 + 批 3 精确信任面段）+ 本档 §二。
2. 读门行源码 `packages/ac-permission-gate/src/index.ts`（约 215 行，头注释即行为规格）与 `tests/gate.test.ts`（21 用例 = 决策序全分支 + D11 信任面双臂 + cr-1070 守护 + run 缓存同权锚）。
3. 读精确信任面三件：`packages/ac-plugin-core/src/manifest.ts`（第 6 词 risk + 命名空间保留谓词）、`packages/ac-shell-rows/src/plugin-guard.ts`（装载边界硬闸）、`apps/shell/boot.ts` 的 `makeRiskGranted`（授予快照查询注入）。
4. 后续开工：按 CR 红线先 `node cr/cr.mjs append` 登记再动码；设计问题回溯 `cr/logs/cr-1061/1062/1063/1065/1066/1073/1074/1075.md` 决策轨迹。
5. 改动装载行源码后的生效环：壳侧（shell.yml 点名包）→ `restart_shell`；宿主侧 → `restart_host`；只改码不跑无需重启。
