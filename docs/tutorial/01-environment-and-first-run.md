# 第 1 步：环境与首次启动

> 目标：跑起 AgentChat，完成 LLM 配置，看到默认管理员「艾吉」的自我介绍。

## 1.1 环境要求

- Node.js ≥ 20（推荐 22/24）
- pnpm ≥ 9
- Windows / macOS / Linux（bash 工具会自动探测平台 shell）

## 1.2 安装依赖

```bash
git clone <repo-url>
cd AgentChat
pnpm install
```

仓库是 pnpm workspace monorepo：`src/*/*` 下 42 个 `@agentchat/*` 包 + `src/vendor/*` 本地 cordis 生态。

## 1.3 启动

```bash
pnpm dev
```

发生了什么：

1. `node --import tsx node_modules/@agentchat/cordis/bin.js` 启动 cordis Loader；
2. Loader 读取根目录 `cordis.yml`（39 个活动插件行），按各插件 `inject` 依赖自动排序激活；
3. 工作区初始化：确保 `workspace/default/agents/user`（虚拟 Agent）；首次运行创建 `admin`（艾吉）并注入自我介绍消息；
4. WebUI 插件行启动 HTTP + WebSocket + SPA，默认端口 **3830**。

打开 `http://localhost:3830`，应能看到艾吉的消息。

## 1.4 配置 LLM

侧边栏「设置 → 模型管理」：

1. 添加 Provider（如 DeepSeek），填 API Key；
2. 把某个池条目设为默认（`default: true`）。

等价的手动配置（`workspace/default/config.json`）：

```json
"llmProviders": {
  "deepseek-v4-flash": {
    "provider": "deepseek",
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-v4-flash",
    "thinking": true,
    "default": true
  }
}
```

凭据会被抽取到 `~/.agentchat/credentials.json`（AES-256-GCM 加密，绑定本机）。查找顺序：Agent 级 → 全局级 → 池条目 `api_key` 字段。

## 1.5 验证清单

- [ ] 终端出现各插件行的启动日志（`ctx.tools 就绪`、`boot 核心装配就绪`、`WebUI 插件行已启动` 等）
- [ ] WebUI 打开，看到「艾吉」的自我介绍
- [ ] 与艾吉对话有回复（说明 LLM 配置成功）

## 1.6 常用启动参数

```bash
pnpm dev                                   # 前后端一起（开发）
AGENTCHAT_NO_WEBUI=1 pnpm dev              # 只跑后端
AGENTCHAT_WORKSPACE=my_project pnpm dev    # 换工作区
pnpm typecheck                             # 类型检查
pnpm test                                  # 全量测试
```

> 端口可在 `cordis.yml` 的 `webui/src/plugin` 与 `boot/src/plugin-finalize` 两个 config 中调整（默认 3830）。

## 下一步

[第 2 步：创建第一个 Agent](02-creating-your-first-agent.md)
