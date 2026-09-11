# M27 WebUI 纯 Slot 重构计划 · 复核报告（2026-09-07）

> **【存档 2026-11 · M30 收官后整理】** 历史评审实录（对计划 v2 的纯读
> 复核）——§7 修订清单已全量折叠进计划 v2 系并随 M27 实施收官。行号/
> 包清单为 2026-09 快照，勿按本文对拍当前代码。

> 复核对象：`docs/m27-webui-slot-refactor-plan.md`。纯读复核，无代码改动。
> 方法：① 三份输入文档（slot-tree / ownership v2 / koishi-console-research）逐节
> 比对计划引用；② 计划所引现状代码逐项核实（stores / 三注册表 / bridge /
> slots.ts / 宿主行 / 组合根 / 测试清单 / vendor cordis）；③ 本机 DSH 安装面
> 包清单核对（参照系现状）。
> 结论速览：**结构完整、事实底座扎实，可作为开工依据；存在 1 个 P0 内部
> 矛盾（D19 改裁未贯穿 S3/S4/影响面）与若干时序 / 覆盖面缺口，建议修订后
> 实施。** 修订清单见 §7。

---

## 1. 总体结论

- **事实精度上乘**：计划对现状的引用几乎全部准确，关键数字字节级命中
  （feed.ts 79828B ≈ 79KB、chat.ts 40821B ≈ 40KB）；所引测试文件、注册表
  机制、白名单门、宿主行通道均真实存在（明细见 §2）。
- **架构方向与框架纪律同构**：§0.3 数据层分权、D5 注册即归属、D6 inject
  声明依赖、D1 契约归属 owning package 的前端镜像、D20 线帧转 `ctx.emit`，
  与 src 轨道三条红线及注册中心规范全部一致，无违例（§6）。
- **核心问题一处**：Koishi 增补（D15–D20）是后补修订，**没有回头重写 D7
  时代的 S3/S4/§3 影响面**——D19（行包自带 client/ 半边）与 S3「升格为
  ac-client-ui-* 工作区包」、§3「新包 ac-client-ui-*（≥15）」直接矛盾，
  且 D19 对基础七件的物理形态留下未裁决缝隙（§3.1）。
- **次级问题**：增强级（SlotMap 类型化 / cell 选举 / store 座位 / inject）
  的补齐时序悬空（§3.2）；朴素 single fallback → cell shadow 选举的 API
  演进断层未入风险表（§3.3）；desktop 壳不在影响面（§4.1）；DSH 参照系
  版本已漂移（§5）。

## 2. 事实核查（现状引用比对，全部通过）

| # | 计划声明 | 核实结果 | 证据 |
|---|---|---|---|
| 1 | main.ts（25 行）硬编码组合根 | ✅ 实为 24 行；App.vue 直接 import 15 个组件 + 四视角注册 + 五弹窗挂载 | `webui/src/main.ts`、`App.vue` |
| 2 | 现状 10 store 归属表；feed 79KB / chat 40KB | ✅ 10 文件齐全；feed.ts 79828B、chat.ts 40821B（字节级精确） | `webui/src/stores/` |
| 3 | 8 个 UISlotId（前端 shim union）；后端 BUILTIN_SLOTS 静态表开口 6 个 | ✅ 6 项：settings-tab / agent-settings-tab / sidebar-action / perspective / tool-result-view / message-view | `shims/@agentchat/protocol.ts`、`ac-webui-extensions/src/service.ts:68` |
| 4 | 三注册表 + `xxxVersion` 版本计数响应式 | ✅ `perspectiveVersion` 等机制与 D4「同款机制」表述吻合 | `webui/src/core/registry/*.ts` |
| 5 | perspectives 的 active 谓词保留在贡献声明（D9） | ✅ `active: () => boolean` + 按注册顺序取首个 active | `core/registry/perspectives.ts` |
| 6 | `core/extensions/slots.ts` 三件 | ✅ settingsTabs / agentSettingsTabs / sidebarActions（同 id 替换 + order 稳定排序） | `core/extensions/slots.ts` |
| 7 | bridge registerXxx + assertSlot 白名单；disposers 逆序回收 | ✅ 8 个 registerXxx + request/wsOn/onUnload | `core/extensions/bridge.ts` |
| 8 | isolated iframe 档不进 slot 注册表（D8 维持现状） | ✅ ui-plugin-iframe.html + isolated.ts + p5.5-policy.ts | `webui/src/core/extensions/` |
| 9 | ac-webui entries 注册表 + `/ui-plugin/` 静态托管 | ✅ entries Map + `GET /ui-plugin/:name/*` 安全路径路由 | `ac-webui/src/service.ts`、`index.ts` |
| 10 | `pnpm --filter ac-webui-app typecheck` / `pnpm webui:build` 有效 | ✅ 包名 ac-webui-app；webui:build = `--filter ac-webui-app build` | `src/webui/package.json`、根 `package.json` |
| 11 | vendor/cordis 浏览器可用（lib 零 node 内建依赖） | ✅ src/ 下零 `from 'node:'` import；bin.js 独立于 lib | `src/vendor/cordis/` |
| 12 | S2「既有 feed 状态机测试锁零回归」 | ✅ parallel-tools / rapid-switch / resume-merge / steered-inbound / midrun-history-merge / queued-echo / group-ghost / agent-pair-isolation 全在 | `webui/tests/` |
| 13 | S1/S4 验收所引测试（port-b / e2e / CSP / 渲染性能） | ✅ portb-e2e / csp-audit / history-render-perf / markdown-render-perf 存在 | `webui/tests/` |
| 14 | slot-tree 约 240 插口、§6 收编表；ownership §3.2 七件 / §3.3 配对表；koishi 研究 §3 → D15–D20 | ✅ 三份输入文档与计划引用逐项对上 | `src/docs/webui-*.md` |
| 15 | `scripts/check-deps.mjs` 存在（S2 扩规则） | ✅ | `scripts/check-deps.mjs` |
| 16 | cordis.yml 与 ac-app TREE 两表同步（S3「进两表」） | ✅ 机制现状确认 | `src/cordis.yml`、`ac-app/src/index.ts` |

