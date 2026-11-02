# 工作区树原生应用图标——调研结论与实施计划

> cr-831 后续（2026-11-01）。前置事实稿：docs/design/open-with-app-plan.md（cr-829/830/831
> 已落地的「打开方式」体系——本文档是其树图标扩展篇，实施时以两份文档为需求源）。

---

## 一、目标与现状

**目标**：工作区树（WorkspaceTree）的文件/文件夹节点从 lucide 线性图标换成
**系统注册的原生应用图标**（.md 显示 Typora 图标、.py 显示 PyCharm/VSCode 图标、
.xlsx 显示 Excel 图标——按本机文件关联决议）。

**现状**（WorkspaceTreeNode.vue getFileIcon）：20 组扩展名 → lucide 名 + 手工色板的
静态映射。问题：无法反映本机真实关联（装了 Typora 的人 .md 还是一本书）、无扩展名
文件全部兜底同一图标、视觉与桌面经验割裂。

**已就位的地基**（cr-830 落地，直接复用）：

- packages/ac-workspace/src/open-targets.ts 的 targetIconOf()——win exe
  ExtractAssociatedIcon → 16px PNG dataURL（PowerShell -STA -EncodedCommand，
  含 32→16 高质量缩放 + A<24 幽灵环清理，进程内缓存）。这是按 exe 路径提图标。
- 前端共享 store（openWithMenu.ts）+ img 渲染（owb-app-icon 类）先例。
- 三挂点的分体按钮已吃上原生图标——树节点是同一能力的下一块阵地。

## 二、核心技术缺口：文件关联图标 ≠ exe 图标

树节点要的是「这个扩展名在本机关联到哪个应用、用什么图标」——Windows 的答案是
注册表关联链（HKCR\.md → ProgID → DefaultIcon），与按 exe 提取是两码事。三条路线：

### 路线 A（推荐 P0）：DefaultIcon 批量查询 RPC

按扩展名查询（不是按文件实例）：宿主对树内出现的扩展名集合做一次
注册表两跳直读 → "C:/.../Typora.exe,0" 形态（exe 路径 + 图标索引）→ 复用既有
PowerShell 提取管线出 16px dataURL。

- 两跳：HKCR\<.ext> 默认值 = ProgID → HKCR\<ProgID>\DefaultIcon 默认值。
  任一缺席 = null（前端回落静态表）。
- 更稳的替代：AssocQueryString(ASSOCSTR_DEFAULTICON)（走 shell 决议含用户级
  覆盖）——参考 dsh-native-command bundle（C:/nvm4w/nodejs/node_modules/
@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-native-command/lib/index.js）
行 468-620 段的 C# P/Invoke 内嵌写法（只需 AssocQueryString 单函数，比 dsh 整面
SHAssocEnumHandlers 轻得多）。**实现时二选一：注册表直读简单先行，烂再升级**。
- 目录图标：explorer 图标已提取过（cr-831 的 explorer 条目）——直接复用那份 dataURL。

### 路线 B（P1 后置）：SHAssocEnumHandlers 全量 handler 枚举

即 open-with-app-plan.md 的 P1（指定关联应用打开文件的完整面）。A 落地验证交互后
再评估，本期不做。

### 路线 C（否决）：前端逐文件请求

每节点一次 RPC = 树一开几十次查询，pass。

## 三、实施设计

### 3.1 后端（一个纯模块 + 一条 RPC）

1. **packages/ac-workspace/src/file-assoc-icons.ts（新建，纯模块零 cordis 依赖）**
   - assocIconOfExt(ext): Promise<{ source: string; index: number } | null>——
     扩展名 → DefaultIcon 源（"path,index" 解析；索引缺席 = 0）。
   - 图标提取复用 open-targets.ts 的管线——需把 extractIconViaPwsh 与缩放/清环段
     上提为共享函数 extractExeIconPng(exePath, index?)（现 targetIconOf 内联逻辑
     上提；index 透传——.exe,3 这种非零索引要取对图标，见 §四风险）。
   - 缓存双层：ext → iconSource（进程内）；iconSource+index → dataURL（进程内）。
     每扩展名一次，树刷新零重复查询。
   - probe seam 形态（TargetProbe 同款）：注册表读与 isFile 注入，测试离线锁行为面。
2. **RPC（face-ops.ts registerWorkspace 内）**
   - workspace/assoc-icons → { exts: string[] }（树内出现的扩展名清单）→
     { icons: Record<string, string | null> }（ext → dataURL；null = 无关联，
     前端回落）。批量单次——前端把当前树（含已展开层）的扩展名集合一次送去。
   - ext 白名单形态（/^[a-z0-9]{1,16}$/i），防注册表键注入。

