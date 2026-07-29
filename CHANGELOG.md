# Changelog

## [0.1.0] - 2026-07-29

### 新增
- Hash 行编辑模式：O(1) 行定位，edit 精准度大幅提升
- edit 工具精简：移除 oldText，只暴露 filePath + lineHash + newText，LLM 零歧义
- 版本更新检测 + 更新日志弹窗
- `reload_extensions` 全局热加载，改扩展/工具代码无需重启
- `write` 工具 1MB 上限，防止误操作写超大文件
- 启动脚本自动打开浏览器

### 优化
- 更新日志弹窗复用 markdown 渲染，和聊天气泡样式一致
- agent-memory 名称变更即时生效，不再被缓存卡住
- LLM 热重载，API Key 保存后所有 Agent 自动生效
- 更多按钮统一横排 ⋯（Sidebar、ChatView、GroupChat 三处一致）
- 版本弹窗加宽至 700px，方便阅读变更日志
- User Agent 改为 virtual 类型，概念一致

### 修复
- 设置页保存模型时错误不再被吞，池编辑弹窗显示错误/成功提示
- 池中首个模型自动设为默认，无需手动勾选
- 默认 DeepSeek 配置补全 model/temperature/max_tokens 参数
- 便携版保留 package.json，版本号不再丢失
- DeepSeek schema `base_url` → `baseURL`，默认模型 `deepseek-v4-pro`
- 移除无效的「一键更新」按钮，改为「查看 Release」链接
