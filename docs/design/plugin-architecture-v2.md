# 插件体系 v2.1——实施规范（plugin-architecture-v2）

> cr-900（2026-11-05）初稿 → cr-901（2026-11-05）重写：并入 23 条审计
> 裁决。取代 cr-898 / cr-899 补丁路线。参照系 DeepSeek Harness（实物证据：
> `~/.dsh/profiles/desktop/`、app.asar 出厂技能摘录 `sandbox/dsh-plugin-skill/`、
> 实机数据根 `workspace/home/`）。patch 方言 = **cordis-plugin-loader 官方
> 语法**（本档不自造文法）。
>
> 规范用语：**必须 / 禁止 / 仅可** = 强制；「裁决」条目记录结构性选择理由，
> 偏离须先改本档。

## 一、诊断（为什么推翻）

三种插件格式、两张注册表、两套进入路径、零依赖零升级、发布无渠道、生效
无回执；根因 = 落位层自建平行体系（详见 cr-898/899，诊断仍成立）。v2.1
在 v2 基础上吸收审计修正：落位多物化形态、装配分层合成、基座源码化、
框架配置域消灭、回执两轴、启动注册表住应用侧。

## 二、参照系（DSH 四条已验证机制 + cordis 原生能力）

1. **包即插件**：package.json + `dsh` 字段分面；进程差异只是内部分面。
2. **落位多形态**：行名解析原生支持包名 / 路径 / file URL（abap 预设
   `file:///C:/...` 实证）；engines 自求值（装载器读字段自己 semver 判定，
   不依赖包管理器）。
3. **组合文档单源**：出厂与用户同方言编辑同一组文档，分层胜负显式回报。
4. **治理挂审批与回执**：approvedBuilds；生效态显式回报，「装了但没生效」
   不可能静默。

## 三、术语与本体论

- **Agent ≡ shell（两态）**：定义态 / 运行态，一 Agent 一壳。
- **进程种类**：host / webui / shell / …开放集。**webui = 可独立部署的
  前端产物**（断连降级、功能失效），不是宿主 spawn 的普通子进程。
- **装配 / 插件配置 / 人格**：装配 = 装了什么 × 什么档位（能力面，含
  安全语义）；插件配置 = 各插件自定自读的文件（框架不解释内容，零安全
  含义）；人格 = persona 类插件消费的数据工件。**框架级 settings 域消灭**。
- **基座 / 菜单 / 分层合成**：基座 = 进程种类的出厂装配（repo 源码化）；
  菜单 = 机器可挂集；Agent 装配 = overlay（非快照），编译产物快照承担
  审计视图。

## 四、架构规范

### 4.1 插件单元：包即插件，TS 源载统一形态

唯一格式 = npm 包（或等价目录），AgentChat 专属声明住 `ac` 字段：

```json
{
  "name": "ac-plugin-todo",
  "version": "1.0.0",
  "engines": { "node": ">=23", "agentchat": "^2" },
  "ac": {
    "faces": {
      "node": { "entry": "./src/index.ts" },
      "web":  { "entry": "./client/index.js", "seats": ["tool-card"] },
      "data": { "skills": "./skills", "theme": "./theme" }
    },
    "permissions": ["fs"],
    "provides": { "tools": ["todo-add"] }
  }
}
```

- **裁决：TS 源载统一形态**——出厂行与第三方行**同一装载形态**（entry
  指 `.ts`，Node strip-only 直载），禁止引入构建产物链；`engines.node`
  门住 strip 能力。插件作者零构建（publish 无 build 步）。
- **裁决：兼容门自求值**——`engines.agentchat` 由装载器读字段自做
  semver 判定（DSH 同款自实现，不依赖 pnpm）；peerDependencies 不作门，
  仅可选元数据；版本范围随 v2 发版冻结 ABI 再定；旧 `contracts` 字段
  迁移期映射列批 2。
- faces 三面：**node**（进壳进程，授权面）、**web**（浏览器，降级面）、
  **data**（技能/主题/人格，零装载纯物化）；node 面禁止细分 host/shell
  （多进程贡献 = 子路径 entry 在不同基座插行）。
