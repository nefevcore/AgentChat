# AgentChat 桌面端

AgentChat 的 Windows 桌面客户端（Tauri 2），用于 **托盘常驻 + Agent 主动通知**。

## 功能

- 🖥️ **托盘常驻**：点窗口关闭按钮 → 缩到托盘（不退出），Agent 活动仍持续
- 🔔 **Agent 主动通知**：独立 WS 监听线程，只弹用户关心的三类事件：
  - `chat.interaction` —— Agent 在等你回答（必须弹，不开窗会错过决策）
  - `chat.message.end` —— Agent 完成一条完整回复
  - `group.message` —— 群聊新消息
  - 流式增量（`chat.message.update`）**绝不弹**，避免通知风暴
- 🔄 **断线自动重连**：后端未启动/重启中每 3s 重连，恢复后自动继续通知
- 🧭 **自动跳转**：主界面检测后端就绪后自动跳转 WebUI（`http://localhost:3830`）

## 依赖

- 后端：AgentChat 主程序（默认监听 `ws://localhost:3830`），需先启动
- 前端：`desktop/ui/index.html`（纯静态，检测后端 → 跳转 WebUI）

## 开发

前置要求：[Rust](https://www.rust-lang.org/)（含 `cargo`）与 [Node.js](https://nodejs.org/)（含 npm）。

```bash
# 安装 Tauri CLI
cd desktop
npm install

# 开发模式（热重载）
npm run dev

# 构建发布产物（target/release/ 下生成 agentchat-desktop.exe）
npm run build
```

## 结构

```
desktop/
├── src-tauri/            # Tauri 壳（Rust）
│   ├── src/
│   │   ├── main.rs       # 入口
│   │   ├── lib.rs        # 托盘 / 窗口事件（X → 托盘）
│   │   └── ws_client.rs  # WS 通知监听（独立线程 + 自动重连）
│   └── tauri.conf.json   # Tauri 配置
└── ui/index.html         # 启动页（检测后端 → 跳转 WebUI）
```

## 使用

1. 先启动 AgentChat 后端（根目录 `pnpm dev`，默认端口 3830）
2. 运行桌面端 → 自动连接并跳转 WebUI
3. 关闭窗口后从托盘图标重新打开 / 退出