唯一数字级误差：main.ts「25 行」实为 24 行（无关紧要）。

## 3. 内部矛盾（按优先级）

### 3.1 【P0】D19 改裁未贯穿 S3 / S4 / §3 影响面

D19（Koishi 增补，后出）裁决：**行包自带 `client/` 半边替代独立
`ac-client-ui-*` 包族**，「~33 个新包的行政成本消失」。但计划前文的
D7 时代产物未随之改写：

| 位置 | 现文 | 与 D19 的冲突 |
|---|---|---|
| S3 正文 | 「in-bundle 域模块**升格为 `src/ac-client-ui-<domain>` 工作区包**（D7 清单 + ./client 出口；进 cordis.yml 与 ac-app TREE 两表）」 | D19 形态下域 UI 落在**行包内 `client/` 目录**，不新建包、不新增行 |
| S3 验收 | 「卸载 `ac-client-ui-todo` **行**（yml patch）→ 前端 todo 全部消费面消失」 | 该独立行在 D19 下**不存在**；且语义质变——D7 形态 UI 行与后端域行分离、可只摘 UI 不动后端；D19 形态**摘行 = 后端能力 + UI 一起消失** |
| §3 影响面 | 「新包：ac-client-slots、ac-client-runtime、**ac-client-ui-*（≥15）**、@agentchat/webui-kit」 | 「≥15 个新包」与 D19「行政成本消失」直接矛盾 |
| §4 行为不变量 | 「卸载任一 **UI 行**，宿主不残废」 | D19 下「UI 行」不再是独立单元，需改述为「卸载任一域行 / 客户端件」 |
| S4 | 「基础七件也升格为包（可选，与 S3 同法）」 | **D19 对基础七件没有着落**——layout / conversation / renderer / tool / sidebar / theme / settings 没有对应后端行，「行包自带半边」套不上；D19 只豁免了三基建包（ac-client-slots / ac-client-runtime / @agentchat/webui-kit）。**这是 D19 留下的真实设计缝隙**：基础七件要么独立成包（回到 D7 形态，行政成本回来一部分）、要么留在 webui 内置（与「壳也是插件」的终态叙事矛盾），需显式裁决 |

**修订方向**：以 D19 为准重写 S3/S4/§3/§4 对应条目；S3 验收改为
「卸载 `ac-todo` 行 → 该域后端 + 前端消费面一并消失且宿主不残废」；
基础七件形态单独出裁决点（建议随 S4 定，因 S1/S2 期它们以 in-bundle
插件模块形态存在，物理落点不影响前两阶段）。

### 3.2 【P1】增强级补齐时序悬空