- **web 面约定 = DSH UI 插件形态**（单独设计文档，批 3 交付）：浏览器
  可直载 JS 模块 + 宿主模块表供共享依赖；**channelImports 机制退役**；
  seats 对象词形（seat/view/kind/scope）保留。命名词法（asset 路由 /
  manifest 正则）随批 3 放宽或约定（npm scope 可用性列开放问题）。
- 保留字护栏、provides 对账、owner 私有性保留，换读 `ac` 字段。

### 4.2 落位与物化：行名定位，多物化形态

**裁决：物化位置不是身份，patch 行名定位才是**。行条目以 `name` 定位
插件（cordis 原生解析）：

```yaml
- id: my-todo
  name: "ac-plugin-todo"          # npm 形态 → pnpm 落位
- id: my-local
  name: "link:C:/.../my-plugin"   # link/目录形态 → 直指源码
```

| 形态 | 落位 | 依赖解析 | 定格指纹 |
|---|---|---|---|
| npm（`@pkg` / `pkg`） | profile/ pnpm 根（lock 锚定） | **完整** | 锁文件树指纹 |
| link / 目录 | 原址或 `<dataRoot>/plugins/<name>/` | **禁止裸依赖**（import 失败 = 装载失败；需依赖必须走 npm 形态） | 内容 hash（随数据根备份完整） |

- Agent 自开发：源码住 `files/<agentId>/<name>/`，dev 态会话级装载
  （watch 热重载，重启即失）；定型 = 物化到 `plugins/<name>/`（目录
  形态）或发 npm（npm 形态），由安装器代写 installed 行（owner 锚）。
- 门禁：安装器检查各插件包 `ac` 字段 / engines / 依赖声明，豁免规则
  可配置（豁免 = 显式记录的例外，非默认放行）。
- 升级 = npm 形态换版本重装 + lock diff 审批卡；目录形态 = 重物化 +
  内容 diff。三入口（市场一键 / 对话安装 / CLI）共享同一安装器。

### 4.3 激活：基座族 + 分层编译

**文档族**（cordis-plugin-loader 官方方言；写者分立）：

| 文档 | 写者 | 内容 |
|---|---|---|
| `profile/<proc>.patch.yml`（host/webui/shell/…） | **repo 源码化**，随 app 部署覆盖 | 进程基座（**行集互有重名，如 config 在 host/shell 各一条——id 仅基座内唯一**）；带版本戳，boot 对账（源新物化旧 = fail-loud） |
| `profile/<proc>-custom.patch.yml` | 用户 / 设置 UI | 该基座的手写偏好（disable/override/点名）；**顶层 cordis.patch.yml 退役**——全局文件无剩余职责 |
| `profile/installed.patch.yml` | 安装器 | 第三方行登记（`name` 定位 + owner 锚；`scope` = 基座文档名，仅 insert 必填） |
| `profile/presets/<name>.patch.yml` | 出厂/模板层 | 命名组合变体 |
| `agents/<id>/agent.patch.yml` | 用户 / 创建流 | Agent 装配 overlay（§4.4） |

- **裁决：row-catalog 退役**——基座在 repo 内直接维护（每进程一份源
  文档），取代「catalog 单源 + tree 字段」；tree 字段与目录扫描检测面
  随之退役。基座源文档 = 行→包映射的单一事实源。
- **裁决：装配分层合成（overlay，非快照）**——平台新增行经基座→preset
  自动到达 Agent；**行消失 = 降级语义**：agent 层点名已删行 → 警告 +
  跳过 + 上报（回执/healthz），禁止阻断 boot。审计视图 = 编译产物快照
  （boot-graph 缓存，「这个 Agent 实际装了什么」一眼可读）。
- **owner 锚与共享**：owner 行仅进 owner Agent 候选集（非 owner 壳不
  解析不装载）；共享 = owner 侧显式放行 + 对方 agent.patch 点名，放行
  动作**人签**（Agent 不可代签）。
- **web 面统一通道**：工厂 web 件禁止打进 SPA bundle，全部（工厂+
  第三方）经同一资产通道按 webui 装配文档装载——恢复 cr-474「零特权
  路径」，工厂 web 件从此可被 override/disabled。工厂件的 TS/Vue→JS
  构建步保留（浏览器不 strip TS），但产物走统一通道（无特权路径 ≠
  无构建）。

