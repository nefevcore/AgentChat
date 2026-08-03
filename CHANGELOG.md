# Changelog

All notable changes to AgentChat are documented in this file.

---

## [0.4.6] - 2026-08-03

### Added
- **adjust_llm 工具**：Agent 自主调节 LLM 强度（温度/深度思考/最大输出），任务难开 thinking 温度 0，闲聊关 thinking 省 token；persist 可选写配置重启生效
- **Token 云图面板**：Token 用量新增气泡图 tab，气泡面积∝用量一眼看出最活跃 Agent（零新依赖）
- **首次启动引导**：全新环境自动创建 user + admin（艾吉），触发自我介绍并引导配置 LLM/创建 Agent

### Changed
- **全局定时重构**：chime 独立机制移除，并入统一 scheduleEntry（`__global__` 虚拟 Agent）；配置键 `chime`→`timer`（兼容旧键）；提示支持 `{{now}}`/`{{time}}`/`{{date}}` 占位符；任务项新增复制按钮
- **附件上传重构**：原始文件名存 `files/<agentId>/_tmp/`（或全局 `_tmp`），重名 SHA-256 幂等/加序号；中文文件名修复；用户气泡渲染附件可点击预览

### Fixed
- **前端全局定时无法点击**：新建任务弹窗条件 bug（两条件都 false 永不显示）
- **附件看不到内容**：WS handler 用 a.hash 拼路径（实际存原始名）→ 改用 a.text

### Added（稳定性/体验）
- **router 网络失效模式**：网络异常时消息入队不丢，30s 探测自动恢复重投（连续 2 次网络错误才 down，防抖动）
- **对方正忙提示**：给忙的 Agent 发消息时前端提示"已作为追加指令排队"，不再误以为无响应

---

## [0.4.5] - 2026-08-02

### Fixed
- **A→A 自对话提示词指引**：告知 Agent 自对话不落盘，重要信息需自行更新 memory/TODO/note（配套 B1）
- **思维链正文被吞**：末尾有纯文本消息时，最后一条 meaningful step 的正文不展示；改为「不等于 final 气泡正文」判定
- **同 sender 长间隔消息误合并**：超过 10 分钟视为不同轮次（定时广播不再合并进同一 turn 链）

---

## [0.4.4] - 2026-08-02

### Added
- **Agent 角色选择器 UI**：配置面板加 user/developer/admin 下拉，无需改配置文件即可分配角色层级

### Changed
- **消息角色体系重构**：trigger 一等角色（角色判定彻底脱离正文内容嗅探）+ provider 双向转换（toProviderMessages/fromProviderMessages）+ viewer 视角统一 + loadHistory 返回持久化格式 + safeSplitIdx 结构截断（tool 对保护）
- **脚本统一**：8 个会话维护脚本合并为 `session-maint.js`（scan/aa/compact/migrate/all），运行时脚本移入 `scripts/runtime/`
- **token 估算共享**：`src/utils/tokens.ts` 统一实现，webui/server 复用

### Fixed
- **archive 归档重建污染**：tool 结果含 `<trigger>` 子串被误标 trigger（query_history 内嵌历史文本）；toPersistedRole 强制 tool/error 保持原角色
- **前端 trigger 判定**：`isTrigger` 改为纯 `role==='trigger'`（移除正文内容回退）
- **A→A 自对话污染**：postHook 对自对话永不落盘消息历史（仅记录用量）

---

## [0.4.3] - 2026-08-01

### Added
- **语义化中断**：InterruptReason + ToolInterrupt 体系，abort 从核弹变可控信号；reload/restart 抛中断
- **manage_plugins 装配反馈**：返回 dropped tools + 原因（不存在/无权）
- **web_search 配额检查**：本地积分账本 + 查询前配额门控

### Changed
- **工具清理**：移除废弃 reload_self_tools/reload_extensions
- **重启自动恢复**：restart enqueues continue-trigger，会话自动恢复

### Fixed
- **重启继续触发器来源**：continue-trigger from=session counterpart
- **去重窗口**：60s → 30s（复读机场景反馈）

---

## [0.4.2] - 2026-08-01

### Added
- **一键重启**：Supervisor 模式后端完整重启，WebSocket 自动重连，重启后会话自动恢复
- **bash 后台执行**：长驻服务 detached 运行 + 日志写文件，立即返回 PID 不阻塞
- **工具中断**：SSE abort + 进程树杀，长思考/长命令可随时打断
- **自我续推**：continue_turn 主动触发自己下一轮推理，无需等待用户输入
- **隐藏工具机制**：危险管理工具（system_restart）不在发现流程中展示，仅显式配置启用
- **工具分级模型**：基础/工具/开发/管理四层，按用户角色自动注入/剔除

