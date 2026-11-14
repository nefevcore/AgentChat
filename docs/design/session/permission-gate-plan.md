# 权限门行实施计划（permission-gate-plan）

> 性质：实施计划——权限门（ac-permission-gate 行）的模型、决策序、文件级切分与验收。本档是权限域的唯一现行计划，取代 cr-1063 初版（初版误照搬已删设计档的政策轴框架，cr-1065 重写）。
> 状态：批 1 已实施（cr-1066 2026-11-14——1a 契约 / 1b 门行 / 1c 装配落地；批 2/3 未启动）。
> 读者：门行实施者（开工前通读；每批完成后回填状态）。
> 读者：门行实施者（开工前通读；每批完成后回填状态）。

## 一、模型（讨论终点，勿引入旧框架）

工具作者只做**风险分析**，环境做**风险处理**：

```
工具侧（唯一接口）
  risk: (args) => 'allow' | 'ask' | 'deny'   // 纯函数建议；有声明缺函数 = 恒 'ask'
  // 无 risk 声明 + needPermission: true     ≡ risk: () => 'ask'（存量等价映射）
  // 无 risk 声明 + needPermission: false/无  = 门视野外（零开销放行）

信任面（建议是否被采信）
  官方行 / 已信任插件行  → 建议生效
  其余（不可信）         → 建议被覆盖为恒 'ask'（全高危+询问——还能用，每次过审）

环境侧（门行 = 唯一处理者）
  deny 建议  → 拒绝（工具自愿收紧，不可被放宽）
  allow 建议 → 直通（可信工具已审过，环境不重复审——这是信任的收益）
  ask 建议   → 上抛设置链问「这个 ask 如何处置」：
               [会话键 > Agent settings > 行 config 缺省] ∈ {allow, ask, deny}
               · allow → 放行（= 旧 never：问也白问，直接过）
               · deny  → 拒绝（= 旧 dontAsk：提示转拒绝）
               · ask   → 有人桶：open approval 问人（scope call/run，批准/拒绝/超时）
                        无人桶（conversationFormOf === 'self'）：问人不可达 → 拒绝（fail-closed）
```

与旧框架（已删 permission-model.md）的关键差异——**实现时勿回潮**：

| 旧框架（勿用） | 现模型 |
|---|---|
| 独立 approval 政策轴（ask/never/deny）× 建议 12 格矩阵 | 无独立政策轴——设置链只定义 ask 建议的缺省答案（3 格） |
| severityMax 合成 + VERDICTS 四值 | 分支决策序；allow 直通、deny 直效，无合成函数 |
| never×ask=deny 是特判格（D12） | 设置 deny 的自然结果——语义涌现，非规则 |
| kind 分类词、auto 档、verdict 机器 | 全部不存在（未来需要再立，YAGNI） |
| 「base 档审批、sandbox+ 档自由」（access-tier × needPermission 耦合） | 已废（cr-1070 回滚 cr-1069 的 4.5 环）：档位不参与审批决策——免审正路是 risk 自评与设置链；档位轴只管执行边界（full 跳复检/扫描等） |

保留有效的旧裁决（编号沿用）：D7（无人桶恒拒，even 设置 allow）、D9（门缺席=dontAsk 化，边界轴照拦）、needPermission 等价映射、approval 走 registerKey。

批 3 精确信任面已落地（cr-1074）：① KNOWN_PERMISSIONS 增第 6 词 `risk` 进 REVIEW_EXPLICIT_REQUIRED（D11 人审授予——risk 是信任位非执行边界，未授予不拒载只降为不可信）；② 装载边界硬闸 `plugin-guard.ts`（ac-shell-rows）——插件名冒充官方命名空间即拒载 + fiber 名钉死 manifest.name（cr-1073 定级：fiber 名 = 源码自选与 manifest 独立；cordis 无名 fiber 继承祖先名，不钉死则 owner 错挂装载行）。**命名空间规则单源在 ac-plugin-core**（`isReservedPluginName`：`ac-` / `shell-` 前缀 + `root`，cr-1075 订正）——安装期 `validatePluginManifest` 早失败 + 装载期守卫再拦一次（防 manifest 事后改写）；守卫同时校验 manifestName 与模块名（只查模块名会漏 `ac-evil` 这类 manifest 冒充）；③ 门行 trusted() 双臂：官方 fiber 名 ∪ riskGranted(owner) 回调（boot 装配注入 registry.json 授予快照，fail-soft 空集 = 全插件不可信）；④ 免审通道（installFromDir grants = manifest permissions 全集）自动含 risk——声明即授予，信任归位安装审。

## 二、决策序（门行为规格）

```
0  def 无 needPermission 且无 risk          → 放行（门视野外）
1  不可信（origin 判定）                     → 建议 := 'ask'（覆盖）
2  建议 := def.risk?.(args) ?? (needPermission ? 'ask' : 'allow')
3  建议 = deny                              → 拒绝
4  建议 = allow                             → 放行
5  建议 = ask：
   s := 设置链(会话键 approval > settings['permission-gate'].onAsk > 行 config onAsk 缺省 'ask')
   s = allow → 放行；s = deny → 拒绝；s = ask →
     无人桶（agents 行在场且 formOf === 'self'）→ 拒绝（fail-closed；D7：设置 allow 不豁免本格）
     有人桶 → open approval {tool, args, need} → 批准(call/run) → 放行 / 拒绝·超时 → 拒绝
```

特判：risk 函数 throw → 按建议 'ask'（fail-closed 方向）。run 级批准缓存（scope=run）：Map<runKey>，loop/before-run 清——批准一次，本轮后续 ask 建议全免；缓存命中与首批准同权注入 full-access（cr-1071：免问 ≠ 降权，同一授权的后续兑现）。