**分层编译**（每 Agent 壳 boot）：

```
基座(shell) → shell-custom → installed(菜单, owner 锚)
  → preset 变体 → agent.patch（overlay + origin 块）
  → 插件配置叠参数（各插件自读）
  → 菜单校验（点名不在菜单 = 警告+跳过+上报，第三方 insert 引用缺失物化 = fail-loud）
  → inject 拓扑装载
```

host：基座 → host-custom → installed(scope:host 仅出厂) 直装。
webui：基座 → webui-custom → installed(scope:webui)，前端侧求值。

### 4.4 Agent 定义：装配 + 插件配置 + 人格

```
agents/<agent-id>/
  agent.patch.yml      # 装配 overlay：行成员 + 档位词 + origin 块
  <plugin>.json …      # 插件配置：各插件自定自读（如 mcp.json），框架不解释
  *.md                 # 人格文档：persona 插件按自身配置选择（文件名不写死）
  sessions/ children/ interactions.jsonl …   # 运行产物（原样）
```

- **裁决：档位词全部归装配**（含现 settings 行内档位——observe/
  manipulate/inject/admin/dev 等，X1 换轨回滚）：能力面 = 装了什么 ×
  什么档位，同居可审计文件；**框架级 settings 域消灭**，`config.json`
  的 Agent 级形态退役，插件配置各归插件（后续逐步降格为纯插件域文件）。
- **裁决：system 退役**——系统提示由平台行分权组装（system-prompt
  去中心化方向）；人格 = persona 插件消费的数据（patch 直写或指定文件）。
- **insert 权与选择权分离**：往基座加新行 = 安装器（Agent 触发仅限
  owner 域，审批卡人签不可代签；最坏情况 = 给自己壳装代码，与既有
  run-code 权力等价，无净增）；从菜单挑选 = agent.patch 天然权力。
- origin 块内嵌 agent.patch.yml 头部（取代 preset-origin.json）：创建
  来源 preset + 指纹；preset 演进 → 对账提示，跟随显式选择。
- preset 活体（`__standard__` 等）：模板层 = profile/presets/ 文档 +
  包内模板；活体 = agents/ 目录（运行产物照旧）；编辑活体模板层 = 改
  未来出生配置（对账提示，粒度批 4 定）。
- 运行时注册的动态 Agent：注册时物化 agent.patch.yml（契约仍是数据
  形状）。update_agent_profile IPC 兼容列批 4。

### 4.5 治理：一张卡 + 分轨指纹 + 两轴回执

- **审批卡**（仅 node 面）：permissions + provides + 来源锚定 + 依赖
  树变更（lock diff）+ 豁免规则命中清单。**免审 ≠ 无门禁**：web 面保留
  ui 权限显式授予 + 高危席位（perspective 类）评审；免审面 RPC 白名单；
  data 面（skills/persona）如实定性为提示注入面——来源徽章 + 署名；
  **ignore-scripts 强制**。
- **定格指纹分轨**：npm 形态 = 锁文件树指纹；目录/link 形态 = 内容
  hash。link 的 watch 仅 dev 态会话级，不触安装态定格。
- **回执两轴**：`install-result（applied / failed / needs-reinstall）×
  effective-state（live / restart-required / overridden /
  blocked-by-live-process，per-process）`——后者联动 activation.lock
  （Windows EPERM/EBUSY 场景显式回报）。
- **安装器事务**：根锁复用 withRootLock 先例；半态恢复；healthz 为
  新增面（列批）。
- 熔断（load-health）、审计日志保留。

### 4.6 用户旅程（验收标准）

- **安装 30 秒**：市场搜到 → 点装 →（仅 node 面）一张审批卡 → 两轴回执。
- **发布三命令**：`ac plugin init`（零 PLACEHOLDER）→ `ac plugin dev`
  （watch 热试跑）→ `ac plugin publish`（TS 直发 npm + keyword 自标，
  **无构建步**）。分发 = npm keyword 约定，零自建 registry。
- **卸载对称**：一键摘除，摘掉即降级。

### 4.7 进程边界与启动（不动 + 补齐）

- R0a 保持：宿主永不装载第三方代码；node 面在壳进程，web 面在浏览器，
  data 面零装载。
