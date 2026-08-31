# preview 轨道 code-simplifier 逐包全量审计（第二轮，2026-08-31）

> 方式：74 个 ac-* 包逐一审查——主会话自营 66 包 + 子 Agent 并发报告 8 份
> （registry/web-api/plugin-core/session/app/agent-loop/group+conversation，报告只
> 作候选、逐条核对原文后统一应用）。验收 = 行为零变化：每批修改后
> preview:typecheck + 102 文件 / 833 测试全绿（接续同日第一轮审计
> `simplify-audit-2026-08-31.md` 的判例体系）。

## 已落地（按类）

| 类 | 内容 |
|---|---|
| 死代码删除 | ac-backup `due()`；ac-durable-interaction `configure()`/`openCount`；ac-fs-search `searchFile` 死返回值；ac-subagent `awaitResult._waitMs` 死参数；ac-system-prompt `AssembleInput.agentId` 死字段（含测试 3 处死传参）；ac-agent-loop `pairEndpoints`（判死三查全过）；ac-edit-core `EditOperations`/`ops` 可插拔 I/O（零注入的投机缝）；**五个服务诊断 getter**（session/memory/skills/agentStore.root + config.path，全仓三重求证零调用；workspace.root 与 usage.auditFiles 求证存活保留）；plugin-core `SerialQueue.pending` 及支撑、`recordLoadFailure.threshold` 死参数、`!missing.includes('ui')` 恒真条件；app `BootFromConfigOptions.baseUrl`（5 调用方零传入） |
| 克隆并源 | plugin-registry approve/installFromDir 收尾六步 → `finalizeInstall`；setPatch/resetPatches loader 探测三份 → `LoaderLike`+`isSubtreeCarrier`；usage `record`/`replay` 六维聚合 → `mergeIntoMaps`；session `records`/`tail` 行解析 → `parseRecordLine`；plugin-core 防碰撞后缀两份 → `collisionSuffix()`；agent-store 头像扩展名表两份 → `AVATAR_EXTS`；workspace `guessContentType` 字面量表 → 模块级；registry 测试 `makePluginDir` 双份 → `tests/helpers.ts`；**跨包谓词五联**（isArchiveReviewRun ×3 + isGroupHint ×2 + archive/usage 内联 ×2）→ 上移 owning 包随常量单源（ac-agent-loop / ac-group 出品，零新增依赖边） |
| 双声明并源 | ac-group `GroupRowOptions` / ac-conversation `ConversationRowOptions`：index.ts 与构造器内联双份 → RowOptions 住 service.ts + index 再导出（对齐六包既有惯例） |
| 拆分（超载函数） | registry after-run 114 行三分支 → `consumeRegister/consumeInstall/consumeUnregister`；session 构造器 117 行 → `onReplyCompleted`+`flushBestEffort` 抽出；agent-loop `execute` 收束日志 20 行 → `logRunSettlement` |
| 嵌套三元/聪明写法清除 | registry 幂等三态、unregister 联合类型漏斗+双 `as`；session `projectRecord` 两处三层；plugin-core reserved `FACE_LABELS` 映射化、fsx 空 if 体；web-api `ExtensionListenerDecl` 跨包重复接口删除、`hooksTableOf` 类型单源；app 测试 `EntryOptions[] extends never` 恒真条件 + `as never` ×4；group `histories?.get` 残留可选链；group 两测试嵌套三元 |
| 冗余 try/catch | conversation startRun 纯重抛块删除（注释上移）；usage/conversation 各一处死字段/死语句 |
| 死面收窄 | group `latestArchiveSummary`/`ensureLog` → private；app `findIncludeEntry` de-export、`ModuleLoader` re-export 跳板移除 |
| 注释修正 | plugin-core audit "fsx retry" 失真、readAudit "RPC 用"→"测试断言面"；app boot-yml-main 入口名错误（实为 preview:boot:demo）；web-api 可选能力行 4 处重复 → 单权威 + 指针；group rederiveTokens 缺省公式失真；registry 头注与助手文档逐字重复 → 指针 |
| 风格漂移 | app smoke/boot-yml-main 相对导入补 `.ts` 扩展；boot.ts 重复 node:url 导入合并；workspace saveUpload 注释挤行；agent-loop steer 150 字符单行展开 |
| 测试清理 | `void` 压告警死变量 ×6（registry/session/plugin-core/agent-loop/conversation）；app webui-e2e 动态 import+rmSync → await rm；conversation view-derivation 同款；group 永不触发的死后注册断言 |

## 判例（本轮新增，可直接援引）

