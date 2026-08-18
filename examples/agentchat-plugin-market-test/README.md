# agentchat-plugin-market-test

AgentChat 插件市场的链路冒烟插件：安装后在宿主控制台打印
`[market-test] ✓ 已激活`，热卸载时打印 `[market-test] ✕ 已卸载`。

无依赖、无权限申请、不注册工具/钩子。

## 发布到市场（一次性）

本目录即完整插件包。推到 GitHub 公开仓库并挂 `agentchat-plugin` topic：

```bash
cd examples/agentchat-plugin-market-test
git init -b main && git add -A && git commit -m "init: market smoke plugin"
gh repo create agentchat-plugin-market-test --public --source . --push
# 挂 topic（市场发现的聚合键；也可在仓库网页 About → Topics 添加）
gh api -X PUT repos/<你的用户名>/agentchat-plugin-market-test/topics -f 'names[]=agentchat-plugin'
```

## 验证链路

```bash
# CLI：搜索（能看到本仓库）→ 安装 → 列表
agentchat plugin search
agentchat plugin add <user>/agentchat-plugin-market-test
agentchat plugin list          # · agentchat-plugin-market-test@1.0.0  [market:<repo>@<commit8>]

# 宿主启动（或 WebUI 安装即热加载）→ 控制台出现：
#   [market-test] ✓ 已激活（apply 已运行，manifest.contracts=^1 门禁通过）

# 卸载（WebUI 市场 tab 已装条目的「卸载」按钮，或 CLI）：
agentchat plugin remove agentchat-plugin-market-test
# 运行中宿主热卸载 → 控制台出现：
#   [market-test] ✕ 已卸载（effect 清理函数已运行）
```

WebUI 路径：设置 → 插件库 → 市场 → 搜索 → 安装；已安装条目直接在
市场卡片上点「卸载」（走 library uninstall，自带热卸载）。

## manifest 说明

- `entry: "index.mjs"`——市场插件由宿主 Node ESM import，别用 `.ts`
  （tsx 仅仓库 dev 运行态存在，打包宿主没有）。
- `contracts: "^1"`——演示宿主契约门禁；宿主升 major 后本插件会在
  安装/装载期被点名拒绝，属预期行为（改 range 重新发布即可）。
- `inject: []`——无服务依赖，任何宿主版本可独立激活。
