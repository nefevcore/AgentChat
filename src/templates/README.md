# Agent 自开发插件模板（M23）

三种插件行骨架。复制到 `<数据根>/files/<agentId>/<name>/`（调用方沙箱，
install_plugin 缺省约定位置），替换 `PLACEHOLDER-AGENTID` 为你的 Agent id，
改实现后用 `install_plugin` 永久安装（或 `register_plugin` 临时试跑）。

| 模板 | 用途 | 关键规约 |
|---|---|---|
| `tool-row/` | 注册工具 | `agentTool()` helper 注入 owner tag（默认私有）；输出 `<tool-output>` 包裹；description 禁指令式措辞 |
| `provider-row/` | 注册 LLM provider | 复用 `ac-openai-completions` 纯库换 baseUrl；`<agentId>-<name>` 命名（openai/deepseek/glm 是保留字）；contracts 必填 |
| `event-row/` | 订阅/拦截事件 | `agentFilter(request.agent)` per-Agent 自查；不 provide 新服务、不 emit `loop/*`；waterfall 观察必须 `next()` |

通用规约：

- **命名**：`<agentId>-<name>` 前缀（内置注册名是保留字——撞名装载即拒）。
- **迭代**：改动必 bump manifest `version` 后重装；同 name+version 且内容
  一致 → 幂等返回已装状态不重试装载。
- **热重载**：Agent 侧没有——迭代 = 改 → 重装；watch 仅宿主 `plugin/load`
  RPC 的参数。
- **共享**：工具默认私有（owner tag）；共享 = 他人显式在自己的
  `tags` 与 `hooks['security'].capabilities` 双写 `agent:<你的id>`。
  共享输出是跨 Agent 注入载荷——`<tool-output>` 包裹是模板强制项。
- **生命周期**：owner Agent 删除后其已装插件成无主常驻（装载着、无人能
  调用）——README 如实呈现；卸载 = 代码回滚（运行时副作用不随之回滚），
  回执列出消费方。

安装闭环（H1）：install_plugin → 本轮收束后宿主执行 → 回执落账当前会话 →
`sender:'event'` 回触你的自会话 → 直接开始测试。失败回执附下一步动作
（bump version / 修复重装），闭环无人值守。
