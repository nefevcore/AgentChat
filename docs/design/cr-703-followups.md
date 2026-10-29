# cr-703 重组收尾清单（follow-ups）

> 基线：commit `a4282921`（cr-703 全仓重组已提交并 push）。
> 验证基线：`typecheck` / `webui:typecheck` / `check:deps` / `lint` 全绿；`test:unit` 305 文件 2322 用例、`test:integration` 12 文件 89 用例；`build:frontend → build:channels(29) → build:bundle` 成功；bundle 冒烟 23 行装配 / 29 通道 / HTTP 200。
> 性质：**待办清单，不是已完成记录**。每条给「证据 → 建议动作 → 验收」。P0 = 发版/正确性阻塞；P1 = 覆盖面或可用性缺口；P2 = 卫生与文档。
> 登记：cr-703 主体 + cr-704（归档 tag 裁决）。
>
> **当前状态（2026-10-27 复核，cr-726 文档审查批）**：以下「收尾进度」是 cr-705/706 时点记录；经 cr-707…724 对拍，已兑现项以正文条目标注的 ✅ 与 CR 号为准，**1.3、3.11、3.12 仍开放**（1.3 与 3.12 为同一件事）。审查依据见 Note 归档根 `docs-review-2026-10-27/findings-F-misc.md`。
>
> **收尾进度（cr-705/706，2026-10-26）**：1.1 ✅（连续两轮 test:unit 2322×2 绿 + 无残留壳）；1.2 ✅（scripts/e2e-bundle.mjs 全链通——并抓到壳 bundle CLI 门恒假真 bug 已修；挂进 preflight 第 7 步）；1.3 ⏸（按用户指示留本地验证）；2.1 ✅ 两个结构锁（apps/ui/tests/row-client-default-export + contrast-tokens，人为回归红验证过）；完整 coverage 审计 ✅——报告 `sandbox/coverage-audit-cr703.md`（138 件：PORT 94 / COVERED 13 / DROP 31，P1 9 项清单见报告 §PORT——首位两项即本批已补的结构锁，其余 92 项为后续批次工作量）；2.2 ✅ 删除 loopback-host（保留 client）；2.3 ✅ 双份 + 文件头互注 + supervisor-parity.test.ts 回归锁；2.4 ✅（Unreleased 无 webui/tests + cr-703/705/706 条目）；2.5 ✅ 删除备份（比对无差异）；3.1 ✅（ac-config/ac-harness-tools 原子写重试+诊断）；3.2 ✅ 改判保留（ac-workspace 经模块增强隐式消费——判死回滚，纪律注记在 CHANGELOG）；3.3 ✅；3.5 ✅（2400+）；3.6 ✅；3.8 ✅ 本地态注记；3.10 ✅。3.4/3.7 维持现状（已知项）。

## 0. 摘要（建议先做这三件）

1. **修连续跑测试的 EPERM**（detached 壳占住 `workspace/test`，第二次跑必挂 global setup）。
2. **补 bundle 全链 e2e**（现在只验证了宿主 HTTP 面，壳 spawn 链未从 dist 跑过）。
3. **跑一次发布预检 + CI 验证**（workflow 只由 tag/manual 触发，main push 不验证）。

> **已裁决（cr-704）：preview 不设归档 tag。** `preview-final` 是 2026-10-26 16:53 由本批开工会话创建的**轻量标签**（无 tagger 元数据，从未推送），现已删除。preview 末态即提交 `3943f5aa`（`a4282921` 的父提交，仍在 main 历史里），不额外占 git tag 命名空间。

---

## 1. P0：发版与正确性阻塞

### 1.1 连续跑测试会因残留壳 EPERM 失败（✅ 已兑现：cr-705）