## 三、分批切分（文件级）

### 批 1a：契约（ac-tools，无行为变化）

| # | 改动 | 文件 |
|---|---|---|
| 1 | ToolDefinition 增 `risk?: (args: Record<string, unknown>) => 'allow' \| 'ask' \| 'deny'`（同步可选；JSDoc：建议非决定——allow 不直通、deny 直效不可放宽、ask 上抛设置链；throw 按 ask） | `packages/ac-tools/src/contract.ts` |
| 2 | 单测：契约字段类型 + JSDoc 语义锚 | 包内 tests |

### 批 1b：门行本体（新包 ac-permission-gate）

| # | 改动 | 文件 |
|---|---|---|
| 1 | 新包 manifest/package.json/README（服务包形态，参照 ac-math 样例） | `packages/ac-permission-gate/` |
| 2 | 决策序 0-5 主门（before-execute waterfall 订阅，只拦有声明面的调用） | `src/index.ts` |
| 3 | 信任面判定：origin 简化版（官方行 = packages/ 内、随宿主分发；其余 = 不可信覆盖恒 ask）——精确信任面（permissions 第 6 词）批 3 | `src/index.ts` |
| 4 | 设置链合成：会话键（convSettings）> Agent settings（settingsOf 三层同 shell-tools limitsOf）> 行 config onAsk 缺省 ask | `src/index.ts` |
| 5 | approval 生产：有人桶 + s=ask → durableInteraction.open（payload {tool,args,need} 对齐前端 pickApproval；answer {approved,scope}) → 挂起等待 → 批准放行/拒绝超时拒）+ run 级缓存 | `src/index.ts` |
| 6 | need 文案生成器（pwsh → 命令全文；write/edit → 目标路径；其余 → description 首句+参数摘要） | `src/notice.ts`（样板 ac-sandbox-core/notice.ts） |
| 7 | 会话键注册：convSettings.registerKey({ id: 'approval', enum: ['allow','ask','deny'] }) | `src/index.ts` |
| 8 | 单测：决策序全分支（含 throw→ask、覆盖、无人桶、D7 设置 allow 不豁免）+ approval 全链（桩 durableInteraction）+ run 缓存失效 | 包内 tests |

### 批 1c：装配与文档

| # | 改动 | 文件 |
|---|---|---|
| 1 | shell.yml v5 骨架增 permission-gate 行 + 升 `# ac-base-version` + `node scripts/gen-row-catalog.mjs` | `apps/catalog/profile/shell.yml` |
| 2 | 行定义 ac.rows + README 工具行清单 | `packages/ac-permission-gate/package.json` + 根 README |
| 3 | 计划档状态行回填 | 本档 |

实施注记（cr-1066）：骨架行单源（shell.yml）——包 package.json 不写 ac.rows（骨架/能力双定义会撞 id）；行经 IMPORTED_ROWS 装配（ac-shell-rows）；approval 会话键进 conv-settings BUILTIN_KEYS 而非门行 registerKey（壳/宿主分树下垫片注册键宿主 set 面不认识——读写链静默断）；D7 无人桶判定先于设置链（设置 allow 不豁免的字面义）。

## 四、两层验收

### 测试标准（过程门）

| 批 | 必跑 |
|---|---|
| 1a | typecheck + test:unit + check:deps + 定向 eslint |
| 1b | 同上 + 定向 vitest + `pnpm test` 全量（动契约/行集） |
| 1c | 同上 + gen 幂等 + 运行时验证按需 `restart_shell` |

### 验证目标（目的态断言）

| # | 断言 |
|---|---|
| V1 | base 档 pwsh 调用 → approval 卡出现（tool/args/need）→ 批准执行 / 拒绝 veto | ✓ 活体（cr-1066 部署验证：pwsh 弹卡→批准执行；拒绝路径单测+最小复现） |
| V2 | scope=run 批准后本轮第二次 ask 建议免问；run 收束缓存清 | ✓ 活体（同轮后续 write/pwsh 免问）+ 单测（before-run 失效） |
| V3 | 会话键 approval=allow → 不弹卡直过；=deny → 拒；键卸载门行后消失 | ✓ 单测（三层设置链全覆盖）；Agent 级 onAsk=allow 经 settings 单元文件部署（19 身份） |
| V4 | 不可信插件工具（无 risk）needPermission 调用 → 恒问（覆盖生效） | ✓ 单测（owner 非 ac- 前缀覆盖） |
| V5 | 无人桶 ask 建议 → 拒（even 会话键 allow——D7） | ✓ 单测（判定先于设置链） |
| V6 | 存量 27 处 needPermission 零改动全绿（等价映射） | ✓ 全量 438 文件 / 3145 用例绿 |
| V7 | 门行停用 → base 档越界调用被沙箱硬拒、无审批卡（dontAsk 化，D9） | 结构保证（骨架行可 profile patch 停用；沙箱轴独立于门） |

## 五、风险与回退

| 风险 | 缓解 |
|---|---|
| 审批卡泛滥（base 档 Agent 日常被 write/pwsh 反复打断） | scope=run 免问是既有语义；risk 声明（可信工具自评 allow）是根治位 |
| risk 函数恶意恒 allow | 信任面覆盖（不可信恒 ask）；可信方自评 allow 是信任的应有收益，非漏洞 |
| 设置链三层读侧漂移 | 形态抄 shell-tools limitsOf（已验证的三层合成） |
| 回退 | 骨架行 profile patch 停用即整体下线；无数据迁移 |
