# 日期使用清点（epoch-inventory）

> cr-1 配套清点产物（2026-09-27）。全仓日期标记的类别、分布与处置裁决的**事实底册**——
> 修正已全部落地，本文件是历史依据，不随日常开发更新。

## 一、清点范围与方法

- 扫描面：全仓文本文件（git 跟踪 1418 个 + 2 个未提交新文件），排除 node_modules/.git/dist/
  coverage/workspace 运行时数据/desktop release 产物/mobile 构建缓存。
- 识别形态：`YYYY-MM`（月份标记，无日）、`YYYY-MM-DD`（完整日期）、路径/文件名中的日期。
- 元方法：无代码解析注释日期标记（timer/datetime 的日期正则是运行时用户数据面，无关），
  修正不影响任何功能。

## 二、类别与处置总表

| # | 类别 | 修正前规模 | 处置 | 修正后形态 |
|---|---|---|---|---|
| 1 | 注释/文档正文中的 `YYYY-MM` 月份标记（git 跟踪面） | 811 处 / 285 文件 | **分层还原**（见 §三） | 566 处真实提交日 + 21 处 `YYYY-MM-00` + 少数重写消除 |
| 2 | 同上，未提交新文件（memory-timeline-plan.md、compose-final-emit.test.ts） | 5 处 / 2 文件 | 同上（blame 不到 → 原月+00） | `YYYY-MM-00` |
| 3 | 已是完整日期 `YYYY-MM-DD` 的标记 | ~300 文件 | 维持原样 | 不变 |
| 4 | 命名中的日期（标识符） | 外部归档目录 + 2 文档名 | 归档目录**同步改名**（用户裁决）；文档名保留 | 见 §四 |
| 5 | 仓库外/产物目录（desktop release、mobile 缓存等） | 若干 | 不在仓库，未动 | — |
| 6 | 功能性日期值（测试冻结时钟等） | FROZEN_NOW 等 | **保留不改** | 见 §五 |
| 7 | 约定文档自身（epoch-marking-convention.md） | 16 处 | 随 cr-1 重写消除（CR 目录后迁 `cr-log.md`） | 重写后为新语义 |

## 三、类别 1+2 分层还原语义（用户裁决 A）

两步走：先全量展开 `YYYY-MM` → `YYYY-MM-00`（中间态），再按起源分层定日：

- **建仓前史前标记（2026-01/02，21 处）→ 原月 + `-00`**：首提交 2026-07-07，建仓前文档
  （旧轨沉淀）的月份本身是真实历史月份，日不可考 → 如 `2026-02-00`。
- **其余（2026-08/09/10/11/12，566 处）→ 逐行 git blame 取该行真实提交日**：计划纪元的
  假未来月份（如 2026-12）被还原成真实写下的日期（多为 9 月某日），语义从「批次代号」
  回归「日历日」。blame 不到的未提交行 → 原月 + `-00`（最终 0 处遗留——全部命中）。

修正前分布（git 跟踪面）：2026-12 ×444 · 2026-11 ×280 · 2026-09 ×87 · 2026-10 ×78 ·
2026-02 ×14 · 2026-01 ×7 · 2026-08 ×1。（另 release 产物内 2020-12 ×8 未入库，系第三方库时间戳。）

重灾区（修正前标记数）：CHANGELOG.md ×33 · ac-session/index.ts ×31 · ac-subagent/service.ts ×27 ·
docs/archive/m27-webui-slot-refactor-plan.md ×23 · src/README.md ×22 · feed-core.ts ×21 ·
ac-client-ui-layout/index.ts ×18 · visual-snapshot.test.ts ×12。文件级逐处明细以本次提交的
git diff 为准。

## 四、命名日期处置（用户裁决 B：同步改名）

| 位置 | 处置 | 说明 |
|---|---|---|
| 外部归档目录 `C:\Users\xiaofeng\Documents\Dev\Note\AgentChat\docs-stale-2026-12\` | **改名 `docs-stale-2026-09-18\`**（归档真实日 = 引入行 blame 日期） | 物理目录 + 外部自引用 2 处 + 仓库内引用 13 处全链同步 |
| `src/docs/run-code-usage-profile-2026-09-20.md` | 保留 | 文件名已是完整日期 |
| `src/docs/session-audit-backlog-2026-09-22.md` | 保留 | 同上 |

## 五、功能性日期值（保留——是数据不是标记）

| 位置 | 性质 |
|---|---|
| `src/webui/tests/visual-snapshot.test.ts` `FROZEN_NOW = new Date('2026-11-20T12:00:00+08:00')` | 视觉快照测试冻结时钟——改动即破坏全部快照基线 |
| timer/datetime/usage 包的 `YYYY-MM-DD` 运行时数据面（节假日清单、日期行文本、流水日期键） | 用户/运行时数据，非注释标记 |

## 六、结论

修正后全仓规则态：注释与文档中的日期要么是完整真实日期 `YYYY-MM-DD`（存量已按 blame 还原），
要么是 `YYYY-MM-00`（史前/不可考，共 26 处）。新写标记一律完整日期，规约见
`epoch-marking-convention.md`。