# 插件市场（market）

> 组成：`ctx.market` 服务行 + `/api/plugins/market/*` 路由行 + `agentchat plugin` CLI + WebUI 插件库「市场」tab。

## 设计立场

market 解决的是**发现与分发**，不解决信任。信任来自三道既有边界：

1. **staging 人审**——市场安装与本地发布走同一条 `.staging/` 审查管；
2. **权限授予**——`process/shell/ui` 必须显式 grants，CLI 不开后门；
3. **commit 钉定**——market 安装记录 `source.commit`，"审过的代码"与"安装的代码"是同一份。

## 发现层：topic 是种子，manifest 是条目

- GitHub 适配器按 `topic:agentchat-plugin` 聚合（`search/repositories`；配额可经
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

## CLI：`agentchat plugin …`

```
agentchat plugin search [关键词]               # topic 聚合搜索（写缓存）
agentchat plugin add owner/repo#v1.2.0         # 安装（= stage + approve）
    --grants shell,ui    # 高危权限显式授予（缺 → 自动清理暂存并退出码 2）
    --stage-only         # 只暂存，走 WebUI 人审
    --workspace <dir>    # 工作区（缺省 AGENTCHAT_WORKSPACE）
agentchat plugin list                         # 已安装（含 market:repo@commit 来源）
agentchat plugin staging                      # 待审暂存
agentchat plugin remove <name>                # 卸载（目录移 .backup）
```

- CLI 与 WebUI 同一条信任边界，**不开后门**：缺 grants 时清掉本次暂存再报错。
- CLI 是独立进程（无 pluginHost）：安装落盘，宿主重启时扫描装载。
- 入口：发布包 `dist/cli.mjs`（esbuild 单独打包）；仓库内 `bin/agentchat.js`
  回退 tsx 直跑 `src/plugins/plugins/src/market/cli.ts`。

## HTTP：`/api/plugins/market/*`（express 路由行，inject http+market）

| 端点 | 语义 |
| --- | --- |
| `GET /search?q=` | 聚合搜索；源失败降级缓存（`stale: true`） |
| `GET /cached` | 本地缓存索引（零网络） |
| `POST /stage {spec}` | 市场暂存 → WebUI 待审队列 |
| `POST /install {spec, grants?}` | 一步安装；宿主内热加载 + 广播目录变更 |

错误映射：显式 `PluginApiError` → 自带码；市场上游错误（网络/限流/不兼容/解包）→ 502；
registry 语义（未安装/同版本/权限）→ 共享规则 404/409/400。

## WebUI：插件库「市场」tab

搜索（enter/按钮）→ 条目卡（名称/仓库/★/权限徽章，高危高亮）→ 安装：

- 默认权限 → `POST /install` 一步完成（宿主内即时装载）；
- 声明高危权限 → install 返回「未授予的权限」→ 前端自动转 `POST /stage`
  并跳「待审暂存」tab，复用既有逐文件审查 + 授予弹窗（信任边界不因入口而放松）。

## 卸载

| 入口 | 动作 |
| --- | --- |
| CLI | `agentchat plugin remove <name>` |
| WebUI | 插件库 → 已安装（PluginCard 卸载）；市场 tab 已装条目卡片上也有「卸载」 |
| HTTP | `POST /api/plugins/library/:name/uninstall`（复用 library 端点） |

宿主内卸载自带**热卸载**（fiber 回收 + 目录移 `.backup`）；CLI 独立进程只动磁盘，
运行中的宿主重启后不再装载。卸载后同版本可重装（registry 记录已移除）——
测试闭环：装 → 控制台看标记 → 卸 → 改插件 → 再装。

## 冒烟插件：`examples/agentchat-plugin-market-test`

真实链路验证用：无依赖、无权限、不注册工具，只在激活/热卸载时向宿主控制台打印
`[market-test] ✓ 已激活` / `[market-test] ✕ 已卸载`。端到端测试
（`tests/market-e2e.test.ts`）用它跑 install → 热加载 → 热卸载全链路。

发布到市场见 `examples/agentchat-plugin-market-test/README.md`（推 GitHub 公开仓库 +
挂 `agentchat-plugin` topic）。两个对后续真实插件同样适用的要点：

- 入口用 `.mjs`——市场插件由宿主 Node ESM import，`.ts` 依赖 tsx（打包宿主没有）；
- `contracts: "^1"` 可选——声明后宿主升 major 会被点名拒绝（预期行为）。
