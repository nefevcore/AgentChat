# Changelog

## [0.2.0] - Unreleased

### 新增
- **Hashline v2 编辑协议**：read 输出 `[PATH#TAG]` 头部 + `行号:内容`，edit 支持 DSL patch 语言（SWAP/INS.PRE/INS.POST/INS.HEAD/INS.TAIL），文件级哈希 + 快照验证，并发安全。参考 oh-my-pi 实现
- **Hashline DSL 解析器**：`edit/hashline-parser.ts` 表驱动解析 patch 语言，支持替换/插入/范围操作
- **Hashline DSL 执行器**：`edit/hashline-executor.ts` 解析→TAG 验证→应用→快照更新→diff 全流程
- **文件快照存储**：`edit/hashline-snapshot.ts` 记录 read/write 时的文件状态，edit 时验证 TAG 防并发冲突
- **write 输出 TAG**：write 后返回 `[PATH#TAG]` 头部，可直接 edit 无需重新 read
- **一键更新系统**：`update.bat` 从 GitHub latest release 自动下载更新
- **ratio 滑动条**：比例型配置项（`archiveTokenRatio`、`keepRecentRatio`）前端改为拖动滑块 + 百分比显示
- **write 工具结果展示**：文件名点击弹窗查看，语法高亮 + 行号 + 复制按钮；支持绝对路径
- **日期分隔符**：今天/昨天/前天/三天前，trigger 消息独立显示为分隔符
- **思维链时间标签**：流式中实时显示"已思考 X 秒"，刷新后保留
- **思维链工具摘要**：折叠栏显示工具名摘要（如 `read · edit · bash`）
- **群聊简介编辑**：抽屉支持 textarea 编辑群组描述

### 重构
- **read/edit 工具架构重组**：shared.ts 精简为纯哈希/格式化（61 行）；DSL 解析→`hashline-parser.ts`；DSL 执行→`hashline-executor.ts`；edit/tool.ts 纯路由
- **Hashline v1→v2 演进**：行级哈希→文件级哈希，JSON edits→DSL patch，8 字符 hash→4 字符
- **Turns 架构**：从 computed 扫描消息数组改为事件驱动增量 ref 构建，消除扫描逻辑和排序 bug
- **agent-mcp 独立扩展**：MCP 发现+工具注册剥离为独立 extension（`ctx.registerTool`）；agent-prompt 不再持有 MCP 基础设施（`resolveMCPConfig`/`getMCPManager`），两者完全解耦
- **agent-prompt 瘦身**：移除"可用工具"块和"MCP 工具/资源"块，工具通过模型 `tools` 参数注入无需重复描述；零 MCP 引用、零 ctx.meta 依赖
- **思维链渲染**：多轮重写 — 流式中自动展开、结束后 500ms 自动折叠；历史默认折叠；chain-body 拆分思考→工具→正文三步渲染
- **私聊 + 群聊统一管线**：共用 `TurnDisplayItem` 组件，`agent_id` 替代 `role` 判定入站/出站，Sidebar Agent+群组按时间混排
- **Token 面板重设计**：移除"总览"tab + 8 张 stat 卡片；改为固定汇总条（缓存命中进度条）+ Agent/日期双 tab 表格+柱状图
- **消息气泡宽度**：统一由 `turn-item` 管控 70%，内部自适应撑满

### 优化
- **发布脚本**：`启动AgentChat.bat` → `start.bat`，`检查更新.bat` → `update.bat`（全英文，消除编码乱码）。`update.bat` Node.js 检测与 `start.bat` 统一（自动解压 node-portable.zip）
- **bash 工具增强**：stdin 支持、友好错误指导（command not found / permission denied / file not found 等 5 类）、临时文件自动清理
- **会话归档重构**：`archiveTokenRatio` 替代 `archiveMinMessages` 作为归档触发条件，token 比消息数更精准；`keepRecentRatio` 默认 3% 激进截断降成本
- **群聊 UI**：成员列表 4 列 grid 头像+名称；右侧抽屉完整 UI（成员/搜索/群名/退出/删除）
- **群组排序**：`lastActivity` 由 WS 消息驱动，刷新后按最新消息时间排序
- **read 工具结果**：默认折叠显示前 10 行，点击展开全部
- **代码块渲染**：统一 60vh 可滚动视口，删除冗余的"展开/折叠"逻辑
- **历史查询**：按 Agent 消息计数（tool 不计），默认 10 条完整对话轮次
- **消息气泡**：溢出自动换行，不再被截断

### CI
- **分支管理**：push `main` 不触发构建；push `release` 构建 latest pre-release；push `v*` tag 构建正式版本
- **Latest 排序修复**：每次构建先删旧 release 再重建，确保始终排在列表最顶

### 修复
- **edit 模糊匹配越界**：Level 1 trimEnd 匹配时 `matchedLen ≠ oldText.length`，导致替换范围多吞字符。新增 `matchedLen` 字段精确追踪实际匹配长度
- **归档死循环**：`archiveMinMessages` 消息数触发与 `keepRecentRatio` 保留水位过于接近，归档后立即再次触发。改为 `archiveTokenRatio` 纯 token 比例触发
- **bash 循环依赖**：`bash-process.ts` → `tool.ts` 双向 import，改为参数传入
- **bash maxBuffer 未生效**：输出无上限收集可能 OOM，增加 buffer 超限停止 + 临时文件
- **bash 危险命令不全**：新增 PowerShell + 管道注入检测
- **前端文件链接打不开**：`FILE_PATH_PATTERN` 不匹配裸路径；`TurnDisplayItem` 未转发 `previewFile` 事件
- **update.bat 编码乱码**：缺少 `chcp 65001`，中文在 GBK 终端显示为乱码
- **update.bat 下载失败**：多行 PowerShell `^` 续行符在部分 Windows 版本被传给 PowerShell 导致语法错误
- 便携版 `plugin.json` 缺失导致所有工具和扩展失效
- `timer-state.json` 孤儿条目无限累积
- `set_timer` 重复创建定时器
- 虚拟 Agent 修改信息后 500 错误
- `bash` 错误输出不显示
- markdown 正文 `font-variant-ligatures` 导致 `===` 渲染为 `≡`
- 流式结束后思维链时序 gap 导致折叠失败
- 历史加载 A→B→A 顺序错误
- 首屏历史不足无法触发滚动加载
- Node.js 便携版延迟解压，发布包 190MB → 89MB

## [0.1.3] - 2026-07-29

### 修复
- 便携版 plugin.json 缺失导致所有工具和扩展失效（tsc 不复制 .json，build-release 现自动补齐）
- timer-state.json 孤儿条目无限累积：启动 + 保存时自动清理已不存在的定时器状态
- set_timer 无替换机制导致定时器重复创建：新增 `replace` 参数

### 优化
- Node.js 便携版延迟解压：发布包 190MB → 89MB
- CI Create zip：`Compress-Archive` 79s → `tar -a` 1s，总流程降至 75s

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
