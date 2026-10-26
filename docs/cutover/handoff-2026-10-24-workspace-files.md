# 交接：工作区文件面（cr-676，2026-10-24 夜）

> 下一个会话入口。先读本文，再读 `plan.md` §5 的 cr-676 行。
> 代码改动全部**未提交**（沿用 G8 分批入库惯例）。

## 0. 一句话现状

**已修完并活体验证通过**：preview 全量 **634/634 绿**、typecheck 0 新增、定向 lint 0；
产品宿主（3830 / `workspace/home`）四端点实测全绿。前端面板（树点击 → 预览 → 附件上传）归用户浏览器复验。
改动**未提交**（G8 分批入库惯例）。

## 1. 改了什么

| 文件 | 内容 |
|---|---|
| `preview/packages/ac-host-rows/src/workspace-files.ts`（新） | 工作区文件面纯函数（零 cordis）：`workspaceTree` / `readWorkspaceFile` / `resolveWorkspaceFile` / `saveWorkspaceUpload` / `workspaceTreeBase` / `agentWorkdirOf` / `conversationWorkspaceRoot` / `conversationAgentId` / `guessContentType` |
| `preview/packages/ac-host-rows/src/index.ts` | 导出面上收 |
| `preview/packages/ac-host-webui/src/web-api.ts` | `GET /api/workspace/tree|file|raw` + `POST /api/upload`（主线 ac-workspace 同形：400/404/304 与载荷形状） |
| `preview/packages/ac-host-webui/src/face-ops.ts` | 删自持 `workspaceRootOf`（并源）；`workspace/open-dir` 补 workspaceId/会话树基准 |
| `preview/packages/ac-host-rows/package.json` + `pnpm-lock.yaml` | 新增 `ac-sandbox-core` 依赖（包含判定单源） |
| 测试 ×2 | `ac-host-rows/tests/workspace-files.test.ts`（7 例）/ `ac-host-webui/tests/web-api-workspace-files.test.ts`（4 例） |

## 2. 语义要点（与主线对齐，勿走散）

- 树基准三级：会话挂载工作区（`session.json.workspaceId` → `workspaces.json`）> Agent 级基准（`settings['security'].workdir` > `files/<id>`；预设/虚拟/未注册 = 数据根）> 数据根。
- dotfile 过滤只作用于数据根基准；外挂工作区/Agent 空间如实列。
- 读面两段：数据根快路径（无 context 时保持「不存在/越界照抛原错误」）→ 工作区基准推导（含 `../` 包含判定，耗尽后统一「文件不存在或不可读」）。
- raw：ETag `"wf-<size>-<mtimeMs>"` + `no-cache`，命中即 304。
- 上传：`files/<bucket>/_tmp/<sha1-12><ext>`，同内容幂等；bucket = agentId ?? session.json.agentId ?? `shared`（预设 Agent 用自己的桶，与主线 `bucket = owner ?? shared` 一致）。

## 3. 本地环境事故（已由用户 `pnpm install` 修复）

`pnpm install`（为写锁文件）撞运行中进程占用 `node_modules/.pnpm`，中途失败：
摘空根 `node_modules/.bin`（已重建——`sandbox/repair-node-bin.mjs`，10 个垫片：vitest/tsc/eslint/tsx/…）
与 ~80 个 `.pnpm` 包目录（108 条断链，构建/测试链为主：`@babel/parser`、`@jridgewell/sourcemap-codec`、`@hono/node-server`、`@floating-ui/dom`、`@eslint-community/regexpp` …）。
本地 pnpm store 是空的（8KB）→ 修复必须联网完整 `pnpm install`；`.modules.yaml` 也被删，pnpm 会走全量重建（正确行为）。

**用户裁决 = 自己关掉 AgentChat 后手工 `pnpm install`**（选项 B）——已完成：
`.modules.yaml` 回来了、递归扫描仅剩 1 条无害陈旧链接（`node_modules/.pnpm/node_modules/ac-shell-loop`，该包在 preview 中不存在）。
急救脚本留档 `sandbox/repair-node-bin.mjs`（pnpm 因占用摘空根 `.bin` 时按 package.json bin 字段重建）。

## 4. 验证记录（全部已跑）

| 项 | 结果 |
|---|---|
| `pnpm preview:typecheck` | cr-676 触及文件 0 错（仓内另有 14 条 WIP 错属别的批次，未动） |
| 定向 vitest（ac-host-rows + ac-host-webui） | 129/129 绿（含 +11 新用例） |
| **全量 `preview:test`** | **634/634 绿**（`--reporter=json --outputFile=preview/sandbox/test-report-676.json`；管道会挂） |
| 定向 lint（6 改动文件） | 0 problem |
| 宿主活体 tree | 无参 = 数据根；`?agentId=neko` = `files/neko`；`?conversationId=00829614…` = 登记工作区根（`.dsh`/`.git` 如实入树）；越界 400 / 缺参 400 |
| 宿主活体 file/raw | `file` 200 文本载荷；`raw` 200 + `ETag "wf-1570-…"` + `no-cache` → If-None-Match **304 零字节**；缺失 404 |
| 宿主活体 upload | `agentId=neko` → `files/neko/_tmp/<sha1-12>.txt`；同内容幂等（同 storedName）；上传引用形经 file/raw 双面回读一致；无 file = 400 |

**全量首跑暴露的两处失败已一并断根**（同一 CR）：

1. `apps/host/tests/boot.test.ts` 的 `workspace/open-dir` 断言：旧断言期待「未知 agentId → 不存在」，
   与主线 `resolveOpenDir` 语义不符（未知 agentId 走 treeBase 落数据根）。cr-676 让 open-dir 接上单源后暴露 →
   断言改写为「workspaceId 未登记 = 工作区不存在」（且不再触发真开资源管理器）。
2. `ac-host-rows/src/workspaces.ts` 原子写 `fs.renameSync` 实测 EPERM flake（Windows 瞬时占用）→
   并源到全仓唯一收敛点 `ac-plugin-core/fsx.renameWithRetry`（退避重试 10 次）。

## 4.1 仍需人工复验

- 浏览器侧：工作区面板树展开 → 点文件出预览（markdown/图片）→ 输入框附件上传（落 `files/<agent>/_tmp/`）。

## 5. 遗留（不在本批）

- `preview/packages/ac-shell-rows/src/shims.ts` 的 `WorkspaceShim.conversationWorkspaceRoot` 仍是壳侧第二份（壳不依赖宿主行包，暂不合并）——若后续出现第三份，考虑上收纯库。
- `workspace/open-local` 仍按「绝对路径直用 / 数据根相对」定位，未接读面基准推导（与本批解耦）。
