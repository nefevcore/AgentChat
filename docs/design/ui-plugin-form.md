# UI 插件形态与 web 面统一通道（ui-plugin-form）

> cr-905（2026-11-05）批 3 设计文档——plugin-architecture-v2（cr-901）§4.1
> （cr-920 注记：通道事实源已迁 packages/ac-client-ui-* 真身包——
> channel/ 生成壳与 gen-domain-channels.mjs 退役，build-channel 直构
> 包源，web 面声明归 package.json ac.faces.web；后继方向见
> ui-plugin-selfhost.md）
> web 面 / §4.3 webui 分层 / §七 批 3 的落地规范。参照系 = DSH UI 插件
> 实物（app.asar 出厂技能 `sandbox/dsh-plugin-skill/` + 桌面 profile）。
> 规范用语同 cr-901：**必须 / 禁止 / 仅可** = 强制；裁决条目记录结构性
> 选择理由，偏离须先改本档。

## 一、现状基线（已就位面——本批不重做）

通道机制 8.5b/8.5c 批已落地且与 cr-901 方向一致：

- **统一资产通道**（cr-474 已恢复）：工厂通道与第三方插件同走
  `pluginsDir`（`<dataRoot>/plugins/`）manifest 扫描 → boot graph 端点
  （`/api/ui/boot-graph`）→ 资产路由（`/ui-plugin/:name/*`，压缩 +
  ETag 协商）。零特权路径——第一方模块资产与第三方同通道。
- **工厂播种**（cr-920 已改：build-channel 直构 packages/ac-client-ui-* 真身包，channel/ 壳退役；下文通道目录口径为 cr-905 时点记录）：`build-channel.mjs` 构建 `apps/ui/channel/*` →
  `dist/plugins` → 宿主 boot `seedFactoryPlugins` 幂等拷贝进数据根。
- **宿主模块表雏形**：`boot.ts skeletonModuleHost + sharedModules()` +
  importmap 注入（`installChannelImportmap`）——外部化 bundle 经全局
  注册表解析宿主单例（pinia / Context / 席位注册表 / toast 栈）。
- **隔离档**：`isolated: true` = iframe sandbox + 白名单代理。

本批增量 = 收口四处结构债（见 §三–§六）。

## 二、web 面插件形态（包即插件对齐）

**裁决：web 面声明归 `ac.faces.web`，manifest.json 是迁移期投影**。
与 node 面同包同格式（批 2 已落）：

```json
{
  "name": "ac-plugin-todo",
  "ac": {
    "faces": {
      "web": { "entry": "./client/index.js", "seats": ["tool-card"] }
    }
  }
}
```

- `entry` = 浏览器可直载 ES 模块（相对包根；**禁止**依赖宿主构建链
  ——工厂件的 TS/Vue→JS 构建步保留在 build-channel，产物走统一通道，
  无特权路径 ≠ 无构建）。
- `seats` = 席位对象词形（seat / view / kind / scope——cr-690 三词形
  保留：既有席位贡献、`new:<key>` 新开席位、`view` 视角挂载）。
- 迁移投影（批 2 同款双读窗口）：现通道 manifest.json {`entry`,
  `seats`, `isolated`, `styles`, `theme`} → 包形态读取面投影
  （`readPluginPackage` 已含 ui→faces.web 逆投影；正投影随装载面
  切片接入）。拆旧（批 6）时 manifest 形态退役。

## 三、宿主模块表单源与 channelImports 退役

**裁决：channelImports 机制退役**。现状 = 每通道 manifest 自述
`channelImports` 清单，构建面（rollup external）与装载面（importmap
注入）共用该清单——声明漂移 = 装载时才炸；且新通道作者要手工抄词表。

终态：**宿主模块表单一清单**（`apps/ui/client/shared-modules.ts` +
骨架三件 = 唯一词源）。构建面 external = 全表恒等（build-channel 不再
读 manifest.channelImports）；装载面 importmap = 全表恒等。通道作者
零声明——import 宿主表内说明符即得单例；表外说明符打进自有 bundle。

