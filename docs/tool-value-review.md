# 工具价值评估（v0.7.1 · 2026-08-20）

> 对当前 28 个内置 Agent 工具做一次价值再评估：从 **LLM 视角的不可替代性**、
> **默认装配成本**（requires=base 的工具进每个 Agent 上下文）、**重叠度**、
> **维护面**、**风险面** 五个维度打分，输出保留/降级/合并/精简建议。
> 目录数据源：docs/assembly-catalog.md §2；装配语义见 tools service（presets 过滤 → requires 门禁 → exclude → include → 默认启用）。

## 1. 评估口径

| 维度 | 说明 |
|------|------|
| 价值 | 高 = 没有替代品的核心能力；中 = 有替代品但场景更优/更安全；低 = 低频或可被其他工具覆盖 |
| 默认成本 | requires=base 且 owner 在默认 presets 中的工具，**每个 Agent 每 run 都注入 schema**（上下文 token 开销） |
| 重叠度 | 与其他工具的语义/功能覆盖 |
| 维护面 | 实现规模、依赖、测试 |
| 风险面 | 权限面/沙箱/失控/凭据暴露 |

默认装配下（新建 Agent）：**20 个 base 工具** + admin/dev/conductor 按标签增补；`str_replace_editor`、`inspect_session` 等因 requires 或 owner 过滤默认不可见。

> 落地更新（2026-08-20）：`code_search` 已移除（与 grep 重叠）；`continue_turn` 已移除（Agent 主动使用场景≈0，chat.continue 兜底）；新增 `job` 后台任务管理工具（补 bash background 管理缺口）；browser/update_agent_profile/timer 描述已精简（见 §8）。当前 27 个工具 = 原 28 − code_search − continue_turn + job。

---

## 2. 价值矩阵

### A. 高价值（核心生产力，保留）

| 工具 | 价值判断 | 说明 |
|------|----------|------|
| read | 高 | 文件读取主通道，「行号:内容」输出直接支撑 edit 文本匹配（old_string 复制）；无替代 |
| write | 高 | 新建文件唯一正典路径（edit 不建新文件）；覆盖语义有防护提示 |
| edit | 高 | 文本匹配 + 行级 DSL 双模式，模糊匹配降低 diff 失败率；核心编辑能力 |
| glob | 高 | 比 bash find 安全（沙箱黑名单同口径）、结构化、结果有界；LLM 首选 |
| grep | 高 | 比 bash grep/rg 安全可控（跳过二进制/黑名单、内联上限 250）；LLM 首选 |
| bash | 高 | 万能逃生通道（构建/进程/管道/后台）；与 glob/grep/math 形成"专用优先"分工 |
| job | 高（配套） | bash background 的配套管理：list（本 Agent 任务+状态）/ kill（按不透明 job_id，仅已登记）/ logs（日志尾部）——补上"只能启动、无法管理"缺口；完成通知由平台事件广播（不忙轮询） |
| web_search | 高（有条件） | 联网唯一轻量通道；**依赖 Provider+Key 配置**，未配置时不可用（部署条件） |
| ask_questions | 高 | 人机决策点唯一通道，跨重启持久化（durable suspension）——差异化能力 |
| math | 高 | 沙箱求值，避免 LLM 用 bash node/python 绕圈；成本极低 |
| timer | 高 | 自主行动（delay/time/workday/holiday 五种调度 + 归档）——平台级差异化 |

### B. 中价值（场景性，保留；部分建议精简/降级）