### Improved
- **系统提示词指引重编排**：11 组分类（基础→管理），同类型合并
- **重复消息去重窗口**：8s → 60s，防止用户无意重发被吞

### Fixed
- **打断链路不再崩溃**：abort 异常捕获 + 进程级兜底，长思考中打断进程存活
- **打断后消息重复持久化**：重连/reload 不产生重复消息
- **重启瞬间去重失效**：去重缓存跨重启保留

---

## [0.4.1] - 2026-08-01

### Added
- **read_logs 日志工具**：Agent 可直接读取后端运行日志（内存环形缓冲，支持级别/关键词/条数过滤），调试不再依赖人工复制
- **群聊归档**：群聊达到阈值自动归档，每个参与者独立整理自己的群聊记忆（sessions/<agent>/group__<id>/memory.md），配合摘要锚点解决长群聊的上下文膨胀
- **群聊双阈值**：归档触发阈值（默认 50K）+ 单次加载上限（默认 30K），多 Agent 共享历史时防止 token 消耗爆炸
- **归档前记忆整理**：1:1 会话和群聊归档前，系统自动触发参与者基于完整上下文整理记忆（memory/TODO/note），整理完成才归档
- **工具分类重构**：开发工具（reload/code_search/inspect_session）从自动注入改为按需配置；browser 整合为全局工具
- **全局定时任务管理**：全局面板可增删改定时任务（时间/提示/目标 Agent）

### Fixed
- **工具调用事件串台**：chat.toolcall 事件缺 sender 校验，其他 Agent 的工具调用会串流到当前会话界面
- **归档标记路径错位**：归档标记改为 canonical 排序路径，双边会话（Agent↔Agent）不再因路径不对称而无法归档
- **群聊归档参与者读不到**：AppState 未注入 GroupManager，导致群聊参与者列表为空、归档不触发
- **群聊整理轮被跳过**：postHook 的 group_id 分支在 archiveReview 判断之前，群聊整理轮被提前 return

---

## [0.3.3] - 2026-07-31

### Added
- **冷启动安装**：`install.bat` 从 GitHub latest release 一键下载 → 校验 → 解压 → 安装
- **缓存复用**：zip 有效则跳过下载，损坏则自动清理重试
- **aria2c 加速**：检测到 aria2c 时 16 连接多线程下载；否则 fallback curl（断点续传 + 重试）
- **zip 完整性校验**：下载后自动验证格式，损坏重试（最多 3 次）
- **下载统计**：curl `--write-out` 输出字节数、耗时、速度

### Fixed
- **CI zip 格式错误**：Git Bash GNU `tar -a` 生成 tar 而非 zip，改为 PowerShell `Compress-Archive`
- **`update.bat` 版本解析**：简化为 `findstr` 直接提取，移除 PowerShell 依赖
- **bat 语法错误**：`for /f` 单引号与 PowerShell 冲突、`echo` 在 if 块内提前闭合、延迟展开 + 缺少 `pause`
- **bat 编码**：移除 `chcp 65001` 和所有 Unicode，全 ASCII
- **原子下载**：先 `.tmp` 再校验后 move，防止中断产生半截文件

### Changed
- Node.js 便携版 → **v24.18.0**（Krypton LTS）

---

## [0.3.2] - 2026-07-31

### Fixed
- **`update.bat` 下载失败**：多行 PowerShell `^` 续行符传给 PowerShell 导致语法错误
- **`update.bat` 编码乱码**：Node.js 检测与 `start.bat` 统一（自动解压 `node-portable.zip`）
- **前端文件链接**：`FILE_PATH_PATTERN` 不匹配裸路径；`TurnDisplayItem` 未转发 `previewFile` 事件

---

## [0.3.1] - 2026-07-31

### Added
- **ratio 滑块**：比例型配置项拖动滑块 + 百分比显示

### Changed
- **会话归档**：`archiveMinMessages` → `archiveTokenRatio`，token 比例比消息数更精准
- **`keepRecentRatio`**：20% → 2.5%，更激进截断降成本

### Fixed
- **归档死循环**：水位过于接近导致归档后立即再次触发
- **bash**：循环依赖、maxBuffer OOM、危险命令检测补全、stdin 支持、5 类友好错误提示

---

## [0.3.0] - 2026-07-31

