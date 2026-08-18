# 插件市场（market）

> 状态：宿主侧服务已落地（`ctx.market`）；CLI 与 WebUI 入口在后续版本接入。

## 设计立场

market 解决的是**发现与分发**，不解决信任。信任来自三道既有边界：

1. **staging 人审**——市场安装与本地发布走同一条 `.staging/` 审查管；
2. **权限授予**——`process/shell/ui` 必须显式 grants，CLI 不开后门；
3. **commit 钉定**——market 安装记录 `source.commit`，"审过的代码"与"安装的代码"是同一份。

## 发现层：topic 是种子，manifest 是条目

- GitHub 适配器按 `topic:agentchat` 聚合（`search/repositories`；配额可经
  `AGENTCHAT_GITHUB_TOKEN` 提升）。topic 无门槛，任何人可挂——所以它只是发现提示。
- 命中仓库后 `resolve()` 把 ref 钉定到 commit，从 raw 拉该 commit 的
  `manifest.json` 并过 `validatePluginManifest`——市场条目以 manifest 为准。
- 索引缓存落 `plugins/.market/index.json`；全部源失败时 search 降级返回缓存
  （`stale: true`），**启动路径零网络依赖**。

## 安装层：复用 staging 管

```
ctx.market.stage('owner/repo#v1.2.0')
  → resolve（钉 commit）→ 契约门禁 → 下载 tarball → 安全解包
  → 解包 manifest 与 commit 处一致性校验 → stagePlugin(..., source)
ctx.market.install('owner/repo', ['shell'])   # = stage + approveStaging
```

- 说明符三种形态：`owner/repo`、`owner/repo#ref`、`name`（须先 search 落缓存）。
- tarball 解包器（`market/tarball.ts`）：路径逃逸拒绝、symlink/hardlink 跳过、
  单文件/总体积/文件数三重上限、截断检测。
- 未 grants 的高危权限在 approve 处拒绝（与本地发布一致）。

## 宿主契约兼容（contracts）

破坏性升级从"随机炸"变成"加载期点名"：

- 宿主侧 `HOST_CONTRACTS_VERSION`（`@agentchat/agent-config/src/contracts.ts`）
  随兼容面演进；major = 破坏。
- 插件 manifest 声明 `"contracts": "^1"`；缺省视为兼容（存量插件弃用窗口内不惩罚）。
- 两道门禁，都在 import 之前：
  - `MarketService.stage()`——不兼容的市场插件不进入人审队列；
  - `PluginHost.load()`——已安装插件装载时 fail closed，代码不进进程。

range 语义（粗 semver）：`*` / `^1` / `~1.2` / `1.x` / `>=1 <2` / `^1 || ^2`；
非法 range 按不兼容处理（fail closed）。
