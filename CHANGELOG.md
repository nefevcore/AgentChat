# Changelog

## [0.1.0] - 2026-07-28

### 新增
- Hash 行编辑模式：O(1) 行定位，零模糊匹配，大幅提升 edit 工具精准度
- `reload_extensions` 全局热加载工具：修改扩展/工具代码后无需重启
- LLM 热重载：API Key 保存后所有 Agent 自动更新
- `update_agent_profile` 支持 persona → AGENT.md、system_prompt → SYSTEM.md 写入
- `get_agent_profile` 从 AGENT.md/SYSTEM.md 实时读取 persona
- `write` 工具大小上限 1MB，防止误操作写入超大型文件

### 修复
- `hashLine` 去重为 shared.ts，消除 read/edit 两份实现
- agent-memory 移除 agentNameCache，名称变更立即生效
- `edit-diff.ts` LineRange 类型提升到模块级，修复 TypeScript 编译错误
- `reload_extensions` filter(Boolean) 类型收窄
- `index.ts` provider 可能为 undefined 的 TS 错误
- `update_agent_profile` 删除无效的空 try/catch 死代码
