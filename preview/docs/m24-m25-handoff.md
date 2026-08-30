# M24/M25 实施交接简报（2026-08-30 会话末）

> 供下一 session 快速接手。事实源：`docs/m24-global-defaults-plan.md` / `docs/m25-event-governance-plan.md`（状态头均已改 ✅ 已实施）。

## 一、完成状态（全部落地，验收全绿）

- **M24 P1-P6**：X1 hooks→settings 全链收口 / A1 全局默认层 / X2 目录 IA（后端 plugin/catalog + 前端两页签三视图）/ X3 市场首期 / X4 tags 单源 / X5 audit 轮转
- **M25 P1-P3**：before-step 补 agent + agentOf 读取器×11 + @scope 全量标注 + ac-gate-core / ac-event-policy 策略行 + events/* RPC / fiber→行聚合 + dep-graph + yml 行熔断 + include 热通道（setPatch hot 态）
- **验收**：`pnpm preview:typecheck` ✓ · `pnpm preview:test` **798 全绿**（原 644）· `pnpm --filter ac-webui-app typecheck` ✓ · `pnpm preview:smoke` ✓
- **X1 残留 grep**：仅剩 agent-store 双读边界与迁移测试（合规——方案设计如此）

## 二、⚠️ README 事故与恢复状态

- **事故**：会话末一条 PowerShell 正则转义错误把 `preview/README.md` 写空（文件未入 git，无法 checkout）。
- **恢复**：从 DSH 会话存档（`~/.dsh/sessions/--C-Users-xiaofeng-Documents-Dev-AgentChat-preview--/*/session.jsonl.zstd`，多帧 zstd，逐帧 `zlib.zstdDecompressSync` 解出）提取：
  - 1-860 行 = 本会话（session-6b6c8ebf）两次 read 的逐字记录；
  - 尾部（M18-B→M15 路线图段）= session-962a3a27（08-27）+ 49ee954e + 20fa208a 的 read 记录。
- 恢复后 948 行/120KB，已重放全部 M24/M25 状态更新（M24/M25 已落地头注、布局图三新行、契约表 eventPolicy 行、纯库清单 ac-gate-core、装载态四层热通道注记、命令节 798 测试）。
- **残余风险**：08-27 23:41 之后若有会话编辑过 README 尾部（861+ 行）可能未还原（对照 79b0cbbc/cf6154fb/9058c752 的 edit 均在 1-860 区，风险低）。**建议用户 review + `git add preview/README.md` 纳管**。

## 三、新包（3 个，已进根 package.json devDeps + cordis.yml + TREE）

| 包 | 职责 |
|---|---|
| `ac-plugin-market` | market/search（npm+github）/ market/stage（tarball 下载解包 tarball.ts 纯函数 + 来源锚定暂存人审）；fetchImpl 注入口测试零网络 |
| `ac-event-policy` | internal/listener bail 吞注册 + boot 末清扫（boot.ts 认领）+ 自锁守卫 + `events.disabled` 停用集 + fiber→行聚合 aggregate.ts |
| `ac-gate-core` | agentGate 纯库：waterfall 停用机械 `return next()`（末参函数判定）/ emit 停用跳过 / facet 子键 / 软依赖 agents.settingsOf |

## 四、关键新 API（技能与模板已同步）

- `ctx.agents.settingsOf(id, name?)` — deepMerge(config.settings[name], agent.settings[name])；消费侧 11 行全迁移
- `agentGate(ctx, 名, agentOfXxx, listener, {facet?})` — agentOf 读取器 import 自 owning 包（ac-agent-loop×5 / ac-tools×3 / ac-router / ac-llm×2 / ac-conversation）
- `ctx.eventPolicy` — disabledKeys/setPolicy/sweep/registerRowAlias
- `setPatch` 三态补全 `hot` — include 热通道（fiber.update 事务化，F10 守卫维持）

## 五、新 RPC（ac-web-api / ac-plugin-market）

`plugin/catalog`（内置组×装配交叉 + 本地组∪待审）、`market/search`、`market/stage`、`events/descriptions`（声明目录×执行链）、`events/policy-list`·`policy-set`、`plugin/dep-graph`（反依赖闭包+保护行）；`plugin/rows` 附 `entryId`；`events/listeners` 附聚合 `row`。

## 六、新测试文件（12 个）

settings-of / migrate-hooks（ac-agents·ac-agent-store）/ plugin-catalog / audit-rotate（ac-plugin-core）/ market（ac-plugin-market）/ gate（ac-gate-core）/ readers（ac-agent-loop）/ policy·aggregate（ac-event-policy）/ event-catalog·dep-graph（ac-app·ac-web-api）/ patch-layer 增热通道用例。webui：ExtensionSettingsModal.vue 双实例弹窗组件。

## 七、待办（下一 session / 用户）

1. **git 提交整个变更集**（含 README 纳管——防再裸奔）。
2. **存量数据迁移**：workspace 数据根下 `agents/*/config.json` 仍是旧 `hooks` 键——读取已被 agent-store 双读兜底，但需跑 `npx tsx preview/scripts/migrate-hooks-to-settings.ts <数据根>` 落新键。
3. README 尾部（M18-B→M15 路线图段）人工 review 一眼（恢复源为 08-27 会话记录）。
4. 可选：boot 手测官方路径（`pnpm preview:boot`）验证 market/event-policy 行装载 + 事件治理 UI 走查。