- **现象**：第一次 `pnpm test:unit` 绿；紧接着第二次会在 `scripts/vitest-global-setup.mjs:36` 的 `rmSync(workspace/test)` 报 `EPERM`，随后 `No test files found`。实测两次复现。
- **根因**：`apps/host/boot.ts:305` 的 `close()` 只调 `supervisors.close()`；而 `apps/host/supervise.ts:114` 的 `stop()` 语义是「停监护循环、**不杀壳**」（detached / host-revive 设计）。`apps/host/tests/e2e-admin-preview.test.ts` 的 `afterEach` 只 `host.close()`，其拉起的壳继续持有 `workspace/test/wN/sandbox/...` 文件句柄。
- **证据**：残留进程命令行形如 `node … apps/shell/boot.ts --data-root …\\workspace\\test\\w8\\sandbox\\e2e-admin-preview-…`（两个，父 vitest worker 已退）。
- **建议（按优先级）**：
  1. e2e teardown 显式收割：`for (const h of host.supervisors.handles()) { await h.shutdown(); h.kill(); }`（`OrchestratorHandle` 已暴露 `handles()`）。
  2. 或把 host e2e 的数据根移出 `workspace/test`（例如 `sandbox/test-home-<pid>`，符合数据根隔离红线），使 global setup 的清理面与壳句柄解耦。
  3. global setup 增加「失败前诊断 + 有界重试」：打印占用进程/路径，避免只给 `EPERM` 悬案。
- **验收**：连续两次 `pnpm test:unit` 均绿；退出后无残留 `apps/shell/boot.ts` 进程。

### 1.2 bundle 全链 e2e 缺失（✅ 已兑现：cr-705 脚本 + cr-706 壳 bundle CLI 门修复）

- **现状**：已验证 `dist/agentchat.mjs` 启动、静态面 200、23 行装配、29 通道播种；**未验证**从 bundle 派生壳（`dist/shell.mjs`）、投递信封、账本收束。
- **原因**：cr-702 的 bundle 探针原本住 `preview/sandbox/`（未跟踪），本批已随 preview 删除。
- **动作**：新增 `scripts/e2e-bundle.mjs`（或 `sandbox/` 下脚本后收编）：隔离 `AGENTCHAT_DATA_ROOT` → 起 `dist/agentchat.mjs --mock-provider` → 建 Agent → user 发一条消息 → 断言壳 boot.ready / 账本终稿 / 进程可退。挂进 `release-preflight` 的 bundle 步之后。
- **验收**：一条命令在干净 `dist/` 上跑通；失败时非零退出并保留数据根现场。

### 1.3 CI 未验证，发布预检未跑（⏸ 仍开放：cr-705 只修了 `--clean` 扫描 bug，无实跑/CI 绿记录）

- **证据**：`.github/workflows/{publish,desktop,mobile}.yml` 触发条件均为 tag push / `workflow_dispatch`；本次只 push 了 main。`pnpm release:preflight`（含 `--clean` / `--wsl`）未执行。
- **动作**：发布前跑 `pnpm release:preflight --clean`（Windows 干净档）+ `--wsl`（Linux 大小写敏感档）；CI 用 `workflow_dispatch` 空跑或下一个 tag 验证。注意 `publish` 手动触发可能真的发 npm，先确认 workflow 的 manual 语义。
- **验收**：预检三档绿；三 workflow 至少各绿一次。

---

## 2. P1：覆盖面与可用性缺口

### 2.1 `src/webui` 淘汰带走了 138 个测试文件，部分回归锁无等价物（◐ 两个结构锁已补：cr-706 / cr-708；92 项 P1 余量未立项）

- **事实**：`preview-final` 的 `src/webui/tests/` 有 138 个文件；当前 `apps/ui/tests/` 5 个、`packages/ac-client-ui-*/tests/` 95 个。大部分旧测试针对已退役的 src/webui 运行时（重复实现），随批 C 删除是预期；但下列**锁的是仍然存在的包/资产**，建议逐条判定是否补回：
  - `row-client-default-export.test.ts`：跨 31 个 `ac-client-ui-*/client/index.ts` 断言 `export default`（boot graph 动态装载面）。当前 `apps/ui/tests/channels-domain.test.ts:50` 只断言 **channel 包装层**的 default，不断言被包装包本身的 default。
  - `contrast-tokens.test.ts`：kit 令牌对比度；现只有 `packages/ac-webui-core/tests/token-vocab.test.ts`（词汇完备性，不含比值）。
  - `csp-audit.test.ts`、`kit-datepicker/select-z/tooltip.test.ts`、`token-gauge.test.ts`、`toast.test.ts`、`tokens.test.ts`：kit/入口行为锁，需对当前 `apps/ui` + `packages/ac-webui-kit` 现状重新判定。
- **动作**：优先补 2 个跨包结构锁（row-client default export、kit 对比度），其余按「是否仍能红」筛选，不复刻过时运行时用例。
- **验收**：补回的用例在人为回归（删 default / 改坏对比度）时确实变红。

