# fs / pwsh 工具「写不出工作区」事件留档（NTFS 强制完整性 + 软件沙箱双层）

> 关联 CR：**cr-723**（2026-10-27）。性质：事故取证留档 + 两条待办（一条 bug、一条候选需求）。
> 触发场景：用户要求把旧数据根 `workspace/home-legacy-20261022` 归档到仓库外的 `Dev/Note/AgentChat`，fs 工具与 pwsh 双双失败。

## 一、现象（按时间顺序，两种完全不同的报错）

| 阶段 | 操作 | 报错形态 | 真实拦截层 |
|---|---|---|---|
| ① | `write` / `Move-Item` 写仓库外目录 | `EPERM: operation not permitted` / `Access to the path ... is denied` | **NTFS 强制完整性控制（MIC）** |
| ② | 恢复标签后，命令里写仓库外**绝对路径** | 「命令包含允许范围外的绝对路径，被沙箱拦截」 | **软件层沙箱**（`ac-sandbox-core/bash-scan.ts`） |
| ③ | 同上，但用相对路径 `..\Note\...` | 放行 | 相对引用未越界判定 |
| ④ | 命令含 ` / `（除法） | 「命令包含允许范围外的 Unix 绝对路径（/）访问」 | 软件层沙箱**误报**（见待办 1） |

两层互不相同：① 是操作系统层，②④ 是产品代码层。把 ① 误判成产品 bug 会修错地方；把 ② 当成产品「设计如此」会漏掉真 bug。

## 二、阶段①根因：目录树上的 Low 完整性标签

### 机制

Windows 强制完整性控制（MIC）给每个对象与令牌标一个完整性级别（Untrusted < **Low** < **Medium** < High < System）。规则：**低完整性进程不得写中/高完整性对象**（No-Write-Up），**与 ACL 无关**——即使 ACL 显示「完全控制」，写入照样 `Access denied`/`EPERM`。

进程的完整性级别 = **min(启动方进程完整性, 可执行文件所在对象的完整性标签)**。所以只要 exe 本体带 Low 标签，从 Medium 的 explorer 启动也会被压到 Low，整条子进程链（supervisor → 宿主 → 壳 → 工具子进程）全部继承 Low。

### 取证证据（2026-10-27 实测）

| 证据 | 命令 | 结果 |
|---|---|---|
| 进程完整性 | `whoami /groups \| Select-String "Mandatory"` | `S-1-16-4096` = **Low** |
| 目录标签链 | `icacls <dir> \| Select-String Mandatory` | 仓库根 `Dev\AgentChat` **显式** `Low (OI)(CI)(NW)`（无 `(I)` = 非继承，曾被人为设置）→ `bin`/`.dsh`/`workspace`/`sandbox` 全为 `(I)` 继承 |
| exe 标签 | `icacls bin\AgentChat.exe` | `Low (I)(NW)` —— 这是进程被压顶的直接机制 |
| exe manifest | 读 PE 内嵌 manifest | 干净（标准 `asInvoker`，**无** `requestedExecutionLevel` 特殊声明） |
| 进程链 | `Get-CimInstance Win32_Process` 上溯 | pwsh ← AgentChat.exe(壳) ← AgentChat.exe(宿主) ← AgentChat.exe(supervisor)，三级全 Low |
| 写入矩阵 | 在 TEMP / Documents / Dev / Note 各建临时目录 | **全部 DENIED**；仅 `workspace` 树内可写（那里是 Low） |
| 产品代码 | 全仓 grep + `git log -S` 全历史 pickaxe | `setintegritylevel` / `S-1-16` **零命中**；`icacls` 仅 4 处且全是错误提示文案 → **产品从未打过该标签** |
| 命令历史 | PSReadLine `ConsoleHost_history.txt` / VSCode 历史 | **无任何 icacls 命令** → 不是用户在终端手工设置 |
| VPN | 枚举进程名 `vpn\|anyconnect\|cisco` | 无 → VPN（Cisco AnyConnect 等）不做完整性降级，与本问题无关 |

### 结论

标签来源**无档案可考**（非产品代码、非用户终端操作；同期根 ACL 上还有一条无法翻译的 capability SID `S-1-4-...` 与 `Everyone:(CI)(DENY)(DC)`，疑为早期某安全/沙箱类工具或实验残留）。

一个可解释「为何以前没有」的时间线事实：用户 9 月用的是 **npm 全局版**（装在 `%APPDATA%\npm`，位于 Medium 目录），不受仓库标签影响；当前是**纯仓库形态**（`bin\AgentChat.exe`），于是 Low 生效。

### 处置（用户已执行）

```powershell
# 在普通（非管理员、Medium）终端执行一条即可，子项的继承 ACE 随之更新
icacls "C:\Users\xiaofeng\Documents\Dev\AgentChat" /setintegritylevel:(OI)(CI) medium
```

验证：仓库根/bin/workspace 均回到 `Medium Mandatory Level`，`bin\AgentChat.exe` 无显式标签（= Medium 默认），新起进程链恢复 Medium。

> 注意：**运行中的旧进程不会因标签变化而升级**——必须重启应用；本次由用户重启后生效。

### 归档结果（2026-10-27 22:4x 完成）

