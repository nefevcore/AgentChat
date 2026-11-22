# ISSUE-28 沙箱相对上跳检查：引号包覆绕过（2026-11-22）

## 现象

`bashCommandViolation` 对相对上跳（`../../x`）的越界检查只看**前邻是行首或空白**的形态，
引号/等号/括号包覆时不进入判定，整条命令绕过扫描。

实测（`packages/ac-sandbox-core`，roots=[/ws/root], cwd=/ws/root）：

| 命令 | 修复前 | 修复后 |
|---|---|---|
| `Get-Content ../../secret/x.txt` | 拦截 | 拦截 |
| `Get-Content '../../secret/x.txt'` | **null（放行）** | 拦截 |
| `Get-Content "../../secret/x.txt"` | **null（放行）** | 拦截 |

## 根因

原实现：`seg.match(/(?:^|\s)(\.\.[\\/][^\s;|&"'`]*)/g)`

`(?:^|\s)` 要求 `..` 前邻是行首或空白。引号包裹时前邻是 `'`/`"`，不匹配 ⇒ 该段
不产出 refs ⇒ 第 4 条检查整体跳过（第 1/2 条绝对路径检查也不覆盖相对形态）。

注意盘符绝对路径那条用了 lookbehind `(?<![A-Za-z0-9_])`，允许引号前邻，所以
`'C:\...'` 会被拦——**同一文件、绝对形态拦、相对形态放行**，策略不一致。

## 修法

前邻限界改为否定 lookbehind，覆盖行首/空白/引号/等号/括号：

```ts
const refs = seg.match(/(?<![^\s"'`=(])\.\.[\\/][^\s;|&"'`]*/g);
```

- `(?<![^\s"'`=(])`：前一个字符**不是**「非空白非引号非 = 非 (」⇒ 即必须是行首/空白/引号/=/(
- 位置 0 时 lookbehind 自然通过（前面无字符）
- `git diff a..b`：第二点后非斜杠，`\.\.[\\/]` 不匹配，行为不变

## 未覆盖（记录，不扩大本次改动）

`cat x/../../../etc/passwd` 这类「路径中段含上跳」仍不检查：`../` 前是 `/`，
lookbehind 排除。属原设计的既有取舍（注释称排除 token 内 `..`），与本次引号缺口
是两件事，未在本次修改。

## 验证

- 新增 `packages/ac-sandbox-core/tests/bash-scan-dotdot.test.ts`（6 用例：3 拦截 + 3 防误伤）
- 旧实现红 / 新实现绿：修复前探针实测 `SINGLE => null`、`DOUBLE => null`（2 failed）
- 全量：ac-sandbox-core + ac-shell-tools + ac-fs-tools **14 files / 168 tests passed**

## 装载面

依赖方横跨两侧：`ac-host-rows`（宿主侧）+ `ac-shell-tools`/`ac-fs-tools`（壳侧）
⇒ 需 restart_host 与 restart_shell 各一次才在运行时生效。