### 2.2 `scripts/remote-loopback-host.ts` 已失效（✅ 已兑现：cr-708 删除，保留 client）

- **证据**：`scripts/remote-loopback-host.ts:7` `import { bootTree } from '../packages/ac-app/src/index.ts'`；`ac-app` 自 cr-696 已不存在，脚本自那时起不可运行（非本批回归）。
- **动作（二选一）**：
  1. 移植到 `apps/host/boot.ts` 的 `bootHost`。注意 `HostBootOptions` 目前没有逐行 config 注入口；`ac-remote-link` 的 `relayUrl` 走 `Config`/settings，可先在数据根写 `config.json.remoteLink.relayUrl` 再 boot，或给 `bootHost` 增 `rowOptions` seam（后者更通用，需设计裁决）。
  2. 判定无消费者后删除（与 cutover 三脚本同处置），保留 `scripts/remote-loopback-client.ts` 作为对已部署 relay 的客户端探针。
- **验收**：脚本能一条命令起本地 loopback 宿主并打印 READY；或干净删除且无引用。

### 2.3 两个 supervisor 并存（✅ 已兑现：cr-708 双份 + 文件头互注 + parity 回归锁）

- **现状**：根 `supervisor.mjs`（产品入口：品牌 exe 自重 exec、读 `AGENTCHAT_DATA_ROOT`、缺省 `workspace/home`、42/78/0 + 退避熔断）与 `apps/host/supervisor.mjs`（沙箱入口：缺省 `sandbox/supervised-home`、不读 env、tee 宿主日志）策略同源、外壳分化。
- **风险**：监护策略/退出码修改要改两处；`apps/host/tests/supervise.test.ts` 只覆盖后者。
- **动作（二选一）**：
  1. 合并为一个脚本 + `--sandbox`/`--tee-logs` 开关（两入口路径壳都薄）。
  2. 保留双份，但在两文件头写明「产品 vs 测试沙箱」归属，并加一条测试锁「两份的 `ac-supervisor-core` 导入策略一致」。
- **验收**：策略改一处即两入口生效（方案 1），或职责/差异有注释 + 回归锁（方案 2）。

### 2.4 CHANGELOG 的 `[Unreleased]` 仍指向已删除的测试路径（✅ 已兑现：cr-706 路径修正 + cr-703 条目）

- **证据**：`CHANGELOG.md` 的 `[Unreleased]` 条款引用 `webui/tests/boot-graph.integration.test.ts` 与 `webui/tests/row-client-default-export.test.ts`；这两处已随 `src/webui` 删除。且本批 cr-703 尚无 CHANGELOG 条目。
- **动作**：把路径改成现行的 `apps/ui/tests/boot.test.ts` 等（或在 §2.1 补回后指向新路径）；补一条 cr-703 变更摘要。
- **验收**：`[Unreleased]` 段内不再出现 `webui/tests`（历史版本段保持原样，不改写历史）；`[Unreleased]` 含 cr-703。

### 2.5 preview 数据备份待处置（✅ 已兑现：cr-708 删除，802MB 比对无差异）

- **现状**：`sandbox/backup-2026-10-26-from-preview/`（38 个 agent 目录，真实数据根备份；本批从 `preview/sandbox/backup-2026-10-26` 移出，未删）。
- **动作**：确认与 `workspace/home` 的差异后，二选一：外置归档到 `Dev\\Note\\AgentChat` 或删除。不要留在 `sandbox/`（会被误当临时数据清掉）。
- **验收**：处置记录写进本条或下一条 CHANGELOG/CR。

---

## 3. P2：卫生与文档

