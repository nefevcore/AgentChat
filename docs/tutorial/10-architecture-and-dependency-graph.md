# 第 10 步：架构与依赖图

> 目标：把 1–9 步的零散知识串成一张图，能独立阅读 cordis.yml、依赖图与源码。

## 10.1 一句话架构

**cordis 4 插件运行时上，42 个包各自成行；服务靠 inject 契约组装，工具/钩子靠 owner 注册；boot 只做装配接线，业务能力全部可插拔。**

## 10.2 分层速记

| 层 | 包 | 一句话 |
|----|----|--------|
| L0 根 | types / protocol / util | 只谈契约与横切，零依赖 |
| L1–L2 | llm / agent-loop | 推理引擎：模型适配 + ReAct 编排 |
| L3 | agent-config / hooks / toolkit / edit / tools | 配置契约、钩子中心、工具中心与工具基础 |
| L4–L5 | agents / router | 单 Agent 装配、多 Agent 路由 |
| L7 | fs/shell/web/dev/session-tools/restart/interaction/math | 工具领域，每域一行 |
| L8 | agent-prompt/skill/session/memory/mcp/security/agent-tools | 扩展域，钩子与协作工具 |
| L9 | timer/subagent/archive/backup/workspace | 服务域，Manager 由各自插件行持有 |
| L10–L11 | server / plugins / webui | 宿主门面、动态插件系统、前端 |
| 装配 | boot | 唯一聚合根：Assembly/Router/Registry/Loader + 收尾接线 |
| vendor | cordis/cosmokit/schemastery/loader/logger/timer/hmr/include | 本地化运行时生态 |

## 10.3 阅读 cordis.yml 的方法

1. 从下往上找 `boot/src/plugin` 的 `inject`（agentLoop/llm/tools/hooks）——这四个是装配前提；
2. 找提供这四个服务的行（agent-loop/llm/tools/hooks）；
3. 找它们各自的下游行（工具领域 inject tools；扩展域 inject hooks；适配器 inject llm）；
4. 看装配链：boot → workspace/archive/timer/subagent/l4 → finalize → webui/http-routes/plugins-http；
5. `plugin-diagnostics` 告诉你删行会缺什么服务。

## 10.4 阅读依赖图的方法

打开 [../dependency-graph.html](../dependency-graph.html)：

- **图 1 包依赖图**：A→B 表示 A 依赖 B（箭头指向被依赖方）；实线=值边（运行期耦合），虚线=类型边（契约耦合），点线=仅测试/未使用；
- **图 2 运行时组合图**：左列插件行 → 中列 ctx 服务 → 右列装配/宿主行（inject 边即激活顺序）；
- 悬停高亮邻接、点击看详情、可开关边类型、搜索、缩放拖拽。

规则与例外（详见 [../dependencies.md](../dependencies.md)）：

- 值边只指向更浅层；类型边允许反向；
- boot 是唯一聚合根；vendor 不在图内；
- 明确例外：`dev → plugins`（dev 工具需确保 pluginHost 先就绪）。

## 10.5 阅读源码的最小地图

| 想知道什么 | 读这里 |
|------------|--------|
| 插件模型 | `src/vendor/cordis/src/{context,service,fiber,events}.ts` |
| 装配契约 | `src/agents/agents/src/config.ts`（AgentAssembly） |
| 工具烘焙 | `src/tools/tools/src/service.ts`（resolveTools） |
| 钩子烘焙 | `src/core/hooks/src/service.ts`（collect） |
| 启动装配 | `src/boot/boot/src/{plugin,plugin-finalize}.ts` |
| 动态插件 | `src/plugins/plugins/src/{host,registry,permissions}.ts` |
| 传输层 | `src/host/server/src/{webui-server,ws/handler}.ts` |

## 10.6 最终自测题

1. 删掉 cordis.yml 的 `shell/src/plugin` 行会发生什么？（bash 工具消失；boot 诊断不告警，因为 shell 不是必需服务）
2. 删掉 `server/src/service-plugin` 行会发生什么？（ctx.l4 缺失；finalize 停 PENDING，5s 后诊断告警 `l4`）
3. Agent 想用 subagent 工具需要哪些条件？（conductor tag + presets 含 agentchat-subagent-tools 或缺省兼容）
4. 为什么 `config.hooks` 数组顺序重要？（HooksService.collect 按顺序表烘焙，顺序即执行顺序）
5. 动态插件卸载后为什么工具会消失？（PluginHost 按 owner 调 `tools.unregister(owner)` / `hooks.unregister(owner)`）

全部答上，你就完成了 AgentChat 的插件化架构入门。下一步把 [../plugin-dev-guide.md](../plugin-dev-guide.md) 的检查清单走一遍，写一个自己的插件吧。

## 延伸阅读

- [../architecture.md](../architecture.md) —— 架构总览
- [../plugin-system.md](../plugin-system.md) —— 插件体系
- [../plugins/README.md](../plugins/README.md) —— 41 包速查
- [../archive/README.md](../archive/README.md) —— 为什么走到这个架构（迁移史）
