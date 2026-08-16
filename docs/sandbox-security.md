# 沙箱与安全防护方案（Sandbox & Security Design）

> 状态：设计方案 → 已按 v0.6.2 插件化架构落地（持续演进）
> 当前实现位置：`src/toolkit/toolkit/src/{paths,shared}.ts`（沙箱/脱敏）、`src/security/security/src/{security,redact,register}.ts`、
> `src/agents/agents/src/credential-store.ts`、`src/shell/shell/src/tools.ts`（bash）、`src/core/agent-loop/src/loop.ts`。
> 正文中的旧路径映射：`tools/shared.ts` → `toolkit/src/{paths,shared}.ts`；`tools/files.ts` → `shell/src/tools.ts`（bash）或 `fs/src/tools.ts`（write）；`hooks/security.ts` → `security/src/security.ts`；`builtin-math/tools.ts` → `math/src/tools.ts`；`agents/credential-store.ts` → `agents/agents/src/credential-store.ts`；`server/api/config.ts` → `host/server/src/api/config.ts`；`core/loop.ts` → `core/agent-loop/src/loop.ts`；`app/loader.ts` → `boot/boot/src/loader.ts`。

---

## 1. 背景与目标

AgentChat 是"活"的多 Agent 社区：Agent 拥有 `read` / `write` / `edit` / `bash` / `web` 等工具，
配合定时任务、随机巡检等**自主行动**能力。自主性带来价值，也带来风险。

### 1.1 威胁边界（用户明确的红线）

| 行为 | 允许？ | 说明 |
|---|---|---|
| Agent 自主说话、自主调用工具 | ✅ | 这是产品核心 |
| 正常自主升级代码（改 src/、跑构建、升级依赖） | ✅ | 需要放开项目根访问 |
| **密钥泄露**（API Key、凭据、token 外传/进入对话） | ❌ | 红线 |
| **项目破坏到不可运行**（删关键代码、破坏构建、不可回滚） | ❌ | 红线；可回滚 = 不算破坏 |

### 1.2 威胁模型分层

| 对手 | 典型场景 | 防线目标 |
|---|---|---|
| 笨 Agent（LLM 偶尔失误） | 误删、误改、误外传 | 启发式拦截 + 快照 |
| 被污染的 Agent（提示注入） | 读了恶意网页/群聊被操控 | 密钥脱敏 + 快照 + 审计 + 高危请示 |
| 外部网络攻击者（公网接入后） | 经中转服务器/网络入口未授权访问、暴力破解、DoS | 配对认证 + TLS/E2EE + 限流 + 审计（§4.6） |
| 恶意 Agent（本地代码篡改） | 刻意构造绕过沙箱 | **不在威胁模型内**（本地个人项目，攻击者能写 src/ 就能改沙箱本身） |

> **公网里程碑的影响**：双端协同（中转服务器）上线后，攻击者多了一条"远程间接操控"路径——
> 另一端发来的消息可携带**提示注入**。本地沙箱从"可选项"升级为**必需品**（详见 §4.6）。

### 1.3 设计哲学

> **没有攻不破的沙箱，只有"突破了也有后果兜底"的沙箱。**

放弃"设计完美隔离"的目标（不可能），改为三层纵深：

1. **提高攻击成本** —— 让"顺手越界"被拦截，恶意操作需要精心构造
2. **限制破坏半径** —— 即使突破，损失可控（密钥不可见、关键目录受保护）
3. **可恢复 + 可观测** —— Git 快照可回滚、审计日志可追溯

并以"**人做最终仲裁**"兜底：机器判断不准没关系，高危操作请示用户。

> 里程碑前瞻：公网接入（双端协同）后，威胁模型新增"外部网络攻击者"一类（§4.6），
> 且远端消息放大提示注入面——届时本地沙箱是**必需品**而非可选项。

---

## 2. 现状盘点

### 2.1 已有防线