| # | 项 | 状态（2026-10-27 复核） | 证据 / 位置 | 建议 |
|---|---|---|---|---|
| 3.1 | Windows 原子写静默失败 | ✅ cr-708（重试 + 诊断） | `packages/ac-config/src/service.ts`（`renameSync` 包在 catch 里）、`packages/ac-harness-tools/src/sessions.ts`（`recordSession` 同样静默）；合并套件后 19 路并发出过两次 `EPERM`，已用 `maxWorkers: 8` 压住 | 抽一个带重试 + 失败告警的 `atomicWrite`（至少别静默）；随后可评估恢复并发 |
| 3.2 | `ac-retired-types` 名实不符 | ✅ cr-708（判死回滚，改判保留） | `packages/ac-retired-types/src/index.ts`；无 `package.json`，靠根 tsconfig include 闭合，是当前类型的活件 | 改名 `ac-compat-types`（或补 package.json 但保持纯类型）；改名需同步根 tsconfig 与注释 |
| 3.3 | 文档断链 2 处 | ✅ cr-708 | `docs/design/archive/message-pipeline-analysis.md` → `message-pipeline-graph.html`（应 `../`）；`docs/design/archive/webui-component-tree.md` → `ui-rows-and-slots.md`（应 `../`） | 两个相对路径各加 `../` |
| 3.4 | vendor README 断链 4 处 | 已知项（上游副本，维持） | `packages/vendor/cordis/README.md` 指向上游 `docs/` | 上游副本，保持原样即可（记录为已知） |
| 3.5 | README 测试徽章偏大 | ✅ cr-708（2400+） | `README.md` 写 `tests-2500%2B`；实际 2322 + 89 = 2411 | 改 `2400%2B` 或用真实数 |
| 3.6 | 残留 `ac-app` / `cordis.yml` 注释 | ✅ cr-708（注释改口径） | `apps/ui/client/boot.ts`、`desktop/main.mjs`、`packages/ac-durable-interaction/src/service.ts`、`packages/ac-event-policy/src/service.ts`、`packages/ac-shell-tools/src/executor.ts`（均为注释） | 顺手改为 `apps/host` / `row-catalog` 口径 |
| 3.7 | 根 `cordis.yml` 被跟踪且运行时重写 | ⏸ 已知项（保留跟踪） | `cordis.yml`（当前恒 `[]`，启动会重写） | 决定：保持跟踪（当前无 diff）或与 `/cordis.patch.yml` 一并 gitignore |
| 3.8 | 技能改动不入库 | ✅ cr-708（本地态注记） | `.gitignore:/.dsh/` 使 `.dsh/skills/agentchat-dev` 的本次路径/事实源更新只在本地 | 若技能应随仓库分发，需改忽略策略；否则在 README/技能注记「本地态」 |
| 3.9 | `docs/cutover` 无 cr-703 收口行 | ◐ 已由 `docs/README.md` 冻结标注代偿 | `docs/cutover/plan.md` 冻结于 preview 期 | 可按「只读历史」保持；若需要，只在 `docs/README.md` 注明冻结 |
| 3.10 | workflow 注释仍写 preview | ✅ cr-708 | `.github/workflows/desktop.yml:12` 等（仅注释） | 顺手改 `apps/ui dist` |
| 3.11 | `pnpm test` 单次全量未跑 | ⏸ 开放（未见实跑留档） | 本批 unit/integration 分跑（等价），未跑一次 `all` 档 | 发版前跑一次 `pnpm test` 留档 |
| 3.12 | `release:preflight` 未跑 | ⏸ 开放（同 1.3） | 同 1.3 | 见 1.3 |

---

## 4. 需要你裁决的决策点

1. **e2e 壳清理策略**：teardown 收割 vs 数据根移出 `workspace/test`（建议两者都做，先做数据根隔离）。
2. **两个 supervisor**：合并还是双份 + 注释/回归锁。
3. **`remote-loopback-host.ts`**：移植（是否给 `bootHost` 加 `rowOptions`）还是删除。
4. **`src/webui` 测试**：只补 2 个结构锁，还是做一次完整 coverage 差额审计。
5. **preview 备份**：外置归档还是删除。
6. **`.dsh` 技能**：继续本地态，还是纳入版本控制。

## 5. 建议执行顺序

```text
第 1 天  1.1 测试 EPERM → 2.4 CHANGELOG
第 2 天  1.2 bundle e2e → 1.3 release:preflight（--clean / --wsl）
第 3 天  2.1 两个结构锁 → 2.2 loopback 宿主 → 2.3 supervisor 裁决
随后     2.5 备份处置 + §3 卫生项（可攒一个 docs/cleanup 小批）
```

## 附：核验命令

```powershell
pnpm test:unit; pnpm test:unit                               # 1.1 连跑两次
pnpm release:preflight --clean                               # 1.3
Select-String -Path CHANGELOG.md -Pattern 'webui/tests' | Select-Object -First 5   # 2.4 看 Unreleased 段
npx vitest run packages/ac-client-ui-renderer/tests          # 2.1 现状覆盖抽样
```
