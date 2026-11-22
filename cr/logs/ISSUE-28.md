# ISSUE-28 沙箱相对上跳检查：多处绕过（2026-11-22）

## 现象

`bashCommandViolation` 对相对上跳（`../`）的越界检查存在多处绕过。
分两轮发现：第一轮由 tester 报「绝对路径被拦但相对上跳能读」牵出，
第二轮 tester 复测报出 4 条残余绕过（全部经探针实证成立）。

## 三条缺口与修法

### 缺口①：引号包覆整条绕过

原实现 `(?:^|\s)(\.\.[\\/]...)` 要求 `..` 前邻是行首或空白，
引号里 `..` 前是 `'`/`"` 不匹配 ⇒ 不产出 refs ⇒ 第 4 条检查整体跳过。

| 命令 | 修复前 |
|---|---|
| `Get-Content ../../x` | 拦截 |
| `Get-Content '../../x'` | **null 放行** |
| `Get-Content "../../x"` | **null 放行** |

同文件盘符绝对路径用 lookbehind `(?<![A-Za-z0-9_])` 允许引号前邻，
形成「绝对形态拦、相对形态放行」的策略不一致。

### 缺口②：只认 token 起始处的 ..

`./../../x`（人的自然写法，非攻击构造）与 `x/../../../y`（路径中段）均绕过：
前者 `..` 前邻是 `/`，后者 `..` 不在 token 起始。

修法：正则从「前面限界 + `..`」改为「token 内任意位置含 `../`」：

```ts
// 原
seg.match(/(?<![^\s"'`=(])\.\.[\\/][^\s;|&"'`]*/g)
// 新
seg.match(/[^\s;|&"'`]*\.[\\/][^\s;|&"'`]*/g)
```

`a..b` 中 `..` 后是 `b` 非斜杠，不匹配 ⇒ `git diff a..b` 行为不变。

### 缺口③：换目录规则只认 `cd`

`\bcd\s+` 不覆盖 PowerShell `Set-Location`、`pushd`、`chdir`——
`Set-Location ..; Get-Content x` 直接绕过 cd 规则。

修法：`/\b(?:cd|Set-Location|pushd|chdir)\s+("?[^\s"]+"?)/i`

### 缺口④（本轮新增）：选项前缀的 resolve 偏差

`--file=../../x` 整体 resolve 时 `--file=..` 被当普通目录名、吃掉一次上跳：

```
path.resolve('/ws/root', '--file=../../x') => /ws/root/x   ← 根内，放行
path.resolve('/ws/root', '../../x')         => /x            ← 根外，拦
```

修法：对每个 ref 同时判「完整 token」与「去掉前缀的上跳后缀」，任一越界即拦：

```ts
const cut = p.search(/\.\.[\\/]/);
const tail = cut > 0 ? p.slice(cut) : undefined;
if (!isAllowed(p) || (tail !== undefined && !isAllowed(tail))) { ... }
```
多拦不少拦，安全侧。

## 未覆盖（记录，不扩大改动面）

**变量拼接动态构造**：`$a='..'; Get-Content ($a+'/'+$a+'/x')` —— 字面量 `..`
后不跟斜杠，静态扫描天然不匹配。要防需运行时路径校验（另一层），
非命令串扫描能解决的范围。

## 验证

`packages/ac-sandbox-core/tests/bash-scan-dotdot.test.ts`（9 用例）：

- 应拦 8 条：裸写 / 单双引号 / `./`前缀×2 / 路径中段 / 等号前缀 / 四种换目录别名
- 应放 7 条（防过度拦截）：根内上跳 / `./a.txt` / `sub/a.txt` / `cd sub` /
  `Set-Location sub` / `git diff a..b` / `git log HEAD~1..HEAD` / URL / `hello..world`

对照组（按纪律，先红后绿）：
- 缺口①修复前：`SINGLE => null`、`DOUBLE => null`（2 failed）
- 缺口②③修复前：`P1 ./引号 => null`、`P2 中段 => null`、`P4 Set-Location => null`
- 缺口④：`--file=../../x` 修复前测试红（171 中 1 failed），修复后绿

全量：ac-sandbox-core + ac-shell-tools + ac-fs-tools **14 files / 171 tests passed**；
`tsc --noEmit` 无输出（通过）。

## 装载面（重要，第三种粒度）

`bashCommandViolation` 由 **`ac-shell-tools`** import ⇒ **命令沙箱检查跑在壳进程**，
不在宿主。所以：

> **修复按壳生效。每个 Agent 壳要各自重启才装载。**

粒度三层：① 包（源码 mtime）② 进程（壳 boot vs 宿主 boot）③ **同一包内不同壳进程之间**。
实测当时 7 个壳（news/nana/neko/tester/admin/__standard__/__creator__）全部早于
修复 mtime，即**全部仍在跑旧代码**——这是「全局已修」与「每个 Agent 实际行为」的分界。

## 判据纪律（本轮沉淀）

验沙箱修复必须测**三组**，缺一不可：

1. **越界应拦** —— 只测这组会把过度拦截当成功
2. **合法应放** —— 防误伤（如 `(?<![^\s])` 全拦死，单看第 1 组是 100% 绿）
3. **换 Agent 复测** —— per-Agent `security.json` 使同一用例对不同 Agent 结论相反
   （admin 授整仓 ⇒ `../../meta` 可读；tester `{}` ⇒ 越界）。只测一个 Agent
   会把「对 tester 误伤」当成「无误伤」。
