# 权限门交接（permission-gate-handoff）

> 性质：交接——权限门批 1-3 全部收口后的现场快照：落成面全景、决策链地图、真实遗留项与接力入口。本档是起点索引，不是二次事实源。
> 状态：现行 · cr-1077 2026-11-14 · 主档 [permission-gate-plan.md](permission-gate-plan.md)（模型 + 决策序 + 批 3 落地段）。**批 1/2/3 已全部收口并提交（cr-1061→1076，8 commit）；无未竟实施项，遗留项见 §三。**
> 读者：权限域后续维护者（新会话开工前通读本文 + 主档 §一/§二；改门行为前再读门源头注释）。

## 一、落成面全景（全部已落地、已部署、已提交）

决策链：cr-1061 设计 → 1062 D10-D13 → 1063/1065 计划 → **1066 批 1 实施** → 1068 交接 → 1069 档位环（错）→ **1070 回滚裁决** → **1071 run 缓存补丁** → 1072 批 2 裁撤 → 1073 伪造向量定级 → **1074 批 3 实施** → **1075 补丁（环 + manifest 冒充洞）** → 1076 技能同步 → 1077 本档重写。

| 面 | 内容 | 落点 | CR
|---|---|---|---|
| 契约 | `risk?: (args) => 'allow'\|'ask'\|'deny'` 纯函数建议（throw 按 ask；无 risk + needPermission ≡ 恒 ask） | `packages/ac-tools/src/contract.ts` | 1066
| 门行 | 决策序 0-5 主门（deny 直效 / allow 直通 / ask 上抛设置链 → approval 审批卡 → 批准注入 full-access）+ run 级批准缓存（命中同权注入，免问 ≠ 降权） | `packages/ac-permission-gate/src/index.ts`（约 215 行，头注释即行为规格） | 1066/1071
| 设置链 | 会话键 approval（BUILTIN_KEYS）> Agent settings `permission-gate.json` > 行 config 缺省 ask；19 身份部署 onAsk=allow | `ac-conv-settings/src/service.ts` + `agents/<id>/` | 1066
| 装配 | shell.yml v6 骨架行（tools 后）+ IMPORTED_ROWS；数据根已物化 | `apps/catalog/profile/shell.yml` + `ac-shell-rows/src/index.ts` | 1066
| 批 2 | ~~accessCapsOf~~ 裁撤——零代码残留，access 轴职责由 `effectiveAccessOfCall` 单源承担，档位不参与审批（cr-1070 终态） | 无（裁决档） | 1072
| 精确信任面 | permissions 第 6 词 `risk` 进 REVIEW 面（D11——信任位非执行边界：未授予不拒载，只降为不可信恒 ask 还能用）；免审通道 grants = manifest 全集自动含 risk | `ac-plugin-core/src/manifest.ts` + 前端 shim | 1074
| 装载边界硬闸 | `guardPluginModule(mod, manifestName)`：**manifestName 与模块名两处都查**（只查模块名会漏 manifest 叫 ac-evil 的冒充），冒充官方命名空间即拒载；fiber 名钉死 manifest.name（无名 fiber 会继承祖先名，owner 错挂）；接线 `assemblePluginRow`（boot）+ `loadSession`（plugin-dev）两条装载通道 | `ac-shell-rows/src/plugin-guard.ts` | 1074/1075
| 命名空间单源 | `isReservedPluginName`：`ac-` / `shell-` 前缀 + `root`；安装期 `validatePluginManifest` 早失败 + 装载期守卫再拦（防 manifest 事后改写）——**两层都要，缺一即洞** | `ac-plugin-core/src/manifest.ts`（谓词导出，plugin-guard 消费） | 1075
| 门行信任面 | `trusted()` 双臂：官方 fiber 名 ∪ `riskGranted(owner)` 回调（boot 注入 `makeRiskGranted`——读 registry.json 授予快照，fail-soft 空集 = 全插件不可信） | `ac-permission-gate` + `apps/shell/boot.ts` | 1074
| 测试 | gate 21 例（决策序全分支 + D11 双臂 + cr-1070 守护 + run 缓存同权）+ plugin-guard 7 例 + manifest 校验 4 断言 + 契约锚；全量 439 文件 3158 用例绿 | 各包 tests | 1066-1075
| 技能文档 | 插件技能词表增 risk + name 禁占官方命名空间（模板 + `__creator__` 物化副本双改） | `packages/ac-host-rows/templates/creator/skills/plugin-dev/SKILL.md` | 1076

部署实况：宿主 24164 / 壳 10072（2026-11-14 15:24 起），boot-graph 29 行含 permission-gate。全部改动已按批提交（`1038c3e4`…`1ecfa4c2`，工作树干净）。

## 二、关键事实（接手即需，防重新踩坑）

1. **两条硬红线（勿回潮）**：
   - **档位不参与审批**（cr-1070 用户裁决）：cr-1069 曾按旧「sandbox+ 档自由」语义补 4.5 档位免审环，被回滚并以守护测试固化。access 轴只管执行边界（full 跳复检/扫描），approval 轴管 ask 归宿——正交。
   - **旧框架已死**（cr-1065）：独立政策轴 / 12 格矩阵 / severityMax / kind / verdict 机器全部不存在。设计问题先回溯 cr-1061/1062/1065 轨迹，勿重新发明。