| 工具 | 价值判断 | 说明 |
|------|----------|------|
| browser | 中-高，**成本最高** | 真 Chromium 能力无替代（登录态/JS 渲染/截图），但描述 ~750 字符（全库最重）、依赖部署环境、调用间驻留进程；**建议大幅精简描述**（可省 300+ 字符），并按部署形态文档化禁用方式 |
| ~~query_history~~（已拆分 2026-08-20） | 原判：中-高 | 拆为 grep_history（关键词全量检索）+ read_history（分页翻阅）：检索与翻阅语义分离、参数各自收敛；描述明确支持查自身与任何 Agent/群聊的历史 |
| ~~continue_turn~~（已移除 2026-08-20） | 原判：中 | 自我 steer 低频且 Agent 主动使用场景≈0；用户侧"继续"由 WS `chat.continue` 覆盖，故直接移除（省 1 个 base 工具的 schema 成本） |
| send_agent | 高（多 Agent 部署） | 协作核心；单 Agent 部署下闲置 |
| send_group | 中 | 群聊场景专用；非群聊 Agent 几乎不用（成本 ~220 字符，可接受） |
| list_agents | 中 | 配合 send_agent 发现协作对象；成本低 |
| list_groups | 低-中 | 群聊参与者查询，低频；成本极低（~60 字符），保留 |
| list_tools | 低-中 | 自我反思：LLM 本就知道自己的工具定义，价值在"实际启用集"（含 include/exclude 覆盖）；低频，成本 ~160 字符，保留 |
| read_agent_info | 中 | 档案 + 印象（记忆）读取；查他人带记忆是高价值点 |
| update_agent_profile | 中，**描述最重之一** | 档案/能力自更新 + admin 可管他人；**描述 ~600 字符，建议精简**；自提升防护已有（非 admin 不能打 admin 标签） |
| subagent（conductor） | 高（conductor 域） | 并行子任务唯一通道，但仅 conductor 标签 Agent 可用（门槛高，符合设计） |

### C. 运维/开发域（requires=dev/admin，不进普通 Agent 上下文，保留）

| 工具 | 价值判断 | 说明 |
|------|----------|------|
| ~~code_search~~（已移除 2026-08-20） | 原判：中，与 grep 重叠 | 决定直接移除而非合并：grep（base）已覆盖任意 path 正则搜索，dev 调试场景用 grep 定位项目根即可，避免双维护 |
| ~~inspect_session~~（已移除 2026-08-20） | 原判：中 | 使用数据（近 7 天 46 次）主要是"看会话尾部"→ read_history 覆盖，且常见参数误用；诊断场景（统计/重复检测）用 bash+grep 承担 |
| reload | 中 | 配置热重载阶梯第一级 |
| reload_modules | 高 | L1.5 主动模块重载（零中断、可回滚）——开发期核心工具 |
| system_restart | 高 | 进程级兜底（supervisor 拉起），与 reload_modules 形成完整阶梯 |
| ~~register_tool~~（已移除 2026-08-20） | 原判：高 | 决定移除：动态能力收敛到 register_plugin 插件路径（manifest + grants 审批统一，代码注入面更小）；ToolsService 的 always/replace 注册选项保留（服务级 API） |
| register_plugin | 高 | 会话级动态加载 + 权限门禁（process/shell 显式 grants）——生态入口 |
| unregister_plugin | 中 | register_plugin 的逆操作 |

### D. 兼容层（保留，明确定位）

| 工具 | 价值判断 | 说明 |
|------|----------|------|
| str_replace_editor | 中（兼容定位） | DSH 语义移植（view/create/str_replace/insert 四命令）；与 read/write/edit 双轨。**默认被 presets 过滤**（新 Agent presets 不含其 owner），成本≈0；dsh-minimal 预设显式 include 它。定位 = DSH 兼容 + 极简模式，建议在 UI 目录标注"DSH 兼容编辑器" |

---

## 3. 冗余与重叠分析

| 重叠组 | 现状 | 评估与建议 |
|--------|------|-----------|
| **edit/write vs str_replace_editor** | 两套完整编辑 DSL 并存 | 默认装配下 str_replace_editor 被 presets 过滤，**不构成双轨成本**；保留兼容层即可。若要收敛：以 edit/write 为正典（模糊匹配/行级 DSL 更强），str_replace_editor 保持插件行可选（dsh-minimal 继续用）。**无需立即动作** |
| **grep vs code_search** | 曾为两套"正则搜源码"实现 | **已解决（2026-08-20）**：code_search 直接移除，grep（base，任意 path）统一承担；dev 场景用 grep 定位项目根 |
| **bash background vs job** | 启动无管理 | **已解决（2026-08-20）**：新增 job 工具（list/kill/logs + 后台任务登记表），bash background 启动即登记 |
| **list_agents vs read_agent_info** | 清单 vs 详情+记忆 | 分工合理（清单轻量、详情带印象记忆）；不合并 |
| **math vs bash** | math 沙箱 vs bash node/python | 分工明确（专用优先）；保留 |
| **browser vs web_search** | 重客户端 vs 轻 API | 互补（browser 处理 JS 渲染/登录态）；各自保留 |
| **reload/reload_modules/system_restart** | 三级重启阶梯 | 分工明确（配置/模块/进程），保留 |
| **timer vs subagent** | 定时 vs 并行 | 正交 |

