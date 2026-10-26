# 交接：◐a/◐b 语义批已收口（2026-10-25 晚，cr-692）

> 下会话入口。先加载 agentchat-dev 技能，读 plan.md §5 尾部（cr-692 行）与本文。
> 上游：handoff-2026-10-25-semantics.md（战场地图——本文是其完成态收口）。

## 0. 一句话现状

**◐a/◐b 语义批全落地入库**（cr-692，commit 6a5f4023——**push 被网络阻断**，待恢复后补推）：capabilitySetOf settings 并集合成 + collab settingsOf 直读 + subagent 剥提权面 + AgentConfig tools→rows 全链改名 + 活体 38 config 迁移完。主线 380 文件全绿 + preview **650/650** 全绿。

## 1. 实施记录（与 handoff-semantics 方案的偏差修正）

### 1.1 形状修正（重要——后续消费以此为准）

handoff 设想 `settings.browser.tier` 单值——**实际裁定形状是层级布尔**（ac-import ROW_LEVEL_TAGS cr-540/547 + admin 活体数据双证）：
- `settings.browser.{observe,manipulate,inject}` 布尔（合成时高层连带低层 + web）；
- `settings.collab.admin === true` → admin；
- `settings['dev-tools'].enabled === true` → dev（handoff 漏了 dev——capabilitySetOf 合成面已含）。

### 1.2 ◐a 落地面（7 处）

1. `src/ac-agents/src/service.ts` capabilitySetOf：tags ∪ settings 合成词（**并集语义**——未迁移旧数据回滚线兼容，与 web-tools grants 只升不降同语义；裁决 2 的「双写过渡」需求被并集语义吸收，部署顺序解耦）；
2. `src/ac-collab-tools` hasAdminCapability：settingsOf(id,"collab").admin 直读 + tags 兼容；
3. `src/ac-subagent` deriveAgentConfig：剥 settings.collab.admin（新发现的提权洞——tags 剥 admin 后 settings 继承仍给子 Agent admin）；
4. `src/ac-agent-presets-builtin` CREATOR：dev/admin/browser 全层换轨 settings（tags 清词）；STANDARD 不动（源码面本无 browser）；
5. `src/ac-client-ui-agents/AgentPane.vue`：browser-tier 组 assembly 在场时读写 settings.browser（写 = 层级布尔 + 剔 tags 组内残留；关闭 = 删键）；缺席回落 tags 落词；
6. 新增 `src/ac-agents/tests/capability-settings.test.ts`（3 用例锁合成语义）；
7. 活体迁移：38 agent config 档位词 → settings（16 个需迁，幂等脚本 `preview/sandbox/scripts/migrate-row-level-tags.mjs`，备份 preview/sandbox/backup-2026-10-26/）。

### 1.3 ◐b 落地面（tools→rows 改名）

- **preview**：AgentConfig 契约 + AGENT_CONFIG_FIELDS 白名单 + readAgentConfig 读档归一（旧 tools 键读时归一为 rows，写恒 rows）+ deriveShellRowset 入参 + AgentsShim/toolFaceOf/subagent parentRowset/admin-row 回显/boot 派生 + 模板 4 config + ac-import convertConfig 输出恒 rows；
- **主线软链面**：updateAssembly RPC **双键收讫**（rows 优先、tools 兼容——主线 AgentConfig 契约未改，回滚线不破）；webui AssemblyPatch 协议改 rows（ExtToolsPane onDecl 契约 + useAgentSettings 保存 + AgentPane patchDecl + protocol shims）；
- **活体**：16 config tools→rows 迁移（脚本双步幂等）。

### 1.4 requiredTags 残留（preview 5 活点——全部保留，非本批）

ac-import 注释（迁移逻辑叙事）/ gate.ts 注释（叙事）/ shell-conversation :870-876 + agent-admin-row :79 + admin-preview :28（**主线行包字段透传给 UI**——主线工具定义仍有该字段，随 ◐c 退役批消亡）/ rows-import :103（同透传）。

## 2. 下一步优先序

1. **push 补推**（网络恢复后 `git push`——commit 6a5f4023 在本地）；
2. 宿主重启验证活体行为（产品入口 pnpm dev:supervised；已迁数据在旧代码宿主上并集兼容不炸，重启后新合成生效）；
3. B2 主题包通道（design-plugin-client-channel.md §3：令牌校验纯函数 + 示例主题包）；
4. B3 视角挂载（layout registerView + 隔离档容器承载）；
5. ◐c 退役批（判据「观察」积累 + 用户确认后；R6.1 传递闭包重算）。

## 3. 现场环境（沿用 handoff-2026-10-25-cutover-final.md §4）

- %TEMP% EPERM：vitest 前把 TEMP/TMP 指 preview/sandbox/tmp（前台 + 输出重定向文件）。
- **新坑**：preview:test 长命令本会话三次触发壳崩溃（测试本体完成、收尾阶段崩）——对策：输出先落文件，崩溃后查文件即知已完成；单测与 lint 分开跑。
- workspace/home 双禁：活体迁移走 pwsh（脚本已就位可重跑——幂等）。

## 4. 本会话产出索引

- cr-692（6a5f4023 本地）：◐a/◐b 全批（42 文件，+376/-163）。
- plan.md §5：cr-692 行（全记录）。
- 备份：preview/sandbox/backup-2026-10-26/agents（38 目录）。
- 迁移脚本：preview/sandbox/scripts/migrate-row-level-tags.mjs（◐a 档位 + ◐b 键名双步幂等）。