### Added
- **Hashline v2 编辑协议**：read 输出 `[PATH#TAG]` 头部 + `行号:内容`；edit 支持 DSL patch
- **DSL 操作**：`SWAP`（替换）、`INS.PRE/POST/HEAD/TAIL`（插入）
- **文件级哈希**：4 字符 TAG，edit 时验证防并发冲突
- **write 输出 TAG**：无需重新 read 即可 edit
- **compress 对话框**：trigger → trim 全流程
- **AgentList Token 水位**：侧栏实时显示每个 Agent 的 token 占用
- **Token 占用预测 API**：`/api/sessions/:agentId/tokens`

### Changed
- **read/edit 重组**：`shared.ts`（61 行）+ `hashline-parser.ts` + `hashline-executor.ts` + `edit/tool.ts` 纯路由
- **Hashline v1 → v2**：行级哈希 → 文件级哈希，JSON edits → DSL，8 字符 → 4 字符
- **压缩机制**：marker 文件替代直接 `agent.receive()`
- **滚动**：仅初始加载自动滚底，`requestAnimationFrame` 等布局

### Fixed
- **edit 模糊匹配越界**：`matchedLen` 精确追踪
- **LLM 孤 tool_calls**：调用前过滤
- **clean-sessions.py**：重写为顺序构建器，修复而非删除；扩展到归档文件
- **虚拟 Agent**、**重复 marker**、**archiveAndRebuild 绕过** 等多项修复

---

## [0.2.0] - 2026-07-30

### Added
- **Steer**：立即中止 LLM 推理，提前进入下一轮 ReAct
- **SVG Logo**：聊天气泡 + Agent 节点 + 品牌紫渐变
- **一键更新**：`update.bat` 从 GitHub latest release 下载
- **write 预览**：文件名点击弹窗，语法高亮 + 行号 + 复制
- **＋ 下拉菜单**：新增 Agent / 创建群组合并入口
- **群聊简介编辑**：抽屉 textarea
- **日期分隔符**：今天/昨天/前天/三天前
- **思维链时间标签**："已思考 X 秒"
- **思维链工具摘要**：折叠栏 `read · edit · bash`
- **edit 返回 updated_hashes**：下次 edit 直接定位
- **局域网访问**：绑定 `::`，Vite `host: true`

### Changed
- **MCP 独立扩展**：`agent-mcp` 与 `agent-prompt` 完全解耦
- **agent-prompt 瘦身**：移除工具/MCP 描述块，由模型 `tools` 参数注入
- **统一管线**：私聊 + 群聊共用 `TurnDisplayItem`，`agent_id` 驱动
- **Turns 重构**：computed → 事件驱动增量 ref
- **思维链**：流式展开 → 结束 500ms 折叠；chain-body 思考 → 工具 → 正文
- **Token 面板**：移除总览 tab → 汇总条 + Agent/日期双 tab
- **气泡宽度**：`turn-item` 70% 统一管控
- **Sidebar**：Agent + 群组按时间混排
- **历史查询**：按消息计数，默认 10 轮
- **发布脚本**：`启动AgentChat.bat` → `start.bat`

### Fixed
- **WS 串台**：`cid` 会话粒度路由
- **记忆审查**：`idleArchive` + VirtualAgent `postHook`
- **群聊合并**：UUID 格式 ID 自动识别、不再合并
- **edit diff 行号**：`mergeLineRanges` gap 2 → 0
- **markdown 连字**：`font-variant-ligatures` 禁用
- **归档重叠**、**文件指数膨胀**、**steer 内容保留** 等

### CI
- push `release` → latest pre-release；push `v*` → 正式版本

---

## [0.1.3] - 2026-07-29

### Changed
- **Node.js 延迟解压**：发布包 190MB → 89MB（首次 `start.bat` 时解压）

### Fixed
- **`plugin.json` 缺失**：tsc 不复制 `.json`，`build-release` 现在自动补齐
- **`timer-state.json` 孤儿**：启动 + 保存时自动清理
- **`set_timer` 重复**：新增 `replace` 参数

---

## [0.1.0] - 2026-07-29

### Added
- **Hash 行编辑**：read 显示行哈希，edit 用 `lineHash + newText` 精准修改
- **版本检测**：`/api/version` 对比 GitHub，弹窗显示变更日志
- **热加载**：`reload_extensions` 无需重启
- **write 上限**：1MB 防止误操作
- **自动打开浏览器**

### Changed
- **User Agent → virtual** 类型
- **更多按钮**：三处统一 `⋯`
- **版本弹窗**：700px 宽
- **名称变更即时生效**

### Fixed
- **401**：`resolveLLMConfig` 从凭据库回注
- **DeepSeek**：`baseURL` / `deepseek-v4-pro` 默认
- **编码乱码**：bat 全 ASCII
- **隐私泄露**：release 不复制开发 workspace
- **首个模型默认**、**菜单关闭** 等