## 4. 默认上下文成本（token 预算）

20 个 base 工具每 run 注入 schema，**估算 ~6.3–7.3k 字符（≈2.1–2.5k tokens）**，其中顶部开销：

| 工具 | 估算描述+参数长度 | 建议 |
|------|-------------------|------|
| browser | ~750 → ~300 字符 | ✅ 已精简（2026-08-20，§8.1）；保留动作枚举，压缩解释段 |
| update_agent_profile | ~600 → ~330 字符 | ✅ 已精简（2026-08-20，§8.2）；字段语义压缩 |
| timer | ~500 → ~300 字符 | ✅ 已精简（2026-08-20，§8.3）；五种 mode 合并短句 |
| ask_questions | ~420 字符 | 可微调（保留超时/持久语义） |
| bash | ~330 字符 | 保留（含平台翻译说明是必要信息） |

三项精简合计省 **~1.1k 字符（≈350–400 tokens/run）**；`job` 工具新增 ~300 字符，净省 ~800 字符/run。

## 5. 风险面

| 面 | 工具 | 评估 |
|----|------|------|
| 进程执行 | bash + job | 沙箱 cwd 限定 + PowerShell 翻译层；background 长驻进程由 **job 工具**按不透明 id 闭环管理（kill 仅已登记 id，任意 PID 走 bash 内 Stop-Process）；每 owner 活跃上限 8；kill 后由 close 回写 killed |
| 浏览器 | browser | Chromium 驻留进程 + 网络面；SSRF/凭据面与部署环境绑定——建议默认受限（文档化网络白名单） |
| 代码注入 | ~~register_tool~~（已移除 2026-08-20） | 原 vm 沙箱无 IO/进程；移除后该注入面不复存在 |
| 任意代码 | register_plugin | 权限门禁（process/shell 显式 grants）已设计；面最大但可控 |
| 档案自改 | update_agent_profile | 自提升防护已有（非 admin 不能打 admin 标签） |
| 凭据 | web_search/browser | 凭据走全局 Key 存储与脱敏钩子（security.redact-output） |

## 6. 建议动作清单（按优先级 · 含落地状态）

1. ~~**P0（成本）**：精简 `browser`、`update_agent_profile`、`timer` 的工具描述~~ ✅ 已落地（2026-08-20），前后文见 §8。
2. ~~**P1（维护）**：`code_search` 与 `grep` 双维护~~ ✅ 已落地（2026-08-20）：**直接移除 code_search**（比合并更省）。
3. ~~**P2（风险）**：`bash` 的 background 模式配套 kill 手段~~ ✅ 已落地（2026-08-20）：新增 **job** 工具（list/kill/logs）。
4. **P2（定位）**：`str_replace_editor` 在 UI 目录标注「DSH 兼容编辑器」；默认装配不动。
5. **P3（可选）**：`list_tools`/`list_groups` 保持默认启用（成本极低，价值可接受）；`browser` 在无 Chromium 部署下文档化 exclude 路径。
6. **文档**：`docs/plugins/README.md` 工具速查表升级到 v0.7.1（补 glob/grep/process/str_replace_editor，移除 code_search）。

## 7. 结论

- **无"该删的工具"→ 有"该删的重复"**：原评估 28 个工具定位均明确；唯一重复的 code_search（与 grep 重叠）已直接移除——不是合并成薄封装，而是删掉整套实现（dev 场景用 grep 覆盖）。
- **缺口已补**：bash background「只能启动、无法管理」→ job 工具闭环；三个重描述工具已精简（§8），每 run 约省 ~1.1k 字符。
- **默认装配的 20 个 base 工具**（现含 job、不含 continue_turn）整体是"专用优先 + bash 兜底"的健全结构。
- 真正的价值差异点在平台级能力：`ask_questions`（持久交互）、`timer`（自主行动）、`subagent`（并行执行）、`register_*`（自我进化）——建议后续能力建设围绕这四条线展开。

