# 「打开方式」功能——dsh 调研结论与 AgentChat 实施计划

> cr-828（2026-10-31）。两轮调研产物：① dsh（deepseek-harness）「选择打开方式」功能的完整机制解剖；
> ② 本地 0.2.0-rc.2 与远程 master（0.2.2-alpha.2，2026-10-28）的对比核对。本文档是下会话实施的事实底稿——
> 实施时以本文档为需求源，不再重新调研 dsh 源码。

---

## 一、背景

- AgentChat 已有「本地打开」（cr-827 刚修复：`workspace/open-local` 忽略会话上下文的 bug，face-ops.ts
  `resolveWorkspaceFile` 单源已接通）——但只有「系统默认程序」一条路，无法选择用哪个应用打开。
- dsh（`@deepseek-ai/dsh`，deepseek-harness）有两套「打开方式」能力：**目录式**（预置应用目录探测，打开工作区目录）
  与**文件式**（OS 文件关联枚举，打开单个文件）。用户点名要「下拉选择记事本/VSCode/文件资源管理器」。

## 二、dsh 机制解剖（结论速查）

### 2.1 目录式：`dsh-host-open-in-app` + `dsh-client-ui-open-in-app`

**架构三件套**：

1. **编译期固定目录表**（catalog.ts，~27 条，纯数据）：文件管理器 3（Finder/Explorer/xdg-open）+
   编辑器 IDE 11（VSCode×2/Cursor/Windsurf/Zed/Sublime/Xcode/Android Studio/JetBrains 七件套）+
   Git GUI 7 + 终端 9。每条按平台声明 **locator 链**（按序尝试，产出「已验证启动器」——本机实际持有的 exe，
   绝不是裸安装记录）：
   - win32：`App Paths` 注册表 → Uninstall 记录（须能证明磁盘 exe 存在）→ 已知安装路径（`${LOCALAPPDATA}/Programs/...`）→
     版本化目录扫描（JetBrains `%ProgramFiles%\JetBrains\<产品>*` 取最新）。注册表用 `reg.exe query /s` **每根键一次批量读**，
     解析时用 `REG_*` 类型标记定位值列（规避本地化的「(默认)」文案）。
   - darwin：`/Applications`、`~/Applications` 查 bundle 拼写 → `open -a <bundle>`；Xcode 跟 `xcode-select -p`。
   - linux：PATH CLI（进程内 stat，无 shell/which）→ XDG desktop 条目 `TryExec`/`Exec` 验证。
2. **三条 HTTP 路由**（宿主 webServer）：
   - `GET /open-in-app/apps` —— 可用应用 id 列表（解析 map 的 keys）
   - `GET /open-in-app/icon/<id>` —— 真实应用图标 PNG（win: exe 关联图标 32px 经 PowerShell `ExtractAssociatedIcon`；
     mac: icns→128px；linux: hicolor 主题），进程内缓存，取不到 404 → 前端占位图形
   - `POST /open-in-app/open` —— `{app, path}`，wire 校验（JSON 媒体类型/64KiB/id 可用/绝对路径且现存目录）
3. **前端分体按钮**：主按钮 = 上次记住的应用（持久化 `dsh.open-in-app.choice`），箭头下拉列全部已装应用；
   记住的不可用时回落第一个可用；只有一个可用项 = 单按钮无箭头。会话头部/文件树/文档标题栏共用选择状态。

**关键工程决策（dsh README「已知限制」明说的裁决，值得照抄）**：

- **目录编译期固定，不无边界枚举 OS 应用**——能定位 ≠ 能接收目录参数（各 app 启动协议不同：`--cd=`/`-d`/`--working-directory=`）。
  用户自定义 handler 明确延后。
- **解析惰性、每进程一次**成 map，**点击绝不重新检测**；启动遇 ENOENT 只重解析该条目一次（卸载自愈），
  证不出即从列表移除。新装应用要重启才出现（接受）。
- **启动看护窗**（launchWatchMs）：detached spawn + **凭据清洗环境**（剥 `*KEY*`/`*SECRET*`）+ 窗内非零退出才算失败、
  窗关仍活 = 成功（前台常驻型进程不能等退出）。与 AgentChat `native-open.ts` 的 always 族 150ms 确认窗同思路。
- SSH 环境（`SSH_CONNECTION`/`SSH_TTY` 非空）整面隐藏，含已记住选择。

### 2.2 文件式：`dsh-native-command` 文件关联适配器 + Session Remote

