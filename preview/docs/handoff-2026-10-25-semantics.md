# 交接：◐a/◐b 语义批实施（2026-10-25 晚，cr-690 会话续）

> 下会话入口。先加载 agentchat-dev 技能，读 plan.md §5 尾部（cr-690/691 行）与本文。
> 上游：handoff-2026-10-25-cutover-final.md（三裁决背景）+ design-plugin-client-channel.md（B2-B4）。

## 0. 一句话现状

**三项用户裁决已落定**（dur-mvnn0fft，2026-10-25）：◐a = settings X1 单源；◐b = requiredTags 迁移 + tools→rows 同批改名；◐c = 通道包迁出与退役同批（行动在退役批，现在不动）。**B1 通道对账批已完成入库 push**（cr-690，HEAD 4f8d4c81）：manifest 三词形校验 + 装载器 seats 对账 + 生成器 seats 快照 + 29 通道对账门，preview 650/650 绿。

## 1. ◐a 战场地图（cr-691 已登记，勘察完毕）

### 1.1 推荐方案：capabilitySetOf 单点合成（优于逐监听器改读）

裁决原文「行内监听器改读 settingsOf」——实施时发现更优单点：**capabilitySetOf 加 settings 档位词合成**（browser tier → observe/manipulate/inject 层级词集〔含下层〕；collab admin → 'admin'），则：
- sessionCapsOf / toolAllowedFor / 主线可见面全链自动一致（caps 是唯一合成视图）；
- web-tools 分层监听器（src/ac-web-tools/src/index.ts :385-389 caps.has 判 tier）**零改动**——caps 已含 settings 合成词；
- conv-settings grants 链路不变（会话覆盖优先天然保持）；
- **双树安全**：主线回滚线的 browser 可见性地板（requiredTags ['web','observe'] 的 observe）从 settings 合成，活体 tags 清词后旧树不破。

改动清单：
1. `src/ac-agents/src/service.ts` capabilitySetOf（:408）——加 settings 合成（读 ctx.agents.settingsOf(id, 'browser'/'collab')，主线签名在 :625）；
2. `src/ac-collab-tools/src/index.ts` hasAdminCapability（:50-52，tags 直读 'admin'）→ settingsOf 直读或 caps；
3. 活体数据换轨：workspace/home 16 agent config + __standard__ tags 清档位词（observe/manipulate/inject/admin/dev）→ 写 settings.browser.tier / settings.collab.admin——**幂等迁移脚本 + 先备份**（Agent 对 workspace/home 读双禁，走 pwsh）；
4. 前端涟漪：`src/ac-client-ui-agents/client/tagExclusive.ts` browser-tier 抉择组 UI 从 tags 读写 → 改读写 settings.browser.tier（tag-choice/tag-exclusive 测试同改）。

### 1.2 残留词形（不清）

tierOf/toolModeOf 档位词（full-access/sandbox-access/tc-*）留 tags——是 toolMode 消费面非装载面（ac-import agents-tree.ts :15 已裁定）。

## 2. ◐b 战场地图

preview 9 处 requiredTags 分类（grep 2026-10-25）：
- **toolsCatalog 回显**（ac-shell-conversation/service.ts :870/876）：t.requiredTags 是工具定义字段透传给 UI——换轨后主线工具定义仍有该字段（主线树不动），回显保留或随 ◐b 改名批一并处理；
- **迁移映射**（ac-import/agents-tree.ts :10/12/42）：TAG_TO_ROWS 是旧→新迁移逻辑，**保留**；
- **注释/测试**（gate.ts :13、rows-import.test.ts :103、admin-preview.ts :28、agent-admin-row.ts :79）：随改名批清理。

tools→rows 改名（preview 全链 12 读点）：AgentConfig 契约字段 tools→rows、rowset 派生、模板/活体 config、boot 读取；主线行包 35 处随旧树退役免动。活体 config 的 tools 字段改名需迁移脚本（同 ◐a 数据换轨一并做）。

## 3. 下一步优先序

1. ◐a 语义批（§1 清单，半天）：capabilitySetOf 合成 → collab → 前端 tagExclusive → 活体换轨脚本（备份+幂等）→ 主线全量 2765 + preview 全量验证；
2. ◐b 语义批（半天-1 天）：tools→rows 改名 + requiredTags 清理 + 活体 config 字段迁移；
3. B2 主题包通道（design-plugin-client-channel.md §3：令牌校验纯函数 + 示例主题包）；
4. B3 视角挂载（layout registerView + 隔离档容器承载）；
5. ◐c 退役批（判据「观察」积累 + 用户确认后）。

## 4. 现场环境（沿用 handoff-2026-10-25-cutover-final.md §4）

- 产品入口 pnpm dev:supervised（3830，数据根 workspace/home）；/api/healthz 探活；行集恒等式 86 = 宿主 48 + 壳 38。
- %TEMP% EPERM：vitest 前把 TEMP/TMP 指 preview/sandbox/tmp（前台 + 输出重定向文件）。
- workspace/home 双禁：活体数据迁移走 pwsh（先备份到 preview/sandbox/backup-<date>/）。
- 改主线包后主线验证阶梯：pnpm typecheck && test:unit && check:deps + 定向 lint + smoke。

## 5. 本会话产出索引

- cr-690（6c76e901）：B1 全批——manifest.ts 三词形 / boot.ts seats 对账 / gen-domain-channels.mjs scanSeats / seats-gate.test.ts 对账门 / 29+4 通道 manifest seats 声明。
- cr-691（已登记未实施）：◐a/◐b 语义批。
- plan.md §5：cr-690 行（B1 全记录 + 三裁决落定）。