1. **判死三查**：barrel 外部调用、直捣模块的测试、同包跨文件调用——三者皆无才可收（de-export/死参数均适用；`export type {} from` 再导出不引入本地作用域名）。
2. **typecheck 是判死的第二道闸**：grep 模式会漏测试对象字面量传参（AssembleInput.agentId 教训）与同包跨文件 import（isValidContractsRange 教训）。
3. **本地 catch 与平台收敛有可观察差异**：工具体自持 try/catch 使 `tool/after-execute` 的 error 位为空——ac-fs-tools/web-tools/collab-tools 等的"冗余"catch 实为 wire 面差异，不可删。
4. **小命名函数是项目既定风格**：单调用方的具名 helper（timersLogComplete、hasAdminCapability 等）不按"单实现抽象"机械内联。
5. **agentGate 双轨**：M25 正式 API 零生产调用方（存量 6 行手工 settingsOf 自查等价）——平台面不删，收敛归 M25 治理面决策。
6. **谓词随常量上移**：跨包逐字谓词归 owning 包（与常量同源导出），消费方换 import 零新增依赖边（isArchiveReviewRun/isGroupHint 先例）。
7. **writeJsonAtomic/原子写各 owning 自持**（既有判例重确认）；**chat 聚合在域层/协议层各司其职**（ac-llm.chat vs OpenAICompletions.chat，不同关切不算重复）。

## 遗留清单（下轮输入，带位置）

1. **wire 面产品决策（✅ 已裁决落地：六法全删）**：`plugin/reload`、`jobs/list|get|read|kill`、`backup/list` 已从 ac-web-api 移除（用户拍板"前端死代码全删"；无仓外 WS 客户端）。归因：M17-A 自顶向下垫面，预期前端消费面三处收敛后悬空——jobs 两轨皆为 Agent 工具面（src job 工具 ≡ preview ac-shell-tools/ac-subagent 进程内直调 ctx.jobs，UI 面板从未存在）；备份列表内嵌 backup/run 载荷（webui backupNow 即此取数）；插件重载走 registry watch 自动（service 内部 this.reload + plugin/reloaded 事件）+ 手动 load/unload。服务方法全部保留；timer/trigger 维持（m17b wire spec 背书）。验收：typecheck + 102 文件 832 测试全绿。
2. **巨型 handler 拆分（机械移动可行，体量较大）**：web-api `plugin/catalog` 172 行（:1063-1234，可拆 collectBuiltinCatalog/collectLocalPlugins）；`plugin/dep-graph` 94 行（:1341-1434）；web-api 测试 harness 三份拷贝（web-api/dep-graph/plugin-catalog 三测试文件 ~100 行同构）。
3. **registry ②⑨**：setPatch/resetPatches 热通道收尾参数化并源（中置信）；installFromDir 幂等短路抽取。
4. **plugin-core 候选5/6**：store.ts 两份 walk 骨架 → collectFiles；`PluginUiManifest` 四字段跨包拷贝（ac-webui 改 import type + devDependency，涉 package.json/lockfile）。
5. **session 候选5/7**：session-header 前缀串三处（src/scripts/tests）；D13 注释轻削（构造器/record/append 三处重述，保文件头+jsdoc 正典）。
6. **app 候选1**：scriptedRow 脚本化 provider 包内 4+1 份参数化并源（−70 行；测试自包含有辩护，裁量项）。
7. **agent-loop C4**：单包测试脚手架 ×2 逐字克隆（与"跨包 harness 另立项"判例的边界情形，两说并存）。
8. **观察项（不立动作）**：ac-group `readSince/currentAnchor` 运行时零消费（busy 注入实走 steer hint 全文，文档-实现脱节——D11 复盘裁决）；ac-conversation `PendingLine.source` 恢复后按 'user' 计账的语义保真问题（行为变更另立项）；`agentOf*` 四读取器仅本包单测消费（M25 文档指派面）。
9. **既有第一轮遗留不重复处理**：见 `simplify-audit-2026-08-31.md` 遗留清单（workspace 循环依赖、ac-app deps 缺项、`ctx.plugin(row as any)` 样板 ~100 处、webui `as any` 15 处、switchTrace console.log 等）。

## 逐包结论速览

74 包全审。合法无改动（结构/契约/风格合规）：hello、llm-glm/deepseek/openai（范例薄行）、extension-core、memory-core、text-budget、gate-core、backup-core、archive-core（safeSplitIdx 前向防御带到期条件）、config-merge、ws-protocol、plugin-gates、agents-dir、datetime、webui-extensions、session-query、timer-tools、skill-core、skill、persona、glob-core、supervisor-core、str-replace-editor、config、agent-presets、webui、ws-bridge、fs-tools、openai-completions、math（neg 微修外合法）、router、mcp、mcp-core、llm、security、agent-admin、web-tools、collab-tools、timer、plugin-market、shell-tools、agents、web-search-core、singles、web-server、archive。有修改：restart、backup、fs-search、memory、subagent、agent-store、event-policy、plugin-registry、web-api、plugin-core、session、app、agent-loop、group、conversation、edit-core、durable-interaction、system-prompt、jobs、workspace、usage。