- **Windows**：PowerShell（`-STA`）内嵌 C#（`Add-Type`）调 Shell COM——`SHAssocEnumHandlers` 枚举扩展名**全部注册
  handler**（含 UWP 打包应用如记事本）、`AssocQueryString` 标默认项、`SHDefExtractIcon` 提图标（base64 PNG）、
  `handler.Invoke(dataObject)` 启动指定应用（保留打包应用/DDE 语义）。路径 Base64 传入**绝不过命令行解析**（防注入），
  脚本临时文件用完即删。`WithShellLifetime` 消息泵等 Shell 异步启动完成（SHCreateThreadRef 计数归零）。
  - 踩坑沉淀（path-opener.ts 注释）：Explorer 会吞路径里的逗号/等号（自己解析命令行分割参数）——file URI 需转义
    `%2C`/`%3D`，非 ASCII 转义要**解码回字面量**（Explorer 拒绝 percent-encoded 非 ASCII 会开错到 Documents）；
    Explorer 退出码 1 = 委托给已运行桌面进程（成功语义）。
  - 打开走 Explorer 而非自读关联：「进程自己解析关联读到的记录比双击窄」——交给 shell 的默认应用决议。
  - intent 三值：`default`（浏览器文档优先默认浏览器）→ `association`（严格关联）→ `text-editor`（mac `open -t`，
    防 YAML 关联到浏览器抢走编辑手势）。
- **mac**：`open`（LaunchServices）；**Linux**：GIO 关联查询；**WSL**：`wslpath -w` 转译后交 Windows 桌面。
- **前端共享查询 store**（file-applications.ts）：`useSyncExternalStore` + 引用计数——同文件多挂载控件共享一次查询，
  打开任一菜单刷新全部，最后一个释放即取消；**查询失败 ≠ 空列表**（失败时保持 reveal 可用）。

### 2.3 远程 vs 本地 rc.2 对比结论

- **核心机制冻结**：catalog 27 条、locator 结构、三路由语义、Windows COM 适配器——rc.2 已与 master 一致，无关键 bugfix 落后。
- **演进在前端交互面**：rc.2 之后新增**右键菜单体系**（file/directory/workspace/url 四种菜单目标：侧栏打开/浮窗打开/
  文件管理器定位/默认应用打开带图标/复制路径）+ 文件关联共享查询 store + 浮窗移动标签。dsh 的新方向 = **「打开方式」
  做进右键菜单**，触达面比头部分体按钮广。

## 三、AgentChat 实施计划

### 3.1 范围裁决（先做什么）

**P0（本轮）目录式**：预置应用目录探测 + 「打开方式」下拉。理由：覆盖用户点名场景（记事本/VSCode/资源管理器）的 90%；
不依赖 Shell COM 生命周期管理（重、难测）；与现有 `native-open.ts` 平台矩阵同族。

**P1（后置）文件关联枚举**：Windows `SHAssocEnumHandlers` 全量 handler 枚举 + 指定应用打开。重（COM/STA/C# 内嵌/
Shell 生命周期），等 P0 落地验证交互形态后再评估。

**不做**：无边界 OS 应用枚举（dsh 同款裁决）；应用图标提取（先用 iconify 图标或纯文本菜单项，图标是锦上添花——
AgentChat 的菜单是 kit Select/IconAction 标准件，不是 dsh 那种品牌化分体按钮，没有真实图标的强需求）。

### 3.2 P0 设计

#### 后端（两个新 RPC + 一个纯模块）

1. **`packages/ac-workspace/src/open-targets.ts`（新建，纯模块，零 cordis 依赖——与 native-open.ts 同族形态）**：
   - 目录表（精简版，先收录高频目标）：
     - `explorer`：win shell-open（复用 `runNativeOpen`）/ mac Finder / linux xdg-open
     - `vscode`：win `App Paths`(`Code.exe`) → Uninstall 记录 → `${LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe`；
       mac bundle；linux `code` CLI。启动参数：**目录** `"<dir>"`、**文件** `-g "<file>"` 或直接传文件
     - `cursor`：同 vscode 形态（`Cursor.exe`/`${LOCALAPPDATA}/Programs/cursor/`）
     - `notepad`：win `${SystemRoot}\System32\notepad.exe`（文件单参；目录不适用 → 目录菜单中隐藏）
     - `windowsterminal`：win `wt -d <dir>`；`terminal`：mac `open -a Terminal`
     - 首期就这 6 条，覆盖用户点名场景；后续按需加（JetBrains 系可后补）
   - 探测函数 `resolveOpenTargets(platform, probe)`：纯函数 + 注入 probe seam（测试可注入假 stat/reg 查询）；
     每进程一次惰性解析成 map（id → { launch: argv | shell-open, label }），与 dsh 同款「点击不重探测」。
     win 注册表读取用 `reg.exe query`（spawn，参数数组无 shell）或直接读 `HKCU/HKLM`——**用 reg.exe 子进程最简**
     （AgentChat 已有 spawn 编排经验；.NET Microsoft.Win32.Registry 需 addon 不可用）。
   - 失效自愈：启动遇 ENOENT → 重解析该条目一次，证不出移除（照抄 dsh refreshResolution）。
2. **RPC（face-ops.ts，宿主直读面——与 workspace/open-local 同居）**：
   - `workspace/open-targets` → `{ targets: [{ id, label, kind: 'dir' | 'file' | 'both' }] }`（解析 map 投影；
     带 kind 是因为 notepad 只能开文件、terminal 只能开目录——前端按当前目标过滤）
   - `workspace/open-with` → `{ id, path, agentId?, conversationId? }` → `{ opened } | { error }`；
     **路径定位复用 cr-827 的 `resolveWorkspaceFile` 单源**（文件）+ `resolveOpenDir`（目录）——本功能不新开守卫面。
