# RPC 过渡实现审计（preview 时代残留清点）

> 性质：审计报告 + 待办清单（供逐项处理，非已完成记录）。
> 基线：commit `2f397a95`（2026-10-26）；审计日期 2026-10-27；登记 cr-715。
> 背景：preview 轨 RPC 面经 cr-567/576/582 等批次收编为宿主直读实现；cr-703 全仓重组删除旧主线 `src/`（含 `src/ac-web-api` 大 RPC 面）后，**preview 轨即现主线**。
> 审计口径：前端调用面（`ac-client-ui-*`/`apps/ui` 全部 `rpc.call(…)` 字面量，86 方法）× 后端注册面（全部 `registerRpc`，123 方法）全量对账 + 实现体逐个核验。
>
> 待复核（2026-10-27 审查）：审计口径疑似漏 2 条前端死链——`llm/pool-references`（`packages/ac-client-ui-llm-pool/client/poolApi.ts:44`）与 `llm/probe-vision`（同文件 `:74`），全仓未见对应 `registerRpc`。暂列「待复核」，未并入 A 类清单；见 Note 归档根 `docs-review-2026-10-27/findings-F-misc.md`（疑点 R-A）。

## 总览

| 类 | 数量 | 性质 | 优先级 |
|---|---|---|---|
| A. 前端死链（调用无注册） | 6 方法 | **功能缺陷**——旧主线 `src/ac-web-api` 有、新宿主未移植、前端留软兜底或无兜底 | P0/P1 |
| B. 后端空桩（注册返回空） | 3 方法 | 自认待接入的占位 | P1/P2 |
| C. fail-loud 错位（占位合法、前端未换面） | 8 方法 | 语义终态 vs 旧 UI 残留 | P0（换面） |
| D. 逻辑级过渡（近似判定） | 1 处 | 注释前提已过时、算法可升级 | P2 |
| E. 注释级 stale（主线/preview 词汇失义） | ~28 文件 | 可读性债务 | P2 |

---

## A. 前端死链——调用发了，后端没有（6 条）

共同根因：这些方法在**已删除的旧主线** `src/ac-web-api/src/index.ts`（97 个 registerRpc，见 file-snapshots 存档）真实存在，cr-703 重组时新宿主 `ac-host-webui`（web-api.ts + face-ops.ts + face-shell.ts）只移植了主线方法集的子集，前端消费代码未同步裁剪。其中三个包的头注释（`ac-event-policy`、`ac-extension-core`、`ac-client-ui-settings/api.ts`）仍声称「RPC 由 ac-web-api 注册/聚合」——指向已不存在的行。

| # | 方法 | 前端调用点 | 兜底 | 实际后果 | 处置建议 |
|---|---|---|---|---|---|
| A1 | `plugin/loaded` | `ac-client-ui-plugin-registry/client/pluginApi.ts:43`（getCatalog 五源合成之一）、`:298`（getSessionPlugins） | **无**（getCatalog 的 Promise.all 整体 reject） | 插件面板「工具/扩展目录」视图恒空、会话插件区恒空 | P0：目录合成改 `plugin/catalog` 单源；会话插件改壳内 plugin-dev 面或补注册 |
| A2 | `system/restart` | `ac-client-ui-settings/client/useSettings.ts:97`（SettingsPanel.vue:168 重启按钮） | `.catch(()=>undefined)` fire-and-forget | **重启按钮静默无效** | P0：注册真实现（宿主 graceful 重启语义已有——restart_host 同源）或摘除按钮 |
| A3 | `events/policy-list` | `ac-client-ui-settings/client/api.ts:286` | `.catch` 空对象 | 治理停用集视图恒空（写面 policy-set 真实存在，读不回来） | P1：补读面透传（EventPolicyService 已有状态，一行直通） |
| A4 | `plugin/dep-graph` | pluginApi.ts:367 | `.catch` 空 | 反依赖图恒空（注释自认「旧后端无此面 → 容忍为空」） | P1：补注册（ac-rowset-core 有 requires 闭包数据）或前端裁剪 |
| A5 | `plugin/dev-scan` | pluginApi.ts:152 | `.catch` 空 | dev 插件扫描区恒空 | P2：随目录面重构一并处置 |
| A6 | `plugin/extension-catalog` | pluginApi.ts:49 | `.catch` 空 | 扩展配置弹窗数据源恒空 | P2：补聚合注册（`ac-extension-core` 声明扫描机制已就位——各行包 `export const extension: ExtensionMeta` 自述都在）或裁剪 |

## B. 后端空桩——注册了但返回空（3 条）

均在 `packages/ac-host-webui/src/face-ops.ts`，注释自认待接入：

