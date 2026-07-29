# Changelog

## [0.1.2] - 2026-07-29

### 优化
- Node.js 便携版延迟解压：构建时不展开 1984 个二进制文件，保留为一个 35MB zip，首次运行时 start.bat 自动解压；发布包从 190MB 降至 89MB，CI zip 步骤从分钟级降至秒级

## [0.1.1] - 2026-07-29

## [0.1.1] - 2026-07-29

### 修复
- 便携版 plugin.json 缺失导致所有工具和扩展失效（tsc 不复制 .json，build-release 现自动补齐）
- timer-state.json 孤儿条目无限累积：启动 + 保存时自动清理已不存在的定时器状态
- set_timer 无替换机制导致定时器重复创建：新增 `replace` 参数，创建新任务时可声明替换旧任务

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
- 池引用 API Key 丢失导致 401：`resolveLLMConfig` 从凭据库自动回注
- start.bat 全 ASCII 化，消除 UTF-8/GBK 编码导致的乱码
- release 不再复制开发 workspace，杜绝隐私泄露
- 更多菜单移出按钮区域后正常关闭，保存空名称时给出提示