2. **三处实施偏差（与主档初稿不同，已是正确形态）**：approval 会话键走 conv-settings BUILTIN_KEYS 而非门行 registerKey（垫片注册键宿主 set 面不认——读写链静默断，harnessTier 正受害于此）；D7 无人桶判定**先于**设置链（「设置 allow 不豁免」字面义）；批准/缓存命中都变异 `call.access = 'full-access'`（否则 base 档过门后撞工具内沙箱墙）。
3. **fiber 名的完整事实**（cr-1073 定级）：cordis fiber 名 = 插件源码自选字段（`Plugin.Base.name`——「display name」语义，可省略无校验），与 manifest.name 相互独立；无名 fiber 继承最近命名祖先。因此批 1 的「ac- 前缀即可信」有伪造向量，批 3 的解法是**钉死 + 双检 + grants 查询**三件套，不是单点封禁。
4. **risk 是信任位不是执行边界**：故意不进 EXECUTION_EXPLICIT_REQUIRED——未授予 risk 的插件照常装载运行，只是其 risk 自评被覆盖为恒 ask（每次过审还能用）。这与 D11「不可信还能用」语义一致，勿改成装载拒绝。
5. **门行对 ac-plugin-core 零依赖**：grants 查询经 `riskGranted` 回调注入（机制归位——编排层 boot 读快照，域行收回调）。改授予数据结构时只动 boot 的 `makeRiskGranted`。
6. **测试环境注意**：ac-plugin-core 的 installer 冒烟走 CLI 链，**不经过**壳 `assemblePluginRow`——守卫的 e2e 缺口见 §三-③。
7. **`__creator__` 保持缺省 ask**（未写单元文件）——审批链活体验证口；其他 19 身份 onAsk=allow（用户指示的全通行）。

## 三、遗留项（按建议优先级排序）

| # | 项 | 内容与落点 | 量级 | 状态
|---|---|---|---|---|
| ① | **官方工具行声明 risk（价值兑现位）** | 已落地（cr-1078，用户裁决 A 全套 + 测试构建纳入）。write/edit/str_replace_editor：朴素相对路径（`isPlainRelativePath`——无盘符/无 .. 段）→ allow，其余 ask；pwsh/bash：只读白名单 `isLowRiskCommand`（纯查看 + 只读 git + pnpm/npm test·typecheck·lint·build·check + npx eslint/tsc/vitest run——重定向/脚本块/$/反引号/heredoc 全禁 fail-closed）→ allow，其余 ask；web_search/browser 恒 allow（读类面）。判定纯函数住 ac-sandbox-core（机制归位），工具行只挂引用。submit_issue/run_harness 裁决不动，恒 ask。**安全依据：allow ≠ full-access——直通后沙箱轴照拦（D9），实权限比「批准→full-access」更窄**。行为变更感受者 = `__creator__`（base 档缺省 ask）——pwsh 跑 git status/测试、write 写沙箱内文件不再弹卡 | 每工具几行 + 测试锚 | ✅ cr-1078 已落地
| ② | **人审 UI 认识 risk 词** | `StagingReviewModal.vue:157-162` 勾选警示只覆盖 ui/process/shell——risk 出现时用户只见裸词复选框，不知授予的是什么（「此插件 risk 自评将被采信，allow 直通」）。`ExtToolsPane.vue:105` 徽章兜底词表也是旧三词。是 ① 的用户面配套 | 两文件加 risk 分支 | ☐ 未立项
| ③ | **装载守卫 e2e 锚** | 「安装成功 + boot 装载被守卫拦下」全链无集成测试（单测已覆盖判定函数，风险低）；补一条经 `assemblePluginRow` 的用例 | 1 用例 | ☐ 未立项
| ④ | harnessTier 键宿主设不进 | 老 bug（同批 1 偏差 2 的病根）：垫片注册键宿主 set 面不认，approval 已用 BUILTIN_KEYS 先例绕开——harnessTier 是否照修待裁决 | 键迁移 | ☐ 待用户裁决
| ⑤ | 小额清洁 | 主档 L5/L6 读者行重复；本档 §三引导语残留；插件技能 §2 仍教已退役的 requiredTags 写法（cr-953 后运行时零消费——照写的插件工具并非私有，是行集可见性）| 文案 | ☐ 顺手

以上都不阻塞、互不依赖；①② 建议同批（行为变更与其用户面配套出现）。

## 四、接力入口

1. **开工序**：读本档 §二 → 主档 §一（模型）§二（决策序）→ 门源头注释（行为规格单源）。动遗留项 ① 前先问用户粒度裁决。
2. **源码五件**：`ac-permission-gate/src/index.ts`（门）/ `ac-shell-rows/src/plugin-guard.ts`（守卫）/ `ac-plugin-core/src/manifest.ts`（词表 + 命名空间谓词）/ `apps/shell/boot.ts` 的 `makeRiskGranted`（授予注入）/ `ac-permission-gate/tests/gate.test.ts`（21 例行为锚）。
3. **红线流程**：动手前 `node cr/cr.mjs append` 登记；设计争议回溯 `cr/logs/cr-1061/1062/1065/1066/1070/1073/1074/1075.md`；提交按批（功能/装配/文档/chore 分开），双归属文件用 hunk 分离（先例：shell/boot.ts 在 cr-1067 与 cr-1074 间的 `git apply --cached` 拆分）。
4. **验证阶梯**：动 packages/apps → typecheck + test:unit + check:deps + 定向 eslint；动契约/词表/行集 → + `pnpm test` 全量 + webui:typecheck；动 UI → + build:channel。
5. **生效环**：壳侧行（shell.yml 点名包）→ `restart_shell`；宿主侧（ac-plugin-core 等）→ `restart_host`；只改码不跑无需重启。测试全绿 ≠ 运行时已生效。
6. **验证工具**：活体验证用 `__creator__`（缺省 ask——pwsh 一调即弹卡）；审批事实在 `workspace/home/agents/__creator__/interactions.jsonl`（kind=approval 条目）。