- **裁决：启动脚本禁止进数据根**（boot 目录提案否决——用户可写区获得
  boot 期代码执行 = 最高特权面入口放在最不可信存储）。**进程种类注册表
  住应用侧**（repo 内声明式清单：boot 入口 / spawn 与 argv 契约 / IPC
  与端口 / 审批归属）；数据根仅**声明式启用配置**（并入既有 config.json：
  启用哪些进程形态、端口），无脚本、无轮询。「加一种进程 = 注册表一行 +
  一份基座源文档」，两处都在受治理的 repo 内。
- webui 独立部署定性：前端产物可脱离宿主存在（断连降级）；其装载与
  宿主连接协议单独设计文档（与 UI 插件形态文档同批）。

## 五、数据根布局（实机推演，workspace/home 为基）

```
<dataRoot>/
  ── 不动区 ─────────────────────────────────
  agents/<id>/（含 preset 活体）
  files/<id>/              # 沙箱；自开发插件源码
  groups/ memory/ usage/ timer/ … sap-adt/ remote/
  config.json              # 全局配置 + 进程启用声明（声明式，无代码）
  .runtime/                # 易失运行时态

  ── profile/（装配与物化）──────────────────
    host.patch.yml · host-custom.patch.yml
    webui.patch.yml · webui-custom.patch.yml
    shell.patch.yml · shell-custom.patch.yml
    installed.patch.yml    # 安装器代写（owner 锚）
    presets/<name>.patch.yml
    package.json · pnpm-lock.yaml · node_modules/   # 仅 npm 形态解析

  ── plugins/<name>/       # 目录形态物化（含自开发定型）

  ── 退役区 ─────────────────────────────────
  plugin-rows.json · host-rows.json（→host-custom）
  agents/<id>/config.json（→agent.patch + 插件配置）
```

备份口径：**lock + patch + plugins/ 随行，npm 形态 node_modules 重装**
（恢复钩子 + needs-reinstall 回执）。迁移账：**注册表零存量、身份全量
迁移（12+，每份 config.json 都是 rows+tags+settings 三合体）**。

## 六、旧体系退役清单

| 旧物 | v2.1 去向 |
|---|---|
| row-catalog.json（含 tree 字段） | 基座源文档（repo 内，每进程一份） |
| 动态插件 manifest.json | `ac` 字段（迁移投影） |
| plugin-rows.json / host-rows.json | installed.patch / host-custom.patch |
| UI 通道 + channelImports + plugins/ 副本 | 统一资产通道 + webui 装配文档；channelImports 退役 |
| staging 人审全套 | 审批卡 + 分轨指纹 |
| AgentConfig（rows+tags+settings+system 混居） | agent.patch.yml（装配+档位+origin）+ 插件配置 + persona 数据 |
| settings 行内档位（X1） | 回滚归装配 |
| preset-origin.json | agent.patch.yml origin 块 |
| 模板 PLACEHOLDER | `ac plugin init` |
| register_plugin 幂等不重载 | dev 态默认重载 + watch |
| HOST_CONTRACTS_VERSION + contracts 字段 | engines.agentchat 自求值（迁移映射批 2） |

## 七、迁移批次（每批必须含：验收判据（对哪些既有 e2e/单测负责）/ 开关
与灰度 / 双读窗口（新旧读路径并存时谁赢，窗口起止）/ 回滚点 / 数据
迁移可逆性）

1. **基座源文档**：row-catalog → host/shell 基座源文档 + 版本戳部署
   链；行为等价锁定（出厂装配链 e2e 全量）。webui 基座随批 3。
   > **实施注记（cr-902，2026-11-05 落地）**：基座落位
   > `apps/catalog/profile/{host,shell}.patch.yml`（官方方言顶层数组；
   > tree 由文档隐含；name = `link:` 仓库相对路径，多包行 packs 全列）。
   > 版本戳 = 文档头注释 `# ac-base-version: N`（顶层数组不容元数据
   > 字段——注释位是 DSH patch 文档先例）。row-catalog.json 转生成投影
   >（`scripts/gen-row-catalog.mjs`），readCatalog 双读（基座在场即赢），
   > 投影等价测试锁漂移。部署链：host boot 物化 repo 基座 → 数据根
   > `profile/`；对账裁决——副本缺席/源更新 = 重物化（repo 开发态无
   > 安装步，boot 即部署链本体），副本更新（旧应用压新数据根）/同版本
   > 内容漂移（编辑未升戳）/写后读回不符 = fail-loud。bundle 构建随
   > row-catalog.json 同步拷贝 profile/。