| # | 方法 | 位置 | 声明的原因 | 处置建议 |
|---|---|---|---|---|
| B1 | `events/listeners` | :334 | 「宿主侧不做行包自述聚合——待**事件目录数据化**批接入，避免半真数据」 | P1：与 A3/A6 合并为「事件/扩展目录数据化」一批——扫描 `runtime.callback.extension` + EventPolicyService aggregate.ts（`computeRowAglegates` 已导出但零消费方） |
| B2 | `events/descriptions` | :335 | 同上 | 同上 |
| B3 | `tags/catalog` | :156 | tag 机制已解体（恒 `{tags: []}`） | P2：与前端消费面一并退役——`ac-client-ui-agents/client/rosterApi.ts:225`（调用+TagCatalogItem 词汇）、`AgentPane.vue:362`（兜底注释） |

## C. fail-loud 错位——后端是终态裁决，前端还挂旧 UI（8 方法）

`face-ops.ts:488-498`：`plugin/load`、`plugin/unload`、`plugin/patch-{list,set,reset}` 注册为可读原因的 fail-loud 占位——R0a「宿主不装载第三方代码」+ patch 机制退役（cr-485）**占位本身是合法终态**。错位在前端：

- `PluginLibraryPane.vue:251`（行停用开关）、`:393`（卸载装载）、`:697`（还原出厂/最小集）等 7 个 UI 动作仍调这些必错端点——用户点了只得到报错 toast。
- 替代新面 `rows/list|set|reset`（`plugin-registry-row.ts:625-633`，cr-543 急救面，写偏好文件恒冷生效）**已落地但零生产前端消费方**（仅测试调用）。
- P0 处置：前端动作切换到 `rows/*`；会话级装卸切壳内 plugin-dev 工具面（register_plugin 三件套）；`pluginApi.ts` 的 patch 三函数（getPatchList/setPluginPatch/resetPluginPatches）与 pane 的 patch 状态机整体退役。

## D. 逻辑级过渡——timers-row 近似判定（1 处）

`packages/ac-host-rows/src/timers-row.ts:489,555-565`：目标会话存活判定用「扫 `agents/*/sessions/<cid>` 目录存在性」近似，注释前提「preview 形态无 singles/group 注册表」**已过时**——singles-row（cr-566，`viewer/sessions/<sid>/session.json` 单写者）与 groups-row（cr-576，`groups/<gid>/group.json`）就在同一包。

- 现状行为偏差（已知）：archived 会话不被拦截（近似判活返回 true），提醒会继续投递到已归档会话。
- 处置建议（P2）：改为查 singles-row 的 session.json status / groups 配置真值；最低限度先修正注释前提。

## E. 注释级 stale——主线/preview 双轨词汇失义（~28 文件）

cr-703 已删旧主线，但文件头仍大量写「src X 的 preview 形态」「主线终态 = …cutover 收编本文件」，指向不存在的路径（如 `apps/ui/src/api/wire.ts`、`apps/ui/src/runtime/rpcClient.ts`），误导读者以为还有 cutover 待做。重灾区：

- `apps/ui/client/{rpc-wire,rpc-host,main}.ts`、`apps/ui/src/isolated.ts`、`apps/ui/vite.config.ts`
- `packages/ac-host-webui/src/web-api.ts`（「主线 ac-web-api 行硬 inject 18 服务」叙事）
- `packages/ac-{ws-protocol,ws-bridge,webui,web-server,web-tools,workspace}/src/index.ts`（「地图 §3.2/§3.3/§3.4 落点」——地图即 docs/cutover/spec，已冻结）
- `packages/ac-{agents,ledger,shell-rows,host-rows(timers-row),post-office,webui-core}` 的「src X 的 preview 形态」头注
- `packages/ac-event-policy/src/index.ts:7`、`packages/ac-extension-core/src/index.ts:6`（「RPC 由 ac-web-api 注册/聚合」——该行已不存在）

处置建议（P2）：攒一个 docs/cleanup 小批统一改写为单轨口径（「即本实现」或直接删对比叙事）；`8.5b/c/d/e`、`M8.x`、`cr-5xx` 等历史锚点保留（有 CR 可查）但删除「待 cutover」类未来时表述。

---

## 附：核验方法与数据

- 对账脚本口径：前端 `.call(<q>…</q>)` 字面量（ac-client-ui-* 43 包 + apps/ui）vs 后端 `registerRpc` 字面量（packages + apps）。
- 前端 86 调用方法 / 后端 123 注册方法；孤儿（调用无注册）6：`plugin/loaded`、`plugin/dev-scan`、`plugin/extension-catalog`、`plugin/dep-graph`、`events/policy-list`、`system/restart`。
- 旧主线面快照（file-snapshots 存档路径，含 97 个 registerRpc 的 index.ts）：`workspace/home-legacy-20261022/file-snapshots/fd9ee53f-…/src%5Cac-web-api%5Csrc%5Cindex.ts`。
- 事件面既有积木（零消费方、待接线）：`ac-event-policy/src/aggregate.ts`（computeRowAggregates / rowOfFiber）、各包 `export const extension: ExtensionMeta` 自述（ac-extension-core 契约）。
- `rows/*` 急救面测试锁：`ac-host-rows/tests/plugin-registry-row.test.ts:235-255`。