---

## 8. 描述精简记录（2026-08-20 · 待复核）

> 依据 §4 成本分析，精简三个重描述工具。原则：保留语义要点与动作枚举（参数 schema 与描述互补），压缩解释性文字。
> 估算节省：browser ~750→~300 字符（-60%）、update_agent_profile ~600→~330（-45%）、timer ~500→~300（-40%）；合计每 run 约省 **~1.1k 字符（≈350–400 tokens）**。

### 8.1 browser（src/web/web/src/tools.ts）

**旧**：

> 操作真实 Chromium 浏览器。先用 action="open" 导航，再用 "click"/"type"/"press" 交互，"content" 提取文本和链接，"screenshot" 截图，"close" 关闭。浏览器在调用间保持驻留——打开一次，可多次交互。

> 两种模式：1. 单动作：action + 对应参数；2. 批量：steps 数组依次执行多个动作（每个 step 含 action + 参数，可选 repeat 重复次数、delayMs 执行后等待毫秒），适合重复动作/多步操作一次完成；continueOnError=true 遇错继续

> Actions: open{url}/click{selector}/type{selector,text}/press{key}/content{}/screenshot{name?}/html{}/eval{js}/close{}

**新**：

> 操作真实 Chromium 浏览器（调用间保持驻留，可多次交互）。先 action="open" 导航，再 click/type/press 交互，content 提取文本与链接，screenshot 截图，close 关闭。两种模式：单动作（action+参数）或批量（steps 数组，每步可带 repeat 重复次数 / delayMs 等待毫秒；continueOnError=true 遇错继续）。动作：open{url}/click{selector}/type{selector,text}/press{key}/content{}/screenshot{name?}/html{}/eval{js}/close{}

### 8.2 update_agent_profile（src/agent-tools/agent-tools/src/tools.ts）

**旧**：

> 更新 Agent 档案与能力清单：name/description/persona/avatar/tags/presets/tools/hooks。默认更新自己的档案；admin（含 admin 标签）可传 agent_id 更新其他 Agent。非管理员不能给自己打 admin 标签。tags=能力标签（base/dev/admin/conductor；base 为隐式基础能力层）；presets=启用插件（cordis 插件名列表）；tools={ include, exclude } 工具意图覆盖（include=显式启用、exclude=显式停用，exclude 优先）；hooks=七类钩子启用清单（数组顺序即执行顺序，不在清单里即停用）。

**新**：

> 更新 Agent 档案与能力清单（name/description/persona/avatar/tags/presets/tools/hooks）。默认改自己的；admin 可传 agent_id 改其他 Agent；非管理员不能给自己打 admin 标签。tags=能力标签（base/dev/admin/conductor）；presets=启用插件（cordis 插件名列表）；tools={include,exclude} 意图覆盖（exclude 优先）；hooks=七类钩子启用清单（数组顺序即执行顺序，不在清单即停用）。

### 8.3 timer（src/svc/timer/src/tool.ts）

**旧**：

> 定时任务管理。action 指定操作：set 添加/修改（mode: delay 固定间隔 / random 随机间隔 / time 每天定时 / workday 工作日 / holiday 节假日；例行任务用 repeatCount=0 永久；一次性提醒用 repeatCount=1 + 完整日期时间如 2026-08-03 09:00，完成后自动归档；提供 id 更新，replace 替换旧任务）；list 查看当前全部任务；disable 禁用指定任务（不删除，可重新启用）。target 逗号分隔，默认 user。

**新**：

> 定时任务管理。action：set 添加/修改（mode=delay 固定间隔 / random 随机间隔 / time 每天定时 / workday 工作日 / holiday 节假日；repeatCount=0 永久例行，1=一次性提醒（完成后自动归档）；带 id 更新，replace 替换旧任务）/ list 查看全部 / disable 禁用（不删除，可重新启用）。target 逗号分隔，默认 user。
