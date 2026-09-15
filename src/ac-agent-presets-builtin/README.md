# ac-agent-presets-builtin

内置预设模式数据行：标准模式（`__standard__`）与极简模式（`__dsh_minimal__`）的形状定义，经 `ctx.agentPresets.register` 注入预设目录。零逻辑纯数据——物化/模型解析/热更新语义由 [ac-agent-presets](../ac-agent-presets/) 目录服务承担。

第三方插件注入自有模式走同一注册面，与本行零特殊化。