- D15 将 SlotMap 类型化、cell 选举、store 座位、inject 面降为**增强级**
  「S1 末按需逐项加」；但 **S1 验收清单（视觉零回归）不含任何增强级条目**。
- S2 重度依赖增强级：三注册表收编需要 keyed seat + priority 选举
  （D9/D2）；feed 拆解需要 store 座位（scope key 实例化 / 引用计数 /
  会话死即清）。前置保障缺失。
- S0 的 ac-client-runtime 包描述已含「store 实例轴、onEntryError 监督」，
  与 D15「store 座位为增强级」表述冲突——S0 到底建不建 store 实例轴？
  （koishi 研究原文为「S0.5/S1 之间按需」，计划统一为「S1 末」，两处
  也未对齐。）

**修订方向**：把增强级补齐定为 **S1→S2 之间的显式验收门**（列清单：
SlotMap 声明合并 / cell+priority / store 座位 / inject 面，各带单测）；
S0 描述改为「store 实例轴骨架预留、实现 S1 末」或直接从 S0 移除。

### 3.3 【P1】朴素 single → cell 选举的语义断层未入风险表

- D15 首版（Koishi 形态）single = `children[0] ?? 默认插槽`（**fallback**）；
- D2 终态 single = cell + priority 选举（**shadow**）。
- 两者**不是超集关系**：首版按朴素语义注册的贡献，升级到 cell 选举后
  行为会变（order 排序 ≠ shadow 语义）。§5 风险表的「迁移期双轨漂移」
  只覆盖 bridge，未覆盖 SlotCore 自身两代 API 演进。

**修订方向**：风险表新增一行；并建议 S0 的 SlotCore API 直接按终态
**参数形状**设计（cell/priority 字段 S0 可不实现选举、但签名先占位），
把断层收敛为「行为增强」而非「签名变更」。

### 3.4 【P2】D13 拆桥后第三方旧 manifest 去向未写明

「manifest `ui.slots` 双读（旧 id 归一为新 id）」是**永久机制**还是
桥期机制？S3 验收「第三方示例插件经旧 manifest 声明仍可装载」发生在
拆桥**前**，拆桥后的兼容承诺悬空。若双读永久保留则无问题，但应显式
写明一句。

### 3.5 【P2】D8「registerXxx 逐一转发」措辞过宽

bridge 的 8 个 registerXxx 中，`registerGlobalStyle`（DOM style 注入 +
消毒）、`registerEventHandler` / `wsOn`（事件订阅）**不是可视面贡献**，
转 `slots.register` 语义牵强；slot-tree §6 对 ws-event / global-style
的裁决本就是「保留非视觉」。建议收窄为组件贡献类六项
（perspective / tool-result / message-view / settings-tab×2 /
sidebar-action），并注明非视觉缝走 cordis 化事件通道（D20）。

## 4. 覆盖面遗漏

1. **【P2】desktop/ Electron 壳不在影响面**。desktop 经 extraResources
   复制 `dist/`（agentchat.mjs + plugin-catalog.json + WebUI 静态产物）
   并 loadURL 3830；S3 生产期产物从单 bundle 变为**按 boot graph 编译的
   dist 模块块**、S4 CSP 审计，均波及发布形态。slot-tree §8 已自认未覆盖
   desktop，M27 作为可执行计划应把 desktop 冒烟纳入 §4（至少 S3/S4 各
   一句：`pnpm --dir desktop dist` 构建产物 + 启动冒烟）。
2. **【P3】preview-main.ts / isolated-runtime.ts 归属未提**。S4 薄壳收口
   时这两个入口搬去哪里（留在 webui / 进 @agentchat/webui-kit / 进
   ac-client-runtime）需要一句话。
3. **【P3】「~240 插口初始声明集」在 D15 首版下的形态**：string key
   无类型化阶段，「声明集」是纯运行时账本还是延后到 SlotMap 化再声明，
   S0/S1 交付物应写清（D15 分级的自然推论，但目前无落点）。

## 5. 参照系版本漂移（值得注意，不推翻计划）

- 计划与 ownership 均引「本机 dsh **0.1.1-rc.2** 实证」；当前本机安装
  已是 **0.1.2-rc.1**。
- 该版本安装面中 **`dsh-client-runtime`（SlotRegistry + SessionRuntime）
  与 `dsh-client-ui-slots`（SlotCore 纯核）两包已不存在**——SlotRegistry
  字样现住在 `dsh-client-ui-renderer` 与 `dsh-cordis-client-runner`。
