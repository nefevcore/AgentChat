# 设计：插件 client 通道（R7-9 收束）

> 状态：**设计成文（cr-687，2026-10-25）**，实施分四批（§3）；本文件是 R7 板第 9 项的执行端设计。
> 上游定调：`src/docs/ui-tree.md` §3（一份 manifest 三树投影）/ §5（四级自定义阶梯，③ = 挂拓扑 + 换壳）。
> R7 板四项待设计：schema / 注入语义 / 拓扑贡献开放度（③ 级）/ 存量收敛批次。
> 事实核对基准：2026-10-25 工作树（对照代码逐条核实，非档案推演）。

## 0. 现状（实测）

| 面 | 实况 | 位置 |
|---|---|---|
| schema | UiManifest 7 字段：`name` / `version` / `entry` / `platform` / `seats` / `isolated` / `styles` / `channelImports` | `ac-webui-core/src/manifest.ts` |
| 校验 | 纯数据校验 + 路径逃逸拦截（entry / styles / channelImports）——第三方零宿主执行 | 同上 `checkUiManifest` |
| 下发 | `assembleBootGraph` 扫 `<dataRoot>/plugins/*/manifest.json` → `BootGraphEntry[]`（坏 manifest fail-loud 跳过并记 warning） | 同上 |
| 装载 | 骨架 3 件 in-bundle（theme → renderer → layout）→ `sealFactory` 封印 → 逐条动态 import（逐条隔离，单模块缺席不毁表面）→ mount | `preview/apps/ui/client/boot.ts` |
| 外部化 | `channelImports` 声明 = rollup external ↔ 运行时 importmap（blob re-export 模块）取宿主同构单例 | 同上 `installChannelImportmap` |
| 隔离 | `isolated:true` = iframe + 父窗口白名单代理（GET 只读端点 + 4 事件） | `ac-webui-core/src/isolated-policy.ts` |
| 席位 | **`seats` 字段只声明、不消费**——校验与下发都有，装载器从不读；席位实际由模块 `default export` 在 `apply` 内自注册（实测：`seats` 仅测试引用） | 核对结论 |
| 存量 | 29 通道包（`preview/apps/ui/channel/<name>/`，`src/index.ts` = re-export 主线 clientPlugin；manifest 由 `gen-domain-channels.mjs` 生成） | `preview/apps/ui/channel/*` |

**结论**：阶梯 ①（令牌/主题数据）与 ②（席位贡献）机制在；③（挂拓扑 + 换壳）**既无 schema 面也无注入面**。

## 1. 开放点一 · 注入语义（seats 声明怎么落地）

**问题**：`seats` 声明与实际注册无对账——写了不注册、注册了不声明，两种漂移都静默。

**裁决**：`seats` = **契约声明 + 宿主对账**，不做宿主代理注册。

- 理由：代理注册要求「声明 → 组件」映射，而第三方组件不在宿主模块图内——非隔离档靠 `moduleHost` 自注册本就可用；隔离档组件在 iframe 内，宿主代理也拿不到。
- 落地：装载器在条目装载后读宿主 SlotCore 实际注册面，与 `manifest.seats` 双向对账：
  - 声明了但该 key 无本模块贡献 → warning（诊断面 + 装配面板可见）；
  - 注册了但未声明 → warning（**不拒载**——保护第一方零改动导入的存量语义）。
- 收益：零新机制、零破坏；把「声明」从纯装饰变成可核验契约（SlotCore D1 fail-closed 精神的一致延伸）。

**隔离档粒度**：`isolated:true` 的席位贡献 = **整块容器**（宿主把 iframe 容器作为该 key 的 tier-1 贡献挂上，容器内自绘）。
◐ 待钉：容器席位命名——建议 `iframe:<name>`，一眼可辨且不与第一方席位竞争选举。

## 2. 开放点二 · 拓扑贡献开放度（③ 级两半）

### 2.1 挂拓扑（新席位 / 新视角）

**现状空洞**：SlotCore D1「未声明拒绝注册」（fail-closed），而声明只能由 owning 件在编译期 `declare module` 做 → 第三方无法新开席位；视角注册面（`registerPerspective` / mainViews / auxSidebarViews）是包内 API，通道够不着。

