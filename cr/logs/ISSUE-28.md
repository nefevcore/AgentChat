1:# ISSUE-28 沙箱相对上跳检查：多处绕过（2026-11-22）
2:
3:## 现象
4:
5:`bashCommandViolation` 对相对上跳（`../`）的越界检查存在多处绕过。
6:分两轮发现：第一轮由 tester 报「绝对路径被拦但相对上跳能读」牵出，
7:第二轮 tester 复测报出 4 条残余绕过（全部经探针实证成立）。
8:
9:## 三条缺口与修法
10:
11:### 缺口①：引号包覆整条绕过
12:
13:原实现 `(?:^|\s)(\.\.[\\/]...)` 要求 `..` 前邻是行首或空白，
14:引号里 `..` 前是 `'`/`"` 不匹配 ⇒ 不产出 refs ⇒ 第 4 条检查整体跳过。
15:
16:| 命令 | 修复前 |
17:|---|---|
18:| `Get-Content ../../x` | 拦截 |
19:| `Get-Content '../../x'` | **null 放行** |
20:| `Get-Content "../../x"` | **null 放行** |
21:
22:同文件盘符绝对路径用 lookbehind `(?<![A-Za-z0-9_])` 允许引号前邻，
23:形成「绝对形态拦、相对形态放行」的策略不一致。
24:
25:### 缺口②：只认 token 起始处的 ..
26:
27:`./../../x`（人的自然写法，非攻击构造）与 `x/../../../y`（路径中段）均绕过：
28:前者 `..` 前邻是 `/`，后者 `..` 不在 token 起始。
29:
30:修法：正则从「前面限界 + `..`」改为「token 内任意位置含 `../`」：
31:
32:```ts
33:// 原
34:seg.match(/(?<![^\s"'`=(])\.\.[\\/][^\s;|&"'`]*/g)
35:// 新
36:seg.match(/[^\s;|&"'`]*\.[\\/][^\s;|&"'`]*/g)
37:```
38:
39:`a..b` 中 `..` 后是 `b` 非斜杠，不匹配 ⇒ `git diff a..b` 行为不变。
40:
41:### 缺口③：换目录规则只认 `cd`
42:
43:`\bcd\s+` 不覆盖 PowerShell `Set-Location`、`pushd`、`chdir`——
44:`Set-Location ..; Get-Content x` 直接绕过 cd 规则。
45:
46:修法：`/\b(?:cd|Set-Location|pushd|chdir)\s+("?[^\s"]+"?)/i`
47:
48:### 缺口④（本轮新增）：选项前缀的 resolve 偏差
49:
50:`--file=../../x` 整体 resolve 时 `--file=..` 被当普通目录名、吃掉一次上跳：
51:
52:```
53:path.resolve('/ws/root', '--file=../../x') => /ws/root/x   ← 根内，放行
54:path.resolve('/ws/root', '../../x')         => /x            ← 根外，拦
55:```
56:
57:修法：对每个 ref 同时判「完整 token」与「去掉前缀的上跳后缀」，任一越界即拦：
58:
59:```ts
60:const cut = p.search(/\.\.[\\/]/);
61:const tail = cut > 0 ? p.slice(cut) : undefined;
62:if (!isAllowed(p) || (tail !== undefined && !isAllowed(tail))) { ... }
63:```
64:多拦不少拦，安全侧。
65:
66:## 未覆盖（记录，不扩大改动面）
67:
68:**变量拼接动态构造**：`$a='..'; Get-Content ($a+'/'+$a+'/x')` —— 字面量 `..`
69:后不跟斜杠，静态扫描天然不匹配。要防需运行时路径校验（另一层），
70:非命令串扫描能解决的范围。
71:
72:## 验证
73:
74:`packages/ac-sandbox-core/tests/bash-scan-dotdot.test.ts`（9 用例）：
75:
76:- 应拦 8 条：裸写 / 单双引号 / `./`前缀×2 / 路径中段 / 等号前缀 / 四种换目录别名
77:- 应放 7 条（防过度拦截）：根内上跳 / `./a.txt` / `sub/a.txt` / `cd sub` /
78:  `Set-Location sub` / `git diff a..b` / `git log HEAD~1..HEAD` / URL / `hello..world`
79:
80:对照组（按纪律，先红后绿）：
81:- 缺口①修复前：`SINGLE => null`、`DOUBLE => null`（2 failed）
82:- 缺口②③修复前：`P1 ./引号 => null`、`P2 中段 => null`、`P4 Set-Location => null`
83:- 缺口④：`--file=../../x` 修复前测试红（171 中 1 failed），修复后绿
84:
85:全量：ac-sandbox-core + ac-shell-tools + ac-fs-tools **14 files / 171 tests passed**；
86:`tsc --noEmit` 无输出（通过）。
87:
88:## 装载面（重要，第三种粒度）
89:
90:`bashCommandViolation` 由 **`ac-shell-tools`** import ⇒ **命令沙箱检查跑在壳进程**，
91:不在宿主。所以：
92:
93:> **修复按壳生效。每个 Agent 壳要各自重启才装载。**
94:
95:粒度三层：① 包（源码 mtime）② 进程（壳 boot vs 宿主 boot）③ **同一包内不同壳进程之间**。
96:实测当时 7 个壳（news/nana/neko/tester/admin/__standard__/__creator__）全部早于
97:修复 mtime，即**全部仍在跑旧代码**——这是「全局已修」与「每个 Agent 实际行为」的分界。
98:
99:## 判据纪律（本轮沉淀）
100:
101:验沙箱修复必须测**三组**，缺一不可：
102:
103:1. **越界应拦** —— 只测这组会把过度拦截当成功
104:2. **合法应放** —— 防误伤（如 `(?<![^\s])` 全拦死，单看第 1 组是 100% 绿）
105:3. **换 Agent 复测** —— per-Agent `security.json` 使同一用例对不同 Agent 结论相反
106:   （admin 授整仓 ⇒ `../../meta` 可读；tester `{}` ⇒ 越界）。只测一个 Agent
107:   会把「对 tester 误伤」当成「无误伤」。
108:

## 运行时验证（2026-11-22 23:48，admin 壳 pid 15184 boot 23:48:30 > mtime 23:47:15）

按三组判据实测，全部通过：

**第一组·越界应拦（5/5）**：
```
① ./ 前缀上跳      Get-Content './../../.../Windows/win.ini'   → 拦截
② 路径中段上跳     Get-Content a/../../.../Windows/win.ini     → 拦截
③ Set-Location 上跳 Set-Location ../../../../..; ...            → 拦截（cd 规则命中）
③b pushd 上跳      pushd ../../../../..; ...                    → 拦截
④ --file= 上跳     Get-Content --file=../../.../Windows/win.ini → 拦截
```

**第二组·合法应放（6/6，无误伤）**：
```
仓内上跳(引号) '../../meta/timer/state.json'  → 可读 len=2663
相对路径 tmp/esc.txt                          → 可读
./ 本地文件 ./tmp/esc.txt                      → 可读
git log HEAD                                  → 正常
echo hello..world                             → 正常
Set-Location tmp（仓内）                      → 正常切到 tmp
```

**第三组·换 Agent 复测 —— 未通过（这是分界线，不是缺陷）**：
```
名称           pid     boot      状态
news          30740   21:00:00  旧代(无修复)
nana          9312    22:33:28  旧代(无修复)
neko          25644   22:33:28  旧代(无修复)
tester        35720   22:33:32  旧代(无修复)
__standard__  38668   23:44:23  旧代(无修复)
__creator__   14928   23:46:50  旧代(无修复)
admin         15184   23:48:30  新代(含修复) ← 仅此壳验证通过
```

**这组数据本身是「第三种粒度」的实证**：源码已修、宿主已重启，但 6 个壳进程
仍是旧代 ⇒ 它们此刻仍带全部 4 条缺口。修复对它们的生效条件是**各自重启壳**。
这正是「全局已修」与「每个 Agent 实际行为」的分野——任何按壳装载的修复都适用。

## 缺口⑤：裸 `..` 参数（无尾斜杠，tester 第二轮报出）

上一条规则要求 `..` 后跟斜杠，**非 cd 命令的裸 `..` 参数无人接住**：

| 命令 | 修复前 | 修复后 |
|---|---|---|
| `Get-ChildItem ..` | 放行 | 拦 |
| `Get-ChildItem -Recurse ..` | **放行（可枚举整棵父目录树）** | 拦 |
| `dir /s ..` | 放行 | 拦 |
| `Get-Item ..` | 放行 | 拦 |
| `Get-Content ../` | 拦 | 拦 |

**影响面准确说**：文件内容仍读不到（读内容必须带斜杠的 `../`），泄的是目录树结构
（名称/大小/存在性）；但 `-Recurse` 足以枚举整棵 workspace 树，对「探测有哪些
Agent、哪些会话」够用。

修法：按边界切词取纯 `..` 词，走 `isAllowed` 判定——

```ts
const bareDots = seg.split(/[\s"'`=()]+/).includes('..');
if (bareDots && !isAllowed('..')) { ... }
```

`a..b`（token 内双点）、`./a.txt`、`...`（三点）、`echo 12.5/3` 均不含纯 `..` 词，
不受影响；`echo ..` 若解析后仍在允许根内则放行，不误拦。

## 静态扫描的能力边界（架构级，已登记 ISSUE-29）

tester 用绕过手段做验证并如实上报：

```js
// cwd 下写 scancheck.mjs，内容 import 沙箱根之外的模块
await import('../../../../packages/ac-sandbox-core/src/index.ts')
// node scancheck.mjs → 成功执行
```

**扫描器只看命令串，不看脚本内容。** 持 shell 的 Agent 可：写脚本 → `node script.mjs`
→ 脚本内 `fs.readFileSync(任意路径)`。

同机对比：`git -C <外部路径>` 被拦（含 `..` 命中），`node <脚本>` 畅通 ⇒ **拦截强度
取决于命令形态，不是路径策略**。

结论：逐条补正则的做法**不可能收敛**——每补一条，换种写法仍可绕。真正解法在运行时层
（受限 job / 容器，或对解释器类命令单独限权）。本文件记录的 ①~⑤ 只覆盖「命令串里
出现越界路径字面量」这一面，不构成沙箱安全承诺的全部。

## 用例口径（勘误）

`it()` 个数 ≠ 断言条数。当前 `bash-scan-dotdot.test.ts`：**11 个 `it()` / 23 条 expect**。
此前「9 用例（8 应拦 + 7 应放）」把两种口径混写了（8+7=15 与 it 数 9 不符），
正确记法：11 个 it，内含应拦断言与防误伤断言两组。

## 已知误报（缺口⑤ 的取舍，不修）

缺口⑤ 用「纯 `..` 词 + isAllowed」判定，无法区分**数据语境**与**路径语境**：

| 命令 | 结果 |
|---|---|
| `echo ..` / `echo .. done` | 拦（`..` 越界时） |
| `Write-Output ".."` / `'..'` | 拦 |
| `git log --format=..` | 拦 |
| **`Select-String -Pattern ".." -Path a.txt`** | 拦 ← 正则「任意两字符」写法，非路径 |

**影响面精确说明（重要，比「引入 6 条误拦」更窄）**：
判定条件是 `bareDots && !isAllowed('..')`——**只有 `..` 解析后越界时才拦**。所以：

- **权限受限 Agent**（如 tester，`security.json={}` 仅 cwd）：上跳一级即越界 ⇒ 上述 6 条**确实被误拦**
- **整仓授权 Agent**（如 admin，授 `AgentChat` 全仓）：`..` 解析后仍在根内 ⇒ **全部放行，无误拦**

实测对照：
```
admin 运行时（整仓授权）      tester 代码层（roots 单根）
echo ..                  ALLOW    BLOCK
echo .. done             ALLOW    BLOCK
Write-Output '..'        ALLOW    BLOCK
Select-String -Pattern .. ALLOW   BLOCK
```

两者都对——差别在权限前提，不是规则缺陷。

**不修的理由**（tester 提出，采纳）：
1. 静态扫描无法区分「位置性 `..`（路径参数）」与「数据性 `..`（字符串/正则）」，
   要区分就得做参数语义分析
2. 若按参数名放行（`-Pattern`/`-Value` 白名单），下一轮即可构造
   `-Pattern .. -Path ../..` 组合绕过——**不收敛，与 ISSUE-29 同源**
3. 同类先例：源码注释已有「引号内直接执行的代码不在剥离范围」的已知残留误报

属「多拦不少拦」取舍。**受影响者请避开**：读状态用 `tools.read`/`grep`，
匹配字面双点用 `[.][.]` 或 `\.\.` 转义，不用裸 `..` 作正则。
