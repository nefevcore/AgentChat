# 插件装载面统一方案（plugin-face-unification）

> 性质：历史裁决——插件装载面统一的问题诊断与批 A/B/C 方案。
> 状态：**已被 [plugin-architecture-v2.md](plugin-architecture-v2.md)（cr-900/cr-901）取代**——诊断仍成立，方案以「推翻重来」收编进 v2；本文留作决策轨迹。
> 读者：追溯 v2 迁移动因时才需要（现行口径一律以 plugin-architecture-v2.md 为准）。

> **已被 cr-900（2026-11-05）`plugin-architecture-v2.md` 取代**——诊断仍成立，
> 但批 A/B/C 作为补丁路线整体收编进 v2 迁移批次（批 1 组合树 / 批 3 faces
> 收编），以「推翻重来」形态落地。本档降为历史裁决。

> cr-898（2026-11-05）发起。问题实证来自 2026-11-04/05 开发者会话：UI 通道旧产物
> 在数据根静默服务三周（重启/刷新均不可见，发送链路因前后端协议漂移断裂），以及
> 随后排查中暴露的「一个 `plugins/` 目录、两套治理规则」认知负担。本档主张：
> **凡承载「插件」语义者，安装态应有单一路径与单一事实源**；进程差异（浏览器 /
> Node）只能是插件的内部分面，不能外溢成「两种插件」。

## 一、问题陈述

### 1.1 现状：同一目录、两套世界

`<dataRoot>/plugins/` 同时承载两类东西，治理规则完全不同：

| | UI 通道（现存 30 个） | 壳侧插件行（安装态为零） |
|---|---|---|
| 注册表 | **目录即注册表**——webui 行 boot graph 裸扫 `manifest.json` 即装载 | `plugin-rows.json`（授权物化） |
| 进入方式 | 出厂播种（anchors.ts `seedFactoryPlugins`）/ 开发者 `pnpm build:channels` | `plugin/stage → approve`（face-ops） |
| 授权语义 | 无——装载失败 = 前端降级 | 有——代码进壳进程（R0a：宿主永不装载） |
| 装载机制 | importmap + 静态服务（`/ui-plugin/*`） | 壳内动态 `import(entry)` → `ctx.plugin` |
| 新鲜度 | **无对账**（dev 形态 `factoryPluginsDir = null`，产物旧了无人知） | 安装即定格（第三方件无升级链，属既有裁决） |

### 1.2 已付出的代价

1. **2026-11-04 事故**：`build:channels` 产物停在 10/22，宿主 boot graph 照常服务；
   后端（源码直启）已漂移三周 → 发送链路断裂。重启 supervisor 只重建基座
   （`apps/ui/dist/`），通道层无人对账——「产物面盲区」是本设计的直接成本。
2. **认知摩擦**（本会话实录）：开发者本人需要五轮追问才能拼出完整模型——
   「为什么构建到数据根」「plugin-rows.json 为什么是空的」「plugins/ 是否生效」
   「为什么两种通道」。每个问题的答案都自洽，但**拼图本身没有单源**。
3. **命名污染**：`plugins/` / plugin-registry / `plugin-rows.json` / build-channel
   共享「plugin」词根，指称却分属两套世界。

### 1.3 判断

分裂中只有两条是 forced，其余皆可选：

- **forced A——装载机制**：浏览器（importmap/静态）与 Node（动态 import/cordis）
  无共享模块机制，装载代码必然两套。
- **forced B——授权语义**：代码进进程与否是安全边界（security-access-tier 最高危
  面），UI 降级与壳装载不能共用授权模型。

但 forced 边界并不要求「两种插件」：**一个插件单元可以同时声明 web 面与 node 面，
安装动作一个、注册表一张、目录一份**。现状把 forced 的内部分面做成了外部的
路径分叉——这是本档要修的根因。

## 二、目标与非目标

**目标**

1. 单一安装态事实源：`plugin-rows.json` 升格为唯一注册表，UI 通道同样登记在册
  （带 `source: factory-ui | installed` 标记）；boot graph 由注册表驱动，不再裸扫。
2. 单一插件单元：manifest 支持 `facets`（`web` / `node`）——一个插件可只带 web 面
  （≈今 UI 通道）、只带 node 面（≈今壳侧行）、或双面。
3. dev 新鲜度对账：宿主 boot / webui 行发现「目录有件但注册表无据」或「出厂 UI
   通道产物落后于 `apps/ui/channel/` 源」时 fail-loud 警告，消灭 1.2-1 盲区。

**非目标**

- 不动 R0a（宿主进程永不装载第三方代码）。
- 不合并运行时装载机制（forced A/B 保持）。
- 不做第三方件自动升级链（既有裁决，另案）。

## 三、方案分批

### 批 A——注册表单源（P0，断 1.2-1/1.2-2 根）

- `seedFactoryPlugins` 播种 UI 通道时同步物化 `plugin-rows.json` 条目
  （`source: factory-ui`，指纹戳即既有 `.factory-stamp.json` 语义内联）。
- webui 行 boot graph 改读注册表；目录扫描降级为**检测面**：发现未登记目录 →
  boot 警告（dev 形态提示跑 `pnpm build:channels`）。
- `build:channels` 产物落位后自登记（或宿主 boot 补登记），dev 与 bundle 形态同链。

### 批 B——manifest facets 与命名收敛（P1）

- 通道 manifest 增 `facets: { web?: {...}, node?: {...} }`；现 `platform: web`
  的单面形态平滑映射为 `facets.web`，向后兼容读旧形。
- 安装动作统一词汇：`plugin/stage → approve` 对双面件一次授权；纯 web 件授权面
  提示降级语义（不进进程）。
- 目录层按面分流可选做（`plugins/<name>/web|node/`），仅当批 A 落地后认知负担
  仍存再做——避免为目录美学引入第二形态。

### 批 C——dev 对账加固（P0，与批 A 同批可做）

- 宿主 boot（仓库形态）比对 `apps/ui/channel/<name>/` 源 mtime/内容签名与
  `<dataRoot>/plugins/<name>/` 产物：漂移 → stderr 警告 + healthz 暴露
  `staleChannels` 字段，前端可提示。

### 测试面

- 播种→注册表物化幂等（同代跳过）回归；撞名护栏（出厂赢）两套语义合一后单测。
- boot graph 读注册表 vs 目录检测面警告路径 e2e。
- `channels-domain.test` 词表快照随 facets 字段同步。

## 四、备选与拒绝理由

- **维持现状 + 文档补课**：零代码成本，但 1.2-1 盲区（产物无对账）没有文档能救
  ——它需要的是 fail-loud，不是说明。
- **koishi 式单 manifest 深合并**（web/node 面同声明同装载钩子）：将 forced A/B
  淹没在统一外观下，授权边界反而不可见。拒绝——统一注册表 + 显式 facets 比
  深合并诚实。

## 五、开放问题

1. `plugin-rows.json` 与 `.factory-stamp.json` 指纹语义合并后，升级重播的触发键
   用 version 还是源签名（批 C 若做源对账，两者应同源）。
2. 已安装双面件的壳侧熔断回报（plugin/load-failure，cr-543 遗留）是否随批 B
   一并收口。
3. 用户自装纯 UI 通道是否走 stage→approve（现状免审）——建议维持免审，注册表
   `source` 区分即可，授权语义只挂 node 面。