- 其余参照包面稳定：dsh-cordis-client-runner / dsh-client-connection /
  dsh-client-modules / dsh-client-hmr / dsh-client-locale /
  dsh-host-frontend-static / dsh-client-ui-* 族（40+）均在。
- 影响：D0「镜像 DSH packages/client/*」的表述与 0.1.2 现状有出入；
  DSH 主动把「纯核 + runtime」合并进 renderer/runner 的动机（行政成本？
  循环依赖？）对 M27 的 ac-client-slots / ac-client-runtime **两包拆分
  决策有直接参考价值**。建议 S0 开工前复查一次 DSH 新形态并在计划头部
  更新参照版本注记。

## 6. 框架纪律符合度 ✅（与 src 轨道心法逐条对照）

| 纪律 | 计划落点 | 判定 |
|---|---|---|
| 跨插件不传实例/引用 | §0.3「不 import 他域 store 模块」红线延伸到前端 | ✅ 同构 |
| 注册即归属（caller fiber effect） | D5 + prototype 方法保 caller-ctx 绑定（DSH 坑规避） | ✅ |
| 依赖用 inject 声明，不用行序 | D6「不用行序不用时序约定」 | ✅ |
| 契约归属 owning package（无集中契约包） | D1 SlotMap declare module 声明合并（封闭 union 退役） | ✅ 前端镜像 |
| 不自建 EventEmitter | D20 线帧转 `ctx.emit`（cordis 化 onWireEvent） | ✅ |
| 新增行两表同步 + agentchat.plugin 清单 | D7（cordis.yml + TREE + keywords） | ✅ 与 checklist 一致 |
| 持久化 owning service | §0.3 层 3 域投影归域插件、会话死即清 | ✅ 延伸一致 |
| 克制（不强推全退） | D10「pinia 保留为基础件内部实现细节」 | ✅ |

## 7. 修订建议汇总

| 优先级 | 修订 | 落点 |
|---|---|---|
| **P0** | D19 贯穿全文：S3 升格/验收、S4、§3 影响面、§4 行为不变量统一为行包 client/ 半边形态；**裁决基础七件物理形态**（建议随 S4 定） | §3.1 |
| **P1** | 增强级（SlotMap / cell / store 座位 / inject）设 S1→S2 显式验收门；S0 的 store 实例轴描述与 D15 对齐 | §3.2 |
| **P1** | 风险表补「朴素 single fallback → cell shadow 选举」API 演进断层；S0 API 签名按终态参数形状占位 | §3.3 |
| P2 | §3/§4 补 desktop 壳（S3/S4 验收各一句） | §4.1 |
| P2 | D13 写明 manifest 双读归一为永久机制 | §3.4 |
| P2 | D8 措辞收窄为组件贡献类六项；非视觉缝走 D20 事件通道 | §3.5 |
| P2 | 参照系版本注记（0.1.2-rc.1 已重组 slot 基建包，S0 前复查） | §5 |
| P3 | preview-main / isolated-runtime 归属一句话；240 插口在首版的声明形态；koishi 研究文档 D16↔计划 D19 编号映射注记；main.ts 行数 25→24 | §4.2/4.3、§2 |

## 8. 复核证据索引

- 现状代码：`webui/src/{main.ts,App.vue}`、`stores/`（10 文件）、
  `core/registry/{perspectives,messageViews,toolResultViews}.ts`、
  `core/extensions/{slots,bridge,isolated,p5.5-policy,host}.ts`、
  `shims/@agentchat/protocol.ts`、`webui/tests/`（34 文件）、
  `webui/package.json`、根 `package.json`
- 宿主侧：`ac-webui-extensions/src/service.ts`（BUILTIN_SLOTS:68）、
  `ac-webui/src/{index,service}.ts`（entries + /ui-plugin/）、
  `src/cordis.yml`、`ac-app/src/index.ts`（TREE）
- 基建：`src/vendor/cordis/`（bin.js/lib/src 分离；src 零 node: import）、
  `scripts/check-deps.mjs`
- 参照系：本机 `@deepseek-ai/dsh` 0.1.2-rc.1 安装面包清单
  （node_modules/@deepseek-ai，dsh-* 全量列名 + SlotRegistry 归属包检索）
- 输入文档：`src/docs/webui-{slot-tree,plugin-ownership,koishi-console-research}.md`
