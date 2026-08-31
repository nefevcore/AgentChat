# preview 轨道 code-simplifier 全量审计（2026-08-31）

> 方式：机械扫描先行（全轨未使用导出 / stale 依赖 / 孤儿文件 / 跨文件克隆 /
> console·TODO·ts-ignore），候选逐条裁决；重灾区双流（webui 与插件治理簇各一
> 子代理，主会话复核其余）。验收 = 行为零变化：typecheck + 833/833 测试 +
> webui build + smoke 全绿（基线 804 测试，本轮前 T0 批已增至 833）。
> 注：本轮与 T0 加固批共享工作区，diff 统计混流；本审计直接足迹约 50 文件，
> 净变化以删除为主（webui −42 行 types、client.ts −33 行等）。

## 已落地（按类）

| 类 | 内容 |
|---|---|
| 死代码删除 | ac-ws-protocol `RpcResultPayload`/`WsReadyPayload`（协议类型死镜像）；ac-event-policy `registerRowAlias`（被 computeRowAggregates 自动聚合取代的死注册口；handoff 文档行同步）；webui 20 符号（feed.ts `groupIdOf/sessionIdOf/isGroupDialog/isSingleDialogId`、client.ts `jsonPost/jsonPatch/jsonDelete/jsonPut/stripEmpty`、registry 三 `unregister*` + `allPerspectives`、host `unloadUiExtension/loadedUiExtensionNames`、`reloadSessionPlugin`、types `AgentFullConfig/WSIncoming/LLMConfig`、`ChunkedMarkdown`）；scripts `tmp-diag3.mjs`/`tmp-verify-memory-append.ts`（一次性诊断脚本） |
| 克隆并源 | `sandboxOf`（per-Agent 沙箱解析缓存）四行逐字重复 → `ac-sandbox-core.createAgentSandboxCache`（workspace 以 getter 注入保持纯库零 cordis 依赖；缓存生命周期=apply 作用域，行为逐字节等价）；插件簇 `<root>/plugins` 路径口径 5 处分叉 → 统一 `pluginsRoot()` |
| 漂移修复 | `AUDIT_ROTATE_KEEP` 零引用且实现硬编码 `.1/.2` → 让 `rotateAuditIfLarge` 引用常量（KEEP=2 字符串恒等，README M24 X5 背书） |
| de-export（行包内部件收窄，npm 发布前收口 API 面） | 主会话 15 处（GLOB_*/GREP_*、READ_TOKEN_BUDGET、LOG_BUFFER_SIZE、MAX_OUTPUT_CHARS、HISTORY_PAGE_MAX、RESTART_EXIT_CODE/isSupervised、EXCLUDE_FILES、escapeMsgAttr、ShellConfig、TreeRow 等）；插件簇 15 处（contracts/fsx/load-health/manifest/patch/reserved/store/audit 内部件）；webui 39 处 |
| 内联/合并 | plugin-registry `readStagingRecord→getStagingRecord` 纯别名合并、`isLoading` 单调用方内联、`activate()` 双激活点统一、`queueForRoot` 单调用方内联进 `withRootLock` |
| stale 依赖删除（8 条，均经 src+tests 零 import 求证） | ac-durable-interaction::ac-router、ac-fs-search::ac-tools、ac-mcp::ac-agents(dev)、ac-singles::ac-workspace(dev)、ac-str-replace-editor::ac-tools、ac-timer::ac-session(dev)、ac-plugin-gates::ac-plugin-registry(dev)、ac-plugin-registry::ac-agent-admin(dev)；lockfile 已同步 |
| 文档修正 | README `docs/code-review-workflow.md` 失效引用 → `.dsh/skills/code-simplifier/`；m24-m25-handoff registerRowAlias 行同步 |

## 判例（下次直接援引）

1. **行包 RowOptions/Config 类型 = 既定契约惯例**（README 契约归属表），一律保留 export——含零外部引用者。
2. **纯库公开签名引用的类型 = lib API**（ac-openai-completions Completions\*、ac-mcp-core DI 缝类型、ac-supervisor-core 协议类型、ac-session 持久化格式类型 SessionHeader/SessionRecordRole 等）——保留 export；纯库内部实现件才 de-export。
3. **行包导出面 = 入口 plugin 对象 + `extension` 自述（A1）+ Config 类型 + ctx 服务契约类型**；其余内部件（常量/叶子 helper/非入口模块类型）de-export。
4. **机械扫描的「仅自身文件使用」含定义行自记**——判死前必须扣掉声明行重数（webui client.ts jsonPost 族因此由 de-export 改判删除）。
5. **跨文件克隆三步裁决**：逐字重复且归属单一域 → 上移 owning 纯库（sandboxOf）；行独立性的既定代价（llm 三薄行 Config、group/session 共享行格式）→ 合法保留；结构相似但语义分叉 → 只报告。
6. **devDependencies 里的跨包依赖多为测试 boot 链**——删前查 tests；「runtime 依赖 owning 包取域常量」（conversation→GROUP_HINT_META）是文档模式，不是耦合缺陷。

## 遗留清单（下轮输入，带位置）

1. **workspace 循环依赖 ×2**（pnpm WARN）：ac-app(dev)↔ac-plugin-market↔ac-plugin-registry(dev)、ac-conversation(runtime)↔ac-group(dev)。根因 = 组合根/行测试走完整 boot 链。破环需把全树 boot 测试归拢 ac-app 或引共享 test harness——测试重构，另立项。
2. **ac-app/package.json dependencies 与 TREE 导入集不一致**（缺 ac-plugin-registry/ac-web-server/ac-web-api/ac-agent-admin/ac-timer/ac-archive/ac-backup/ac-usage/ac-webui/ac-workspace 等约 15 项，靠根 hoisting 解析）。ac-app 为私有组合根不单独发布故无害；若发布需补齐。
3. **测试样板 `ctx.plugin(row as any)` 约 100 处**（50+ 测试文件，cordis Plugin 类型摩擦）+ ac-app src 两处 `scriptedRow() as any`——收敛需共享 test harness 类型，机械改写收益低。
4. **webui src `as any` 15 处**（feed.ts×4 legacy role、settings/schema.ts×5 MASK/$ref、settings/api.ts、useSettings.ts）——逐个补型可零行为清除，量小可下轮顺手。
5. **switchTrace.ts 生产环境无条件 console.log**（webui/src/utils/switchTrace.ts:31，诊断工具、两 store 在用）——建议 localStorage 门控；输出属可观察行为，本轮不动。
6. **超长文件热点**（拆分属行为风险区，只记录）：ac-web-api/src/index.ts 1568（polish-backlog A6 已立项瘦身）、ac-plugin-registry/src/service.ts 1331、webui/src/stores/feed.ts 1280、ac-session/src/index.ts 1084。
7. **polish-backlog 既有遗留**（本轮不重复处理）：C1 浏览器目验、C7 ws-bridge 模板文案、C8③ 徽章族抽公共类 + StarCard 零使用载体。