3. **启动编排**：复用/扩展 `runNativeOpen`——argv 形态（detached + stdio ignore + 凭据清洗 env + 看护窗确认）
   与 shell-open 形态（转交现有 openCommands）。凭据清洗：AgentChat 宿主 env 里有池凭据（credentials 目录之外还有
   process env 的 key），**spawn env 白名单制**（只传 PATH/SYSTEMROOT/TEMP 等必需项）比 dsh 的黑名单剥除（`*KEY*`/`*SECRET*`）更稳。

#### 前端（一个下拉菜单，三处挂点复用）

- 「本地打开」IconAction 升级为**下拉触发器**：点箭头弹菜单（kit Select 或 IconAction + 自绘弹层，
  FilePreviewTabPane 已有格式下拉先例可抄），菜单项 = `workspace/open-targets` 结果（按 kind 过滤）+ 首项「系统默认程序」
  （= 现有 open-local 行为）。
- 记住选择：localStorage（`agentchat.openWith.choice`），记住的 id 不在可用列表时回落「系统默认程序」。
- 三处挂点：FilePreviewTabPane / FilePreviewModal（文件）、FileEditsPanel（文件）、工作区树节点（目录——
  与「本地资源管理器」动作合并为同一菜单）。
- 失败反馈：现有 toastError 通道（`key: 'open-local'` 同款）。

#### 测试

- `open-targets.test.ts`：平台矩阵（win/mac/linux 各 locator 命中序）+ probe seam 注入假注册表 + ENOENT 自愈。
- face-ops RPC 测试：`open-with` 走 resolveWorkspaceFile 定位（cr-827 测试同款桩）+ id 未知/不可用 → error。
- 前端：菜单渲染（kind 过滤/记住选择回落）纯函数单测。

### 3.3 实施顺序（建议单会话内完成 P0）

1. `open-targets.ts` 纯模块 + 单测（探测/解析/自愈，全部可离线测）
2. face-ops 两条 RPC + 测试（复用 cr-827 测试桩形态）
3. 前端下拉（先 FilePreviewTabPane 一处打通，再复制到 Modal/FileEditsPanel/树）
4. 验证阶梯：typecheck + test:unit + check:deps + 定向 lint + webui:typecheck；重启宿主后真机点验
   （RPC 直打 + 窗口可见性探测，cr-827 同款手法）

### 3.4 已知风险与预案

- **VSCode 已运行时的目录打开**：`Code.exe <dir>` 会开新窗口而非复用——VSCode CLI `code <dir>` 才复用窗口。
  P0 简单起见直接 exe 传参（新窗口可接受），P1 可优化为优先 PATH 上的 `code` CLI。
- **reg.exe 输出本地化**：dsh 用 `REG_*` 类型标记定位列——照抄（`/^s+(.*?)s+(REG_SZ|REG_EXPAND_SZ)s+(.*)$/`）。
- **detached + env 白名单**：Windows GUI 进程 env 太瘦可能崩（缺 SYSTEMDRIVE 等）——白名单至少含
  PATH/SYSTEMROOT/SYSTEMDRIVE/TEMP/TMP/LOCALAPPDATA/PROGRAMDATA/USERPROFILE/COMSPEC。
- **macOS/Linux 覆盖**：本机是 Windows，mac/linux 分支按 dsh catalog 照抄、单测锁行为面（提审自查第 5 问）。

## 四、参考文件（实施时直接读）

- dsh 本地包（0.2.0-rc.2，行为与 master 一致）：`C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
  - `dsh-host-open-in-app/lib/index.js`（bundle 内联：catalog 表 + resolver + 三路由，~1400 行）
  - `dsh-native-command/lib/index.js`（文件关联 COM 适配器 + path-opener）
  - `dsh-client-ui-open-in-app/README.zh.md`（前端交互规格）
- AgentChat 侧：
  - `packages/ac-workspace/src/native-open.ts`（现有平台矩阵与 spawn 编排——P0 扩展基座）
  - `packages/ac-host-webui/src/face-ops.ts:499`（cr-827 修复后的 open-local——open-with 同居与同源守卫）
  - `packages/ac-host-rows/src/workspace-files.ts`（resolveWorkspaceFile 单源）
  - `packages/ac-host-webui/tests/face-ops-open-local.test.ts`（cr-827 测试桩形态——open-with 测试照抄）
  - `packages/ac-client-ui-workspace/client/FilePreviewTabPane.vue`（下拉菜单 UI 先例 + 本地打开挂点）

---

*调研方法记录：dsh 仓库 `git clone` 在慢链路超时，改经 GitHub API 按需拉取源文件对比（raw.githubusercontent +
contents API）；本地包 bundle 为编译内联产物，与远程六文件源码逐一核对行为面。*