2. **落位与安装器**：行名定位 + 多物化形态 + 依赖分层规则 + 根锁/
   半态恢复 + 两轴回执 + 审批卡 + engines 自求值 + 旧 contracts 映射 +
   healthz 新增面。双读：plugin-rows.json 旧读路径窗口兼容。
   > **实施注记（cr-905，2026-11-05 切片一落地）**：UI 插件形态文档 =
   > `docs/design/ui-plugin-form.md`（现状基线 + 四处收口 + 四切片）；
   > webui 基座源文档 v0 已生成（`apps/catalog/profile/webui.patch.yml`，
   > 生成物——事实源 apps/ui/channel/*，`scripts/gen-webui-base.mjs` +
   > 漂移锁定测试；无消费面，分层求值随切片三）。channelImports 退役、
   > 词法放宽、包形态装载随切片二至四。
   > **切片二（同 CR）已落**：宿主模块表单源 `apps/ui/scripts/host-module-table.ts`（71 键 = skeleton ∪ shared，构建面/装载面对账锁测试）——build-channel external 全表恒等 + 产物 manifest 摘 channelImports（退役字段；存量产物双读窗口内兼容）。
   > **切片三（cr-905 续）**：webui 分层求值落地——synthesizeWebuiGraph（基座 − custom 停用 ∪ installed(scope:webui)；停用赢过存量兼容窗；点名缺席 = 警告跳过、未点名在场 = v1 存量兼容窗仍下发；上报面 = boot graph warnings 域）+ materializeBaseDocs 部署 webui 面 + name 词法放宽（@scope/name）。
   > **切片四（cr-905 续）**：包形态装载落地——assembleBootGraph 经 readChannelManifest（manifest.json 迁移期优先；缺席读 package.json ac.faces.web——seats 字符串词形投影 SeatContribution、isolated 缺省 true；node-only 包零警告 不进 graph）。**批 3 四切片全部完成。**
3. **web 面统一通道**：UI 插件形态文档（DSH 式模块表，channelImports
   退役）+ webui 基座 + 工厂 web 件出 SPA（cr-474 恢复）+ 词法放宽。
   > **实施注记（cr-906，2026-11-05 切片一落地）**：agent.patch.yml 读写层——AgentConfig 投影（rows/tier/tool-mode/档案面/settings 随行/origin 块；tags 由档位词重建、消费面零改动；system 不迁=退役面）+ readAgentConfig 双读（patch 在场即赢，config.json 旧读窗口兼容）+ writeAgentConfig 双落（patch 主写 + config.json 镜像——旧读者不断链、回滚 = 删 patch 即回旧形态）。切片二（已落）：settings → agents/<id>/<unit>.json 拆分（单元文件赢、patch 内联为窗口兜底；保留字只锁文件占位名——目录域与 <unit>.json 无文件系统冲突；preset-origin 留待并入 origin 块）。余项：（preset-origin.json 并入）+ system 退役、update_agent_profile IPC 兼容 + X1 档位回滚盘点。
4. **Agent 定义重构**：身份全量迁移（12+）——AgentConfig → agent.patch
   （rows+档位+origin）+ 插件配置拆分 + system 退役 + settings 档位
   回滚（X1）+ update_agent_profile IPC 兼容 + persona 文件选择权。
   双读：readAgentConfig 旧读路径窗口兼容。回滚点 = 迁移脚本可逆。
   > **实施注记（cr-907，2026-11-05 切片一落地）**：init/publish/finalize 三命令
   > （scripts/plugin-cli.mjs + bin 拦截 + `ac` 别名）——init 零 PLACEHOLDER 包形态
   > 脚手架（ac 字段 + owner 私有工具模板 + keywords agentchat-plugin 自标）；
   > publish 门禁复用 admissionOf + npm publish 无构建步；finalize 定型物化 =
   > 统一安装器代写 installed 行 owner 锚。dev（切片二已落）：watch 热试跑——门禁 + 装载冒烟（模块即插件契约同壳内 loadSession——命名导出 apply、?t= 缓存穿透取新代码）；壳内会话级试跑沿用 register_plugin。**批 5 全部完成。**
5. **作者工具链**：`ac plugin init/dev/publish`（TS 直发）+ 自开发
   link/watch + 定型物化。
   > **实施注记（cr-908，2026-11-05 批6 切片一）**：装配菜单合流——installed.patch.yml
   > 进壳行集派生（owner 锚 + link:/npm 词形解析 + 降级语义 + 装配器注册）；
   > market 人签安装 owner 锚留空（全体候选）。plugin-rows.json 转纯镜像窗口。
   > 余项：旧文件物理退役（随数据根迁移收尾——需部署动作）、README/发布链同步。
6. **拆旧**：row-catalog / plugin-rows / host-rows / staging / 播种 /
   settings 域退役；存量迁移脚本收尾。

## 八、备选与拒绝理由（含本档自身迭代中否决的方案）

- cr-898/899 补丁路线；koishi 深合并；install 态热重载；`runtime/` 目录名。
- **单组合树 + 行锚 tree + boot 过滤**（v2 中间方案）：R0a 靠规则不靠
  结构；两值枚举焊死拓扑。
- **agent.patch 全量替换 AgentConfig**（v2 中间方案）：四处断点——由
  装配/配置拆分取代。
- **快照形态 agent.patch**（v2 中间方案，审计 #3 否决）：基座演进无策略
  ——平台新行静默缺失、删行永久 boot 炸；由 overlay + 降级语义取代。
- **顶层 cordis.patch.yml**（v2 中间方案）：per-base custom 后无剩余职责。
- **pnpm 独占据位**（v2 初稿）：行名定位多形态取代；依赖分层规则保住
  依赖解析的必要性。
- **dist 直供特权通道**（v2 中间方案）：重建 cr-898 两条路径病根、SPA
  内模块不可 disabled；统一通道取代。
- **boot/ 目录进数据根**（审计会话提案）：boot 期代码执行入口放进用户
  可写区 = 安全红线；进程注册表住应用侧取代。
- **四词单枚举回执**：三种语义塞一个枚举；两轴取代。
- **自建 plugin registry 服务**；**per-Agent 全量组合词汇**；**peerDependencies
  作兼容门**（pnpm 不求值自定义键）。

## 九、风险与开放问题

1. **供应链面**：npm 形态传递依赖进壳进程——lock 树指纹 + 审批卡 +
   ignore-scripts 强制对冲；批 2 前安全复查。
2. TS 直发的 npm 惯例代价（包体含 TS、strip-only 语法红线约束第三方
   作者）——若生态反馈受阻，批 5 可加可选构建档（不回退统一形态）。
3. UI 插件形态（ui-plugin-form.md，cr-905）；webui 独立部署连接协议（webui-standalone-protocol.md，cr-912 立档——实施切片随后继批）；web 产物随包自持与原位服务（ui-plugin-selfhost.md，cr-919 探索立档——播种/部署拷贝退役方向）。
4. npm scope 与既有 asset/manifest 词法冲突的收敛（放宽正则 or 命名
   约定）：批 3 定。
5. Windows link 跨盘；离线/私域 registry；安装 30 秒实测（批 2 验收项）。
6. 预设活体编辑的对账粒度（文件级/字段级）；身份全量迁移的档位词
   映射表：批 4 定。

## 十、实施收口台账（cr-908，2026-11-05 全景核对）

已落地（CR：902/903/904/905/906/907/908）：

| cr-901 条目 | 状态 |
|---|---|
| §4.1 包即插件（ac 字段 / engines 自求值 / faces 三面 / 旧 contracts·manifest 迁移投影） | ✅ |
| §4.2 落位多形态（link·目录 / npm pnpm 根 + 锁指纹 / 门禁豁免留痕 / 升级 diff / 三入口统一安装器） | ✅ |
| §4.3 基座源文档 host/shell/webui + 版本戳部署链 + 对账 fail-loud | ✅ |
| §4.3 web 面统一通道（模块表单源 / channelImports 退役 / 分层求值 / 包形态装载 / 词法放宽） | ✅ |
| §4.4 agent.patch.yml（装配+档位+origin）+ 插件配置拆分 + system 退役 + X1 levels 回滚 + 迁移脚本（幂等可逆） | ✅ |
| §4.5 治理（审批卡载荷 / 两轴回执 / 分轨指纹 / needs-reinstall / healthz / ignore-scripts） | ✅ |
| §4.6 用户旅程（安装 30s 实测 43ms / 发布三命令 / 卸载对称） | ✅ |
| §七.6 前置：装配菜单合流（installed.patch.yml 进壳行集派生 + owner 锚 + 降级语义） | ✅ |

余项（后继 CR——均为独立可交付件，不阻塞 v2.1 主体验收）：

| 条目 | 性质 |
|---|---|
| ~~host-custom / shell-custom.patch.yml 用户偏好层~~ ✅ cr-909（停用面落地：host 派生合流 + shell 基座减法；override/点名随设置 UI 扩展） | 已落 |
| profile/presets/<name>.patch.yml 命名组合变体 | 裁决：现模板层（preset-builtin）承担、无行为缺口——v2 形态随创建流改版一并落（体量克制，防提前抽象） |
| ~~boot-graph 编译产物快照~~ ✅ cr-910（shell boot 派生终态落 agents/<id>/boot-graph.json——主壳/子壳分域、审计不承重） | 已落 |
| ~~§4.7 进程种类注册表~~ ✅ cr-910（repo 声明式清单 profile/processes.json + 部署链随行 + installed scope 词单源消费；argv/spawn 契约深接线随创建流/新进程种落地） | 已落（声明面） |
| ~~persona 插件文件选择权（patch 直写或指定文件——persona 行现消费不变）~~ ✅ cr-912（核实既有机制全覆盖：persona.json 单元文件赢 / patch 内联 settings 窗口兜底 / file 任意文档名裸名走 Agent 目录——readAgentConfig 合成链即收口本体，零码改，定向测试 82 例锁定） | 已落 |
| ~~存量数据根迁移实测（migrate-agent-patch 执行）~~ ✅ cr-912（2026-11-05 停机窗口执行：67 身份幂等重写、patch↔config 镜像逐字节等价核验 0 漂移、dry 复验稳定；回滚点 = --revert 在位） | 已落 |
| 旧物物理退役评估（cr-910 收口）：顶层 cordis.patch.example.yml 已删（指向已消灭 src/ 轨道、零引用）；row-catalog JSON（生成物——fixtures/测试仍消费）、plugin-rows/host-rows 镜像（存量数据根旧读者）、staging manifest 模板（plugin-dev 自开发窗口）、preset-origin.json 镜像与 X1 settings 兜底（迁移后可清）——**均属数据根退役窗口件，随迁移完成后清理**（config.json 镜像 / preset-origin 镜像 / plugins 旧通道副本已清，cr-918） | 已评估 |
| ~~通道壳退役：web 面声明归 packages/ac-client-ui-* `ac.faces.web`，build-channel 直构包源 + 外部化不变量门，channel/ 壳与 gen-domain-channels 退役~~ ✅ cr-920（selfhost 切片一前置——见 ui-plugin-selfhost.md） | 已落 |
| ~~退役窗口件收口：writeAgentConfig config.json 镜像双落退役 + preset-origin 并入 origin 块~~ ✅ cr-918（单写 patch；readOrigin/writeOrigin patch 主写 + 存量 json 兜底读窗；orchestrate 物化与 reconcile 写口随迁 readAgentConfig/writeAgentConfig；数据根 67 config.json 镜像 + 4 preset-origin 清毕，后者并入 patch 后转 .migrated 可逆） | 已落 |
| ~~webui 独立部署连接协议单独设计文档（开放问题 #3）~~ ✅ cr-912 立档（webui-standalone-protocol.md：地址发现四层 / hello 握手协议轴 / Bearer 跨源鉴权 / 断连两轴降级 / 四实施切片）；实施切片一 ✅ cr-917（端点发现 + hello 端点 + 非同源前缀化 + CORS 放行回显——同源逐字节等价锁定；切片二至四后继） | 已立档（切片 1/4 已落） |