| 层 | 实现 | 位置 | 强度 |
|---|---|---|---|
| 路径沙箱 | `resolveSafePath`：工作区 + `security.allowedPaths` 白名单前缀匹配 | `tools/shared.ts` | ⭐⭐⭐ |
| bash 命令级沙箱 | `bashCommandViolation`：正则拦截 `cd ..` / 盘符 / 绝对路径 / `../` | `tools/files.ts` | ⭐（可绕过） |
| 代码求值 | `builtin-math`：`node:vm` + 全局白名单 + 2s timeout | `builtin-math/tools.ts` | ⭐⭐ |
| 档案安全钩子 | `makeSecurityStartHook`：禁改他人档案 / 禁改 `agents/` 配置目录 | `hooks/security.ts` | ⭐⭐⭐ |
| 凭据存储 | `~/.agentchat/credentials.json`，AES-256-GCM + PBKDF2，绑定本机 | `agents/credential-store.ts` | ⭐⭐⭐ |
| API 掩码 | `/api/config` 回填凭据时显示 `••••••••` | `server/api/config.ts` | ✅ |

### 2.2 关键事实

- **项目源码（src/、package.json、项目根）默认在沙箱工作区 `workspace/default/` 之外**：
  `read`/`write`/`edit`/`bash` 默认碰不到，仅 `web`(grep) 工具（`projectRoot = workspaceRoot 上两级`）
  和显式配置 `security.allowedPaths` 后可访问。