### 3.2 前端（workspaceTreeStore 缓存 + 节点三分支渲染）

1. store（workspaceTreeStore）：extIcons: Record<string, string | null> 状态 +
   loadExtIcons(exts) 动作——树加载/展开后收集当前可见节点扩展名集合，与已请求
   集合做差，非空则批量拉取（打开新目录才发增量）。
2. 节点渲染（WorkspaceTreeNode.vue）file 行图标位三分支：
   ① store 有该 ext 的 dataURL → img.wtn-app-icon（16px，同 owb-app-icon 形态）；
   ② null → 现有 getFileIcon 静态表回落（**静态表保留**——关联图标的回落层，
     也是无扩展名文件的唯一层）；
   ③ 未加载（在途）→ 先静态表，返回后响应式换真图标（闪烁可接受，无需骨架）。
   - dir 行：explorer dataURL 全局单例（store 顶层，随首树加载取一次）。
   - getFileIcon 手工色板对 img 分支失效（位图自带色）——仅回落分支用色。
3. CSS：.wtn-app-icon { width:16px; height:16px; object-fit:contain; display:block }
   （.wtn-icon 容器 16px 已就位）。

### 3.3 测试

- file-assoc-icons.test.ts：两跳解析（ProgID 链/断链/无 DefaultIcon/UWP @{package} 形态
  弃）+ "path,index" 解析 + probe 注入 + 缓存幂等。
- face-ops RPC：ext 白名单拒非法、批量形状。
- 前端：store 增量收集纯函数单测（树快照 → ext 集合差量）。

### 3.4 验证阶梯（本会话教训固化）

pnpm typecheck && pnpm test:unit && pnpm check:deps + 定向 lint + pnpm webui:typecheck；
**前端改动必须双产物**：pnpm webui:build（主 app——WorkspaceTree* 内联在 main chunk）
+ pnpm build:channels（域通道）+ 强刷。宿主侧改动（RPC/纯模块）需 restart_host 后
RPC 直打点验（ws rpc/call 帧，参考 cr-829/830 会话探针形态）。

## 四、已知风险与预案

- **ProgID 链深浅不一**：部分关联是 URL Protocol / UWP（HKCR\<ProgID> 缺
  DefaultIcon，或值是 @{package} 形态）——UWP 直接放弃（null 回落），不做 package
  解析（dsh README 也只对 UWP 走 SHAssocEnumHandlers 特道）。
- **图标索引非零**（"exe,3"）：ExtractAssociatedIcon 只取主图标——需要
  SHDefExtractIcon(path, index) 形态（dsh bundle 行 576 的 P/Invoke 参考）。
  若实现成本高：P0 先忽略索引全部取主图标（大多数 DefaultIcon 是 ,0），失配的
  少数扩展名自然回落静态表——视觉正确性 > 覆盖率。
- **性能**：每扩展名一次 PowerShell 子进程（~600ms 首次）；树内常见扩展名 ≤15 个，
  批量 Promise.all 并发——总耗时 ≈ 单次，可接受。缓存后仅首次。
- **mac/linux**：P0 明确 win-only（非 win 平台 RPC 返回全 null，前端全回落——
  行为面单测锁）。mac LaunchServices / linux GIO 查询留 P1。
- **回归面**：getFileIcon 静态表是回落层不删；无扩展名文件、树 loading 态全走原路径。

## 五、参考文件（实施时直接读）

- packages/ac-workspace/src/open-targets.ts——提取管线（extractIconViaPwsh/
  targetIconOf/iconCache）复用与上提重构的源；explorer dataURL 现成。
- packages/ac-client-ui-workspace/client/WorkspaceTreeNode.vue——getFileIcon
  静态表（回落层）与 .wtn-icon 渲染位。
- packages/ac-client-ui-workspace/client/workspaceTreeStore.ts——树状态归属
  （extIcons 状态与 loadExtIcons 动作加这里）。
- packages/ac-host-webui/src/face-ops.ts registerWorkspace——RPC 挂点
  （workspace/assoc-icons 与 open-targets 同居）。
- dsh-native-command bundle（路径见 §二路线 A）行 468-620——AssocQueryString/
  SHDefExtractIcon 的 C# 内嵌参考。
- docs/design/open-with-app-plan.md——cr-829 体系全貌（本篇前置）。

---

*实施顺序建议：纯模块 + 单测 → RPC + 测试 → store 增量收集 → 节点三分支渲染 →
双产物重建 + 真机点验（树开几层看图标、无关联扩展名看回落）。预计单会话完成。*