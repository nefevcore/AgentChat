# 装配菜单代数交接（menu-assembly-handoff）

> 性质：交接——cr-1022 装配菜单代数批 1-3 落地后的进度快照与批 4 / 后继接力入口。
> 状态：现行 · cr-1033 2026-11-12（cr-1022 批1-4 + §六-5 B1-B3 定义归包全部收口——本档为后继接力入口）。
> 读者：接续 cr-1022 批 4 或后继工作的开发者（含新会话的 Agent）。

## 一、当前进度（2026-11-12 收口态）

| 批 | CR | 内容 | 验证 |
|---|---|---|---|
| 1 引擎 | cr-1027 done | mergeMenu 纯函数（三源并集/撞名护栏/requires 完备性 fail-loud/词汇白名单）+ 双区解析 readDualZoneBaseDoc + 三护栏单测 | 见 cr-log |
| 2 换轨 | cr-1028 done | shell.yml 双区化 v4（13 骨架 + 27 能力）+ host.yml packs 瘦身 v3 + 行词汇瘦身（tools/packs/bundle 退役）+ evaluate.ts 整删 + boot 菜单合成 + v3 菜单片段（定义 + src-fingerprint + 原子写 + .bak）+ rowTools 改注册面 fiber 归属反查 + tool-catalog 全 dump 生成（含 rows 段）+ parity 锁删除 + migrate v3 化 | 424 文件 / 3049 测试全绿 |
| 3 存量收口 | cr-1029 done（cr-1025 随之 done） | v3 唯一读面（旧形态 fail-loud 指路 migrate）+ 旧差量代码死透（桥/LEGACY 清单/v2 读写面全删，换算仅存于迁移脚本）+ migrate 对账自检 + boot 校准面（指纹漂移自动重写定义）+ 指纹足迹依赖闭包（workspaceClosureRoots + COMPANION_ROW_ROOTS，edit-core 级可见已实测） | 424/3041 全绿 + test:integration 12/89 + workspace/home 40+ 存量身份迁移对账全过 |
| 4 subagent 换轨 | cr-1032 done | spawn 词面换父壳活装配行集（bootShell 装配产物 `rowset.rows` 显式注入 subagent 行——词过滤与 materializeChild 定义拷贝同源；readCatalog 从 ac-shell-subagent 退役）+ 文档同步（本档 + menu-assembly 状态行） | 见 cr-log |

事实源：[menu-assembly.md](menu-assembly.md)（状态行已含三批）；裁决论据 [host-shell-decisions.md](host-shell-decisions.md)〈菜单合成原语与行词汇纪律〉；[agent-assembly.md](agent-assembly.md) 已标「被取代」。

## 二、未竟事项

### 批 4（cr-1032 done，2026-11-12 收口）

- subagent 换轨已落地：spawn 词面 = bootShell 装配产物 `rowset.rows`（活行集）显式注入 subagent 行——`filterSpawnTools` 词面与 `materializeChild` 定义拷贝同源；readCatalog 静态目录依赖从 ac-shell-subagent 退役。语义收紧：授予词须在父壳当次装配行集内（防父 config 后改漂移词击穿子壳断言）。
- 文档同步已落：menu-assembly 状态行；host-shell-row-manifest.md 行表核对（零行变更，无需回写）。

### §六-5 定义归包（cr-1033 done，2026-11-12 收口）

终态落地：shell.yml v5 只剩 13 骨架行；能力定义归 22 个能力包 package.json `ac.rows`（27 行——多行包 ac-shell-rows×5 / ac-web-tools×2）。要点：
- B1 立法 + 归包 + aggregatePackageRows 聚合器（词汇 id/description/requires；name 派生禁自写）+ 双源等价锁（B3 随窗口退役）；
- B2 换源：gen 聚合 + readCatalog 合并语义（骨架归基座/能力归 JSON 投影）+ 部署链随行物化 row-catalog.json——定义内容逐位等价，**src-fingerprint 零漂移**（预判的「整体漂移一次」未发生：指纹输入只有 id/name/requires，聚合产物与 yml 投影同串）；
- B3 收缩：shell.yml v5 单区、readDualZoneBaseDoc/dualZoneEntries 退役（v4 存量副本经部署链重物化收敛，直读 fail-loud 指路）、zone 变投影派生词（壳基座行→skeleton）——基线戳随基座文本变更全体换新（migrate --rebase 一次收敛：workspace/home 121 身份）。

### 遗留登记（不阻塞）

- writeAgentConfig 基线戳「既有戳赢」：编辑面复用须显式传 baseStamp（宿主 boot.ts 已正确传）。
- ac-import 仍产旧形态 config.json：导入路径归位 migrate 脚本或换轨，待裁决。
- §六-8 伴生行收口（fs-tools × file-snapshots 并包或转正）——独立立项。
- boot-graph.json 已入保留字清单（不进 settings/指纹）——T4-A 已修。

## 三、接力入口

- 关键源件：packages/ac-rowset-core/src/menu.ts（合成引擎 + 校准指纹）、packages/ac-agents-core/src/patch-doc.ts（v3 读写）、apps/shell/boot.ts（deriveAndAssertRowset / workspaceClosureRoots / rowTools 回填）、scripts/migrate-agent-patch.mjs（旧语义换算唯一居所 + 对账）。
- 验证命令（仓库根）：pnpm typecheck && pnpm test:unit && pnpm test:integration && pnpm check:deps；定向 npx eslint <改动目录>；收口 node scripts/cr.mjs check。
- 开发数据根 workspace/home 已全量迁移 v3（勿重复迁移——幂等但注意 baseStamp）。

## 四、坑（本会话实录）

- 文件编辑偶发 EIO 假阴性：报错但已落盘——重试前先 grep 验证现状，勿盲改。
- 并发 vitest 会撞 workspace/test 句柄（EPERM）：收口期一律串行跑；残留 detached 壳进程需精确 kill。
- 模板 config.json 手编易碎（本次 creator 曾被截头）：编辑前后用 ConvertFrom-Json 验证。
- 长字符串工具调用里内嵌反引号/裸换行会炸调用本身：用文件中转或 String.raw。