- 因此"允许自主升级代码"= **主动放开项目根访问**，同时暴露两条风险线（密钥泄露、项目破坏）。
- **bash 沙箱与白名单对齐（2026-08-12 修复）**：`bashCommandViolation` 接收 allowedRoots
  （workspaceRoot + `security.allowedPaths`），命令中路径目标解析后落在允许根内放行——
  read/write/edit/bash 白名单行为一致（此前 bash 独立正则硬拦 `cd ..` / `..\` 引用，
  即使白名单已授权项目根也被拦，与 read 行为不一致，曾误导 Agent 以为"路径穿透配置有问题"）。

### 2.3 已知缺口（按风险排序）

| # | 缺口 | 风险 | 位置 |
|---|---|---|---|
| G1 | bash spawn 继承全部 `process.env`（**后续迭代将移除全部环境变量，改用配置驱动** → 此缺口随之消解；过渡期可先不管控） | 🟡 密钥泄露（过渡期） | `tools/files.ts` spawn |
| G2 | 前端 iframe `sandbox="allow-scripts allow-same-origin"`（高危组合，等同无沙箱） | 🔴 前端注入 | `FilePreviewModal.vue` |
| G3 | 无输出脱敏：即使读到密钥，原文直接进入 LLM 上下文/对话 | 🔴 密钥泄露 | `core/loop.ts` 工具结果出口 |
| G4 | 无 git 检查点：破坏性操作不可回滚 | 🟠 项目破坏 | — |
| G5 | bash 危险命令无拦截：`git clean -fdx` / `git reset --hard` / `rm -rf 根` | 🟠 项目破坏 | `tools/files.ts` |
| G6 | 敏感文件无黑名单：放开项目根后 `.env` / `*.pem` / `id_rsa` 可读 | 🟠 密钥泄露 | `tools/shared.ts` |
| G7 | 路径沙箱无 realpath：工作区内 symlink 可穿透到工作区外（TOCTOU） | 🟡 越界 | `tools/shared.ts` |
| G8 | bash 后台任务 `unref()` 后无人管理，僵尸进程 | 🟡 资源 | `tools/files.ts` |

---

## 3. 方案总览

```
┌──────────────────────────────────────────────────────┐
│ A. 密钥保护（堵泄露路径）                              │
│    · 输出脱敏（主力）        · 敏感文件黑名单(DENY)      │
│    · 命令文本值拦截          · 环境变量净化（过渡）       │
├──────────────────────────────────────────────────────┤
│ B. 可恢复性（放行自主改代码 + 破坏可回滚）              │
│    · Git 隐形检查点（git stash create）                │
│    · rollback 工具                                    │
├──────────────────────────────────────────────────────┤
│ C. 灾难拦截（只拦"不可恢复"操作）                      │
│    · 危险命令黑名单          · 关键目录写保护           │
├──────────────────────────────────────────────────────┤
│ D. 高危操作请示（人做最终仲裁）                        │
│    · 命中高危模式 → 自主 Agent 放行+快照 / 否则请示     │
├──────────────────────────────────────────────────────┤
│ E. 前端 iframe 修复（G2）                             │
└──────────────────────────────────────────────────────┘
```

---

## 4. 详细设计

### 4.1 A · 密钥保护（堵泄露路径）

#### 4.1.1 环境变量净化（过渡措施；后续移除环境变量后废弃）

> **迭代决定（2026-08-12）**：后续版本将移除全部环境变量、改用配置驱动，
> 故本节**不做为主要防线**，仅作为过渡期可选加固：
> bash spawn 时默认剥离密钥型变量（名称匹配 `/API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i`），
> 不再引入 `envAllowlist` 配置字段。

**连带影响（重要）**：移除环境变量后，密钥存放点只剩**凭据库**（`~/.agentchat/credentials.json`，
工作区外）与 `config.json`（工作区内，Agent 可读）。因此：

- **输出脱敏（§4.1.2）与敏感文件黑名单（§4.1.3）升级为主要防线**——必须保留并实现；
- 建议：`config.json` 中密钥字段读取侧统一走凭据库（现状已抽离 api_key），
  工具层对 `config.json` 内的密钥字段值同样纳入脱敏清单。

**过渡措施实现**：`tools/files.ts` 的 spawn 处组装 `env`（剔除密钥型变量，
名称匹配 `/API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i`）。移除环境变量后本节废弃。

#### 4.1.2 输出脱敏（redaction）

**问题**：无论从哪条路径读到密钥，原文会作为工具结果进入 LLM 上下文（`core/loop.ts` L430 返回值 → 消息）。

**设计**：在工具结果统一出口做脱敏。清单来源：
1. **精确值**：`credential-store` 的全部明文凭据值 + `config.json` 中的密钥字段值；
2. **通用模式**：`sk-[A-Za-z0-9]{20,}`、`api[_-]?key\s*[=:]\s*['"]?...` 赋值模式等。

```ts
// core/loop.ts —— 工具结果出口（content 赋值后、插入消息前）
content = redactSecrets(content, secretRegistry);
```

**实现落点**：`core/loop.ts`（统一出口，全工具生效）；脱敏器本身做成可注入服务
（`secretRegistry` 由装配层注入，避免 core 依赖凭据存储）。

> 说明：redaction 对"笨 Agent / 被污染 Agent"足够有效；对刻意编码绕过的恶意 Agent
> 不设防（不在威胁模型内）。属纵深防御最后一道。

#### 4.1.3 敏感文件黑名单（DENY，优先于 allow）

**问题**：放开项目根后，`.env`、`*.pem`、`id_rsa`、`.npmrc`、`.git-credentials` 均可读。

**设计**：在 `resolveSafePath` 的 allow 白名单之上叠加 DENY 列表（DENY 优先）：

```
~/.agentchat/ 整目录（含 credentials.json）
**/.env
**/*.pem
**/id_rsa* / **/*_rsa
**/.npmrc
**/.git-credentials
```

- 内置默认 DENY 集（不可覆盖）；`security.denyPaths` 可追加（glob 或前缀匹配）。
- 对 `read` / `write` / `edit` / `bash`（含 bash 内 `Get-Content` 等，经命令文本检查）生效。

**实现落点**：`tools/shared.ts`（`resolveSafePath` 扩展 + `isDeniedPath`）。

#### 4.1.4 命令文本值拦截

**问题**：Agent 可能把密钥值**硬编码进命令文本**（`curl -H "Authorization: Bearer sk-xxx"`），
绕过输出脱敏；且值会进入 bash 日志/进程列表。

**设计**：bash 命令文本若包含**脱敏清单中的精确值** → 拒绝执行，
提示"请用环境变量传递，不要写进命令"。强制所有敏感值只存在于"进程环境"一种形态，
让脱敏点唯一、好管控。

**实现落点**：`tools/files.ts` 的 `bashCommandViolation` 扩展（传入 secret 清单）。

### 4.2 B · 可恢复性（允许改代码 + 破坏可回滚）

#### 4.2.1 Git 隐形检查点

**问题**：允许自主改代码 = 允许破坏性改动；必须保证可回滚。

**设计**：`write` / `edit` / `bash` 执行前，若项目根是 git repo，自动打快照：

```ts
// 幂等：同一会话同一 HEAD 只打一次
const snapshot = execSync('git stash create', { cwd: projectRoot });
// 输出：commit 对象 hash（不改变工作区状态的"隐形"快照，含未跟踪文件）
```

- 快照 hash + 时间 + 触发工具，记录到会话元数据（`workspace/default/sessions/...`）。
- 每会话维护快照列表，最多保留 N 个（环形）。

**实现落点**：`tools/files.ts` / `hooks/security.ts`（写操作前）+ 会话元数据。

#### 4.2.2 `rollback` 工具

给 Agent（或用户）提供回滚能力：

```
rollback [snapshot]           # 回滚到指定快照（默认最近一个）
rollback --list               # 列出本会话快照
```

- 实现：`git stash apply <snapshot>`（保留后续差异）或 `git reset --hard`。
- 破坏到跑不动 → Agent 可自愈，无需人介入。

**实现落点**：新增内置工具（`tools/git-snapshot.ts`）。

### 4.3 C · 灾难拦截（只拦"不可恢复"操作）

有快照兜底后，只需硬拦两类：

**① 会摧毁快照/未跟踪数据的操作**（高置信度模式，宁少勿多）：

```
git clean -fdx / git clean -fd     # 删所有未跟踪文件（.env、配置），快照救不回
git reset --hard / git checkout .  # 丢工作区改动
Format-* / Clear-Disk / Initialize-Disk
Remove-Item -Recurse -Force <项目根|盘符根>
del /s /q <盘符根> / rd /s /q <盘符根>
```

**② 关键数据目录写保护**（丢了不可重建，且不属于"代码"）：

```
.git/                                  # 防篡改历史/快照
workspace/default/{sessions,groups,usage}   # 所有 Agent 记忆与对话
workspace/default/agents/              # 已有 security hook 保护 ✅
```

**实现落点**：`tools/files.ts`（`bashCommandViolation` 扩展危险模式）、
`hooks/security.ts`（写保护目录扩展）。

### 4.4 D · 高危操作请示（人做最终仲裁）

**问题**：机器判断永远有漏洞（"不管怎么设计都有突破点"）。

**设计**：命中高危模式的操作**不直接拒绝**，而是按 Agent 自主性分级：

```
命中高危模式（危险命令 / 敏感路径 / 越权动作）
        │
        ▼
  Agent 配置 autonomous: true  → 放行，但先打 git 快照 + 记审计
  否则                          → 挂起，向 UI 发请示事件，等用户"允许/拒绝"
```

- 请示事件走现有事件通道（`chat.tool_execution.*` 同构），UI 增加确认弹窗。
- 用户允许后执行、结果与审计日志关联；拒绝则返回错误 tool 消息。

**实现落点**：`core/loop.ts`（挂起机制 + 请示事件）、`hooks/security.ts`（高危判定）、
UI 确认弹窗。

### 4.5 E · 前端 iframe 修复（G2）

**问题**：`sandbox="allow-scripts allow-same-origin"` 是 OWASP 明示的"等同无沙箱"组合。

**设计**（三选一，按成本递增）：
1. 去掉 `allow-same-origin`，仅保留 `allow-scripts`（文件预览一般够用，推荐）；
2. `srcdoc` / blob URL 隔离；
3. 独立子域（`preview.localhost`）彻底不同源。

**实现落点**：`src/ui/webui/src/components/chat/FilePreviewModal.vue`。

### 4.6 F · 公网接入 / 双端协同安全设计（里程碑前瞻）

> 迭代里程碑：后续将开放公网访问，经一台**中转服务器**做双端请求转发，
> 发送前以**二维码/密码配对**匹配才允许。本小节先行固化设计要点，实施时另行细化文档。

**定性**：公网场景的攻击者是**外部网络攻击者**（远程、只能经网络入口），
与"恶意 Agent 攻击"（本地代码篡改）是**两类威胁**，防线在**网络层**而非沙箱层。

**① 配对认证（二维码/密码）**——思路正确（类 Tailscale auth / WebRTC pairing / 蓝牙配对），
但需满足：
- 配对码**高熵**（≥128bit）、**一次性**、**短期过期**；二维码承载可防键盘记录/日志泄露；
- 配对交换全程 **TLS**（防中间人截获配对码）；
- **失败限流 + 锁定**（防暴力破解）；每设备独立码、可单独吊销。

**② 中转服务器信任模型**：
- 默认**不可信中转**：端到端加密（E2EE），服务器只转发密文（防"服务器泄露=全泄露"）；
- 若退化为服务器可见明文，则服务器成单点风险，需按等信任级防护。

**③ 防滥用 / DoS**：
- 连接数、消息大小、频率限流；配额按配对设备计；
- 无认证流量直接丢弃。

**④ 关键交叉点（重要）**：公网可达后，**另一端发来的消息可携带提示注入**——
远程用户/被攻破设备可间接操控本地 Agent。因此：
- 本地沙箱（密钥脱敏、git 快照、高危请示）从"可选项"升级为**必需品**；
- 建议：远端消息标记来源（remote），安全钩子对"非本地用户"来源的消息按更高风险档处理（如强制高危请示）。

### 4.7 G · 落地分层（层级归属）

> 遵循项目 5 层单向依赖铁律（core 零上层依赖 / plugins 仅依赖 core+agents / 服务经装配注入）。
> **约 90% 改动落在 L3 `plugins/builtin/`，L1 只加"挂点"不做策略实现，L2 凭据层只读，L5 负责装配注入与 UI。**

| 任务 | 层级 | 落点 | 说明 |
|---|---|---|---|
| 输出脱敏（P0-1） | **L1 变换挂点 + L3 实现 + L5 注入** | 挂点：`core/agent-loop/src/loop.ts` 的 `toolExecutionEndHook` 变换返回（`string | { content?, details? }`）；实现：`security/security/src/redact.ts`（`makeRedactEndHook`，注册名 `security.redact-output`）；注入：`agents/config.ts` 装配钩子 + `boot/loader.ts` 写 `services.redactSecrets` | loop 只应用变换结果，脱敏策略归 security 插件，是否启用由 Agent `config.hooks.toolExecutionEnd` 决定 |
| 敏感文件黑名单（P0-2） | **L3** | `plugins/builtin/tools/shared.ts`（`resolveSafePath` 扩展 DENY） | 与 `allowedPaths` 同层同文件 |
| iframe 修复（P0-3） | **L5** | `ui/webui/.../FilePreviewModal.vue` | 前端组件 |
| 命令文本值拦截（P1-1） | **L3** | `tools/files.ts`（`bashCommandViolation`） | secret 清单来自 L3 redact 服务 |
| Git 检查点 + rollback（P1-2） | **L3** | 新增 `tools/git-snapshot.ts` + `hooks/security.ts` | git 命令内联，绕开 plugins→services 铁律 |
| 危险命令 + 写保护（P1-3） | **L3** | `tools/files.ts` + `hooks/security.ts` | 同层 |
| 高危操作请示（P2-1） | **L1+L3+L5** | `core/loop.ts` 挂起 + `hooks/security.ts` 判定 + webui 确认 UI | 复用现有 `ask_questions` 交互桥模式 |
| realpath/TOCTOU（P2-2） | **L3** | `tools/shared.ts` | 同层 |
| 后台任务治理（P2-3） | **L3** | `tools/files.ts` | 进程注册表内联 |
| 审计日志（P2-4） | **L3+L4** | `hooks/security.ts` + 会话元数据 | 经注入或 L3 直写 |

**三条设计原则**：

1. **沙箱是插件领域知识，不是引擎能力**——与现有 `resolveSafePath` / `bashCommandViolation` /
   security hook 的 L3 定位一致，L3 是"沙箱主战场"；
2. **L1 只提供通用变换挂点，不实现策略**——`toolExecutionEndHook` 已从“观察”升级为
   “观察 + 变换”（可返回替换后的 `content/details`），脱敏作为 `security.redact-output`
   钩子注册；loop 不 import 任何脱敏/凭据代码；
3. **跨层能力经装配注入，不直接 import**——复用现有模式：插件读交互桥经
   `PluginServices.interaction`、core 事件经 `AgentAssembly.emit`；脱敏所需的全局
   密钥值由 L5 `boot/loader.ts` 写入 `services.redactSecrets`，security 钩子工厂读取。

---

## 5. 配置设计（`security` 命名空间扩展）

现有：`security.allowedPaths`（白名单）。

扩展字段（均为可选，缺省保持最严格）：

```jsonc
// Agent 的 config.json（或全局 config.json 作为默认）
{
  "agent_id": "dev_bot",
  "tools": ["bash", "write", "edit"],
  "security": {
    "allowedPaths": ["../"],                // 已有：放开项目根（允许自主升级代码）
    "denyPaths": [                          // 新增：追加敏感路径黑名单（内置 DENY 不可覆盖）
      "**/.env.local"
    ],
    "autonomous": true,                     // 新增：高危操作免请示（仍打快照+审计）
    "riskLevel": "normal"                   // 新增（可选）：strict / normal / relaxed 预设
  }
  // 注：环境变量后续将移除（配置驱动），故不设 envAllowlist 字段
}
```

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `allowedPaths` | `string[]` | `[]` | 已有；路径穿透白名单 |
| `denyPaths` | `string[]` | 内置集 | 新增；DENY 优先于 allow |
| `autonomous` | `boolean` | `false` | 新增；高危操作免请示（仍打快照 + 审计） |
| `riskLevel` | `string` | `normal` | 新增（可选）；三档预设，展开为上述字段默认值 |

> 注：环境变量后续将移除（配置驱动），故不设 `envAllowlist` 字段（§4.1.1）。

---

## 6. 实施路线图

| 优先级 | 任务 | 落点 | 成本 |
|---|---|---|---|
| 🔴 P0-1 | 输出脱敏（redaction）接入工具结果出口 | `core/loop.ts` + 脱敏服务 | 半天 |
| 🔴 P0-2 | 敏感文件黑名单 DENY（含 `~/.agentchat`、config.json 密钥字段） | `tools/shared.ts` `resolveSafePath` | 半天 |
| 🔴 P0-3 | iframe sandbox 修复（去 `allow-same-origin`） | `FilePreviewModal.vue` | 10 分钟 |
| 🟠 P1-1 | 命令文本值拦截 | `tools/files.ts` `bashCommandViolation` | 半天 |
| 🟠 P1-2 | Git 隐形检查点 + `rollback` 工具 | `tools/git-snapshot.ts` + 写操作前钩子 | 1-2 天 |
| 🟠 P1-3 | 危险命令黑名单 + 关键目录写保护 | `tools/files.ts` + `hooks/security.ts` | 半天 |
| 🟡 P2-1 | 高危操作请示（挂起 + UI 确认） | `core/loop.ts` + UI | 2-3 天 |
| 🟡 P2-2 | 路径沙箱 realpath / TOCTOU 防护 | `tools/shared.ts` | 半天 |
| 🟡 P2-3 | bash 后台任务注册与回收 | `tools/files.ts` | 半天 |
| 🟡 P2-4 | 审计日志（沙箱拒绝/放行/快照事件） | `hooks/security.ts` + 会话元数据 | 1 天 |
| 🟡 P2-5 | 环境变量净化（**过渡措施**，移除环境变量后废弃） | `tools/files.ts` spawn env | 可选 |
| 🟡 P2-6 | 公网配对认证 / TLS / 限流（里程碑 §4.6） | 中转服务器 | 里程碑实施时另行规划 |

**推荐实施顺序**：P0（密钥防线 + iframe）→ P1（黑名单 + 快照 + 危险命令）→ P2（请示 + 增强）。
P0+P1 落地后即覆盖 4.1/4.2/4.3 全部主线，可独立交付。

> **2026-08-12 调整**：因后续将移除环境变量（配置驱动），原"环境变量净化 + envAllowlist"
> 不再作为主要防线（降为 P2-5 过渡措施）；**输出脱敏与敏感文件黑名单升级为 P0**——
> 配置驱动后密钥集中在 `config.json`（工作区内，Agent 可读），这两道防线成为密钥保护主力。

---

## 7. 残余风险与边界（诚实说明）

本方案**不能防**：

- **恶意 Agent 刻意绕过**（编码外传、读取 `/proc/<pid>/environ`、容器逃逸等）——
  不在威胁模型内，本地个人项目无解；
- **用户亲手授权的破坏**（`autonomous: true` + 用户点了允许）——属用户决策；
- **沙箱代码自身被篡改**（攻击者已能写 `src/`）；
- **公网入口的未授权访问 / DoS** ——由 §4.6 网络层防线（配对认证 / TLS / E2EE / 限流）负责，
  不在本沙箱方案范围（里程碑实施时单独设计）。

**能防**：笨 Agent 失误、被提示注入的 Agent（密钥不外泄、破坏可回滚、有审计可追溯）。
这是投入产出比最合理的防线集合。

> 一句总结：**路径白名单 + 密钥三件套（env 净化/脱敏/黑名单）+ git 快照回滚 + 高危操作请示**，
> 四层覆盖 99% 真实风险，剩余 1% 交给"反正有快照"的心态。