恢复标签并重启后，改用**相对路径**（`..\Note\AgentChat\...`，相对 cwd = 仓库根）执行 `Move-Item` 成功：

- 源 `workspace/home-legacy-20261022` 已不存在；
- 目标 `C:\Users\xiaofeng\Documents\Dev\Note\AgentChat\home-legacy-20261022`：36 个顶层条目 / 23046 个文件 / 3408 个子目录（与源一致）。

> **档位行为差异（重要观察，喂给 2c）**：同一会话内，**重启前**含绝对路径的命令未被软件沙箱拦（只被 NTFS MIC 拦），**重启后**同类绝对路径命令被软件沙箱拦。两次唯一变量是应用重启 ⇒ 会话档位（full-access）重启后未恢复，与 2c 疑点一致。
>
> ⚠️ 疑点（2026-10-27 审查，M-A）：「重启是唯一变量」证据不足——同页记录「恢复标签并重启」，MIC 标签恢复与宿主重启同时发生，两次实验并非单变量。档位未恢复是合理假设（与 gap-backlog 2c 一致），但需补一次「只重启、不改标签」或「只改标签、不重启」的对照实验。见 Note 归档根 `docs-review-2026-10-27/findings-F-misc.md`。

## 三、阶段②根因：软件层沙箱（产品自身，正常工作）

`ac-sandbox-core/src/bash-scan.ts` 在命令执行前做词法扫描，把「允许根之外」的绝对路径 / `..` 引用 / `cd` 越界拦下；允许根 = `[workdir, ...security.allowedPaths]`（`createSandboxResolver`，`paths.ts` L377）。

`ac-shell-tools/src/executor.ts` L203 调用它；L200-207 明确「**full 档跳过**」：

```ts
const unrestricted = effectiveTierOfCall(call, deps.agentsOf) === 'full-access'
if (!unrestricted) { const violation = bashCommandViolation(command, { roots: sandbox.allowedRoots, cwd: dir }) ... }
```

档位判定单源（`ac-agents/src/service.ts` L246 `effectiveTierOfCall`）：`call.elevation` 优先，否则回落 `tierOf(agent)`（`AgentConfig.tags` 含 `full-access`）；`call.elevation` 由信封承载——`ac-shell-conversation/src/service.ts` L497（cr-626 修的投递链）→ `ac-agent-loop` L385 装配进 `ToolCall.elevation`。

设计档位矩阵（`archive/security-access-tier-plan.md` L79）：full-access = **「跳过路径复检与 bash 扫描——『不做任何限制』的字面义」**。

## 四、待办（已入 `docs/design/gap-backlog.md` §A）

> **主源在 `docs/design/gap-backlog.md` §A 2a/2b/2c**：本节仅作事故留档索引，两处不一致时以 gap-backlog 为准。

1. **bug：bash-scan 把裸 `/` 误判为 Unix 绝对路径**（本次实测复现：命令里出现除法 `... / 1MB` 即被拦，报「允许范围外的 Unix 绝对路径（/）」）。根因在 L117 的 token 正则 + `isWindowsSwitch` 豁免面不含裸 `/`；除法、路径分隔符、`1/2` 之类正常文本都会误伤。
2. **需求（候选，缓行）：sandbox-access 档位用 icacls / 完整性标签强化范围限制** —— 现档位边界是**软件层白名单**（可被 `..`/变量展开/子进程绕过，属软边界）；NTFS MIC 是内核强制、无法用软件绕过。可评估：为 sandbox 档的子进程创建 Low 完整性作业对象 / 对工作区目录打 Low 标签，把「默认拒绝」下沉到内核。代价与风险（标签继承污染、清理责任、跨平台不可移植）需先评估。
3. **待复核：本会话声称 full-access 但工具层按受限档执行** —— 用户报告「本会话是 full-access，但也被阻挡」。已核：最新 `conv-settings/<convId>.json` 无 `elevation` 键（多数历史会话有 `"elevation": "full-access"`），即**会话级档位可能未落盘/未随信封投递**。需在前端复现：设置 full-access → 看 conv-settings 是否写入 → 看信封是否携带 elevation（cr-626 同类缺口）。

## 五、复现与验证命令（本次实际用过，可复用）

```powershell
# 1) 当前进程 / 目标文件完整性
whoami /groups | Select-String "Mandatory"
icacls <dir> | Select-String Mandatory

# 2) 进程链上溯（含各环节完整性，需 P/Invoke GetTokenInformation(TokenIntegrityLevel=25)）
Get-CimInstance Win32_Process -Filter "Name='AgentChat.exe'" | Select ProcessId,ParentProcessId,CommandLine

# 3) 分层定位：ACL 有权限却 Access denied ⇒ 先怀疑 MIC，再怀疑软件沙箱
New-Item -ItemType Directory <越界路径>   # MIC ⇒ Access denied / EPERM；软件层 ⇒ 「被沙箱拦截」文案
```

## 六、经验（写进排查手册的两条）

1. **两种 EPERM 要分开**：`Access denied`（无文案、来自 OS）优先查完整性标签；中文文案（「被沙箱拦截」）是产品软件层。
2. **`icacls` 显示 `(F)` 完全控制 ≠ 能写**：完整性控制与 ACL 是两套独立机制，判断可写性必须同时看 `Mandatory Label`。