**裁决**：`manifest.seats` 增两词形 + 一个视图声明：

```jsonc
"seats": [
  { "seat": "tool-card" },                              // ① 既有席位贡献（现行词形，不变）
  { "seat": "new:acme:panel-body",                       // ② 新开席位（kind/scope 随行）
    "kind": "list", "scope": "session" },
  { "seat": "acme:panel-body",                            // ③ 视角挂载（渲染承载）
    "view": { "region": "aux", "id": "acme", "label": "Acme" } }
]
```

- **②** 由装载器调 SlotCore `declare`（tier-1 动态层）并登记「谁声明了本席位」（诊断面）；**仅 isolated:false 允许**（要能拿宿主单例）。
- **③** 视角条目由 layout 开放 `registerView`——**这是 layout 骨架在本设计内唯一要新增的 API**（现有 mainViews / auxSidebarViews 选举解析面的公开入口）。**已落地（B3/cr-694）**：`ac-client-ui-layout/client/registerView.ts`——ViewRegistration { region: main|aux, id, label?, component, order?, active? }；entry id 词形 view.<id>；缺省 order 100 + active 恒真 = 不抢占出厂视图（main 轴与 chat 平局、chat 先注册恒胜；aux 轴让位出厂选区）。隔离档由宿主装载器消费 view 词形代挂容器（boot.ts → isolatedViewComponent → handle.mountTo）。
- 约束（防走样）：② 声明的席位若无人渲染（无 outlet）= warning 不拒载；③ 的组件承载：非隔离档 = 第三方导出组件，隔离档 = iframe 容器。

### 2.2 换壳（形态壳 / 主题 / 内容渲染管线）

| 半 | 现状 | 裁决 |
|---|---|---|
| 主题换肤 | `styles` 字段 + L0 令牌层已通（cr-577 / cr-673） | **纯数据模块，本批直接开**：manifest 增 `theme: { tokensOnly: true }`；校验 = 令牌词汇完备性（缺项回落缺省，ui-tree §2 规则） |
| 内容渲染管线替换 | markdown 管线住 renderer（模块资产 markdown-render） | ◐ 待钉：renderer 增「内容渲染器注册表」（`useMarkdown` 消费者改为查表、缺省 = 内置），第三方提供渲染器组件 |
| 形态壳替换（layout variant） | 形态壳 in-bundle 固定 3 件 | ◐ **本阶段明确不做**：换壳 = 提交一整份拓扑契约实现，用户诉求主要在视角与主题，收益低成本高（骨架替换 = 整页重载 + 契约完备性校验）。记 v2 候选 |

## 3. 开放点三 · 存量收敛批次

| 批 | 内容 | 门 |
|---|---|---|
| B1 | seats 对账（§1）+ manifest 校验扩展（`new:` / `view` / `theme` 三词形） | preview 单测 + 29 通道全装对账 |
| B2 | 主题包通道（§2.2 第一行）：令牌校验纯函数 + 一个示例主题包 | 令牌完整性测试 + CDP 活体（换肤生效） |
| B3 | 视角挂载（§2.1 ③）：layout `registerView` + 隔离档容器承载 | 三档测试（非隔离组件 / 隔离 iframe / 缺席不毁表面）——**已落地（cr-694）** |
| B4 | 宿主树 ui 组终态清空（cordis.yml 撤 `ac-client-ui-*` 行） | **前置 = 通道包物理迁出 + 旧树退役**（见 §6，本批不做） |

## 4. 与既有裁决的一致性

- **唯一通道零特权**（cr-474）：第一方 29 通道与第三方走同一 manifest / 装载面——本设计不改通道，只加声明词形。
- **信任边界**（ui-tree §1）：③ 级能力全部要求 `isolated:false`（要能拿宿主单例）→ 信任升级 = 安装时人工审（与 cr-543 `highRiskSlotsOf` 人审载荷同源）。
- **三个防走样**：不引入第二 transport（仍 manifest → boot graph → 静态资产 → 动态 import）；不做过渡态（`new:` / `view` / `theme` 三词形 additive，旧 manifest 零改动）。