- 迁移：两读窗口内 manifest.channelImports 仍被旧产物消费（已播种
  数据根里的存量构建产物）——装载面保留按清单注入的能力，新构建不再
  写该字段；`build-channel` 产物 manifest 摘除 channelImports 随切片二。
- 表内容变更 = 破坏面（下游 bundle 外部化漂移）——表头注释声明
  「增项安全 / 删项与改名 = 破坏性，须升 webui 基座版本戳 + 全量重建
  通道产物」。

## 四、webui 基座与分层装配

**裁决：webui 装配文档 = profile/webui.patch.yml**（与 host/shell 基座
同方言同部署链）。分层合成（前端侧求值——boot graph 端点内做）：

```
基座(webui.patch.yml——工厂通道出厂清单，repo 源码化)
  → webui-custom.patch.yml（用户：disable/override/点名）
  → installed.patch.yml(scope:webui 条目——第三方 web 面)
  → 目录扫描对账（点名缺席 = 警告 + 跳过；上报面 = boot graph 端点 warnings 域）
```

- 基座源 = `apps/catalog/profile/webui.patch.yml`（行 = 工厂通道）。
  **裁决：生成而非手写**（cr-920 起事实源 = packages/ac-client-ui-* 的 `ac.faces.web` 声明，name 词形 `link:packages/<包>`）——原 cr-905 时点事实源是 `apps/ui/channel/*`
  目录（增删通道 = 增删行），手抄必漂移。`scripts/gen-webui-base.mjs`
  从通道 manifest 生成（id = 通道名；name = `link:apps/ui/channel/<名>`；
  seats/isolated 随行；版本戳 = 内容变化时自动 +1）。
- host boot 部署链扩展：`materializeBaseDocs` 增 webui 面（DEPLOY_PROCS
  三词——webui 源缺席 = 跳过该面不阻断；readBaseCatalog 行集投影仍
  host/shell 两词，webui 基座非 RowDescriptor 面）。
- 前端求值（切片三）：boot graph 端点先读文档合成（基座 − disabled ∪
  installed(scope:webui)），再扫目录物化——文档是装配意志，目录是
  物化事实，两者对账而非互相推导。

## 五、词法放宽（npm scope 收敛）

通道名 / 插件名现行 `param-case` 正则排斥 `@scope/name`。npm 分发
（批 5 publish）要求 scope 可用。放宽点：

- `InstalledEntry.name` 与 boot graph 键：接受 `@scope/name`（npm
  词形）与 `link:`（目录词形）——解析规则同 installed.patch.yml 单源。
- 资产路由 `/ui-plugin/:name/*`：scope 名转义（`@scope%2Fname`——
  URL 编码形，路由参数单段不变）。
- 存量 param-case 词形原样合法（非破坏放宽）。

## 六、批 3 实施切片

1. **切片一（本 CR）**：本设计文档 + webui 基座源文档 v0（生成脚本 +
   版本戳 + 生成物入库 + 漂移锁定测试）。无消费面——装配意志先行物化。
2. **切片二**：宿主模块表单源（build-channel external 全表恒等 + 新产物
   manifest 摘 channelImports + 表头破坏面声明）。
3. **切片三**：webui 分层求值（BASE_PROCS 扩 webui + 部署链 + boot graph
   文档合成 + 目录对账 + healthz 上报）+ 词法放宽。
4. **切片四（已落）**：包形态装载——readChannelManifest（manifest.json
   迁移期优先；package.json ac.faces.web 投影，isolated 缺省 true）+ 单测
   锁定（seats 投影 / node-only 零警告 / manifest 优先序）。

## 七、验收

- 出厂装配链 e2e 全量（`pnpm test`）+ `pnpm webui:typecheck`。
- 通道产物重建后 boot graph 与资产路由行为等价（除 channelImports
  字段摘除外 manifest 逐字节等值）。
- webui 基座漂移锁定：通道目录增删/改 manifest 未重跑生成脚本 = 测试红。