## 5. 明确不做

- 形态壳替换（v2 候选，§2.2 第三行）。
- 第三方经 isolated 档拿到细粒度席位（容器级已是上限——细粒度必走非隔离 + 人审）。
- 宿主代理注册（§1 已裁）。

## 6. 附：通道包物理迁出的顺序耦合（item 3 勘察结论）

handoff §3.5 第 3 项「29 通道包物理迁出 + 双占名回收」与前置于它的旧树退役**强耦合**，实测：

- 旧树 `src/cordis.yml` 明文引用全部 29 个 `ac-client-ui-*` 行包，`dev:legacy` = `node src/ac-app/src/boot.ts` 是**终极回滚线**；把包移出 `src/` 会连带回滚线一起断。
- 双占名回收（`ac-credentials` / `ac-conversation` / `ac-webui-app`）**只能**在旧树退役后做——三名的占位者正是 `src/` 内同名包。
- 两条可选路径：
  - **路径 A（与退役同批）**：退役批内一次完成「移出 + 撤行 + 删旧树」——回滚线在批量动作开始时即作废（本就是退役语义），风险集中在一个批。
  - **路径 B（提前迁出、保回滚）**：目录移到 `preview/packages/ac-client-ui-*` 但**保留包名**（workspace globs 已覆盖，按名 import 全部不变，旧树仍可解析），随后单独补 CI/typecheck 覆盖面（根 `tsconfig` 的 `src/*/client/**/*.ts` 不再覆盖它们 → 需挂到 `preview/packages/tsconfig.json` 的 `ac-*/client/**/*.ts`，而 preview 按设计不进主线 CI 门禁，故须显式决定是否把这条纳入门禁）。
- **建议**：路径 B 先做（把「物理迁移」与「退役」两件大动作解耦，各自可验证），B 完成且判据过门后再走退役批；CI 覆盖面在 B 批内显式补齐（不把 31 包前端资产放出类型门禁）。
- 量化：31 包 / 247 文件 / ~2.3 MB（`ac-client-ui-conversation` 847 KB 最大）；catalog 仅 `webui` 一行 path 数组引用其中 3 包需同步。

## 7. ◐c 退役批侦察数据（2026-10-25 重算闭包，cr-695 备料）

执行批前置侦察（只读全仓扫描，三面核证）：

1. **A 类 25 包 preview 零引用复核成立**——preview 全部 package.json 依赖面（裸名 ac-* 形态）与源码 import 面（from 'ac-xxx'）双扫描，A 类 25 包零命中（R6.1 快照 2026-10-23 结论在 2026-10-25 工作树依然成立；cr-692 改主线 A 类包内容属内容修改，不产生依赖边）。
2. **主线树内部 200 边**：全部在旧树内部闭环——ac-app 组合根 26 边、A 类互依、B 类涟漪 34 文件（B 类 src/index.ts 值引用 + 测试引用；退役批须同步处置：值引用改判 B→A 或删测试，见 R6.1「改判」条款）。
3. **ac-client-ui-* 31 包**：31/31 全部在 preview 依赖集（ac-client-runtime [30] 为最大消费面）——物理迁出（路径 A：迁 preview/packages/）后主线仅剩旧树自身引用，随树退役消亡。
4. **双占名三件**（ac-credentials / ac-conversation / ac-webui-app）：占位者均在 src/ 旧树，退役后三名可回收给 preview 同名包（恒后置退役批）。

涟漪清单（B 类引用 A 类的 34 文件）已实测备档：值引用 12 处（src/index.ts 或 src/*.ts）ac-collab-tools/goal/file-snapshots/issue-tools/persona/harness-tools/web-tools/system-prompt/sap-adt/todo + scripts/migrate-llm-pool-v2.ts；测试引用 22 处。退役批处置原则（R6.1 既有条款）：值引用 → 被引用 A 类包改判 B 类保留；仅测试引用 → 测试随旧树语义退役或改桩。
