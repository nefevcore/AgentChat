# 缺口活清单（gap-backlog）

> 性质：本仓唯一活的缺口/待办清单——开放项 + 来源追踪。基线 = 2026-09-29 全仓代码注释/文档字面搜索「缺口」（47 处：src 40 + mobile 5 + CHANGELOG 2）核实成文（cr-23）；2026-10-06 治理批（cr-269 组）合并 polish-backlog / run-code-hardening-backlog / run-code-usage-profile-2026-09-20 / dsh-0.2-contract-takeaways-plan 的开放项，四档完成态迁 `archive/`（完成态原档不再维护）。
> 排除范围：`sandbox/`（Agent 沙箱：临时工作区/测试数据根/工具链）、`workspace/`（会话数据落盘）。
> 状态标记：☐ 开放待修 / ◐ 部分完成 / ☑ 已闭环（留档）。
> **日期纠偏（2026-10-06）**：本档首版头部原记「来源：2026-10-14」，与三处实证互斥——① cr-log `cr-23`（2026-09-29）记载该 47 处搜索并形成本清单；② 文内「2026-10-05 复核」早于 10-14；③ 本档文件创建于 2026-09-28、末次提交 361ce14a（2026-10-05）。故真实来源日 = 2026-09-28/29，「2026-10-14」系笔误（疑月份错记）。同理 `archive/run-code-hardening-backlog.md` 与 `archive/run-code-usage-profile-2026-09-20.md` 头部「2026-11-19」晚于其落盘提交 47d01ce4（2026-09-21），真实时间线 = 2026-09-19～09-21——证据与判定见 `sandbox/docs-rewrite/group-backlog.md`。
> 维护约定：每修一项把对应条目改 ☑ 并注明 cr 号与真实日历日；来源档案已冻结于 `archive/`，勿改档案原文、勿按档案行号对拍当前代码。

## 一、开放缺口（按域分组，组内按建议修复顺序）

### A. 安全与会话

1. ☐ **按 source 降档——Agent 间唆使链路无硬边界**〔安全〕
   - 出处：`archive/security-access-tier-plan.md` L55 / L292 / L416 / L448（该文档 §十 明确「延期」）；原 gap 第 2 项。
   - 内容：full 档 Agent 被 source='agent' 消息触发的 run 应降档执行——当前只有 prompt 级软缓解（run 边界注入防御提示词），无硬边界；系统整体强度 = 可达 Agent 最高档；`send_agent` 无 requiredTags，任何 Agent 可联系任何 Agent。
   - 现状核实（2026-10-06）：全仓 grep「降档」仅命中「继承不降档」族（`ac-conv-settings/src/contract.ts` L15、`ac-conversation/src/service.ts` L402 + elev-inherit/conversation 集成用例）——那是提权水位继承语义（2026-09-12 反馈修正：降档会使唤醒轮逐工具弹审批卡），与按 source 降档无关；本项未实现。
   - seam 现成：`router/before-deliver` / `loop/before-run`。
   - 注意：`security-access-tier-plan.md` §8.3 表中「prompt 级防御可被话术绕过」为显式接受项，非本条待修。

2. ☐ **机制 run steer 拦截全类型覆盖审计**（2026-10-06 复核：设置面已核完，收窄为维护约定，可在下次 review 关闭）
   - 出处：`ac-archive/tests/archive.integration.test.ts` L521（回归锁定）+ `ac-client-ui-conversation/client/feed-core.ts` L187（认知缺口留档）；原 gap 第 4 项。
   - 事实（2026-10-06 逐点核实）：拦截判定单源 = `isArchiveReviewRun(meta)`（`ac-agent-loop/src/service.ts` L171）；设置面全仓仅两处——`ac-archive/src/service.ts` L407-409 与 `ac-bench/src/service.ts` L170-172（均 `meta: { [ARCHIVE_REVIEW_META]: true }`）；两门 = `ac-conversation/src/service.ts` L465（deliver steer 门）与 L649（steerQueued 门）。
   - 其余 `source: 'event'` 调用点（ac-ask-questions L154/L174、ac-goal L235、ac-job-wakeup L98、ac-collab-tools L98、ac-dev-tools L246）均为「事件触发的普通 run」——回复落盘，steer 不会进黑洞，无需同款拦截。
   - 动作：无代码缺口；维护约定 = 新增「不落盘机制 run」时必须设 ARCHIVE_REVIEW_META（否则两门失效、用户消息注入即"回复掉黑洞"）。

### B. run_code / DX

3. ☐ **模板串转义税——传输层根治未做**（方向一重量部分 + 方向三）
   - 出处：原 gap 第 6 项；`archive/run-code-hardening-backlog.md` 立项②；`archive/run-code-usage-profile-2026-09-20.md`（09-20 ②号线索与 11-19 追记）。
   - 已落地（2026-09-21）：SDK 投影 DEFAULT_GUIDANCE「字符串书写纪律」行 + worker 擦除失败针对性提示 `hintSyntaxRecovery`（`ac-run-code/src/worker.ts` L191 / L278 / L442）。
   - 未做：方向一重量部分（消除模板串在传输层的形状假设）+ 方向三（edit 的 old_string/new_string 允许引用「外部文件片段」路径，复杂编辑不走程序体内嵌字符串）。
   - 关联事故：worker 死锁事故连锁因素②（`archive/run-code-hardening-backlog.md` 事故实录）。

4. ☐ **读结果分层（收束行 steps + subcalls.jsonl 读结果全文）**
   - 出处：`archive/run-code-usage-profile-2026-09-20.md` 优化线索 ①④（两轮画像同构实证：前支 425KB 收束行 / subcalls 1898KB；后支 messages 1384KB / 21 行、subcalls 1416KB ≈ messages）。
   - 动作：单独立项权衡——steps 按工具类分层（写操作全量、读操作 result 降为摘要/偏移）、归档压缩或 UI 投影按需加载；动 KV 前缀回放语义，非纯收益。

5. ☐ **dev worker 坏态全链路手动验收**
   - 出处：`archive/run-code-hardening-backlog.md` 立项① 遗留项。自动化已落地（2026-09-21）：`ac-run-code/src/tool.ts` L456/L468/L753（bootDegraded 告警 + 引导链三级候选 + 快照回退）、`ac-run-code/src/protocol.ts` L16（PROTOCOL_VERSION 版本闸）、测试钩子 `__runCodeTestHooks`。
   - 动作：手动改坏 worker.ts（删一行）→ 期望 run_code 自动回退快照并在结果里告警、工具面不停摆。

### C. 前端 / UI

6. ☐ **UI 全量浏览器走查**（原 polish C1）
   - 内容：插件卡片（红绿 toggle / ⚙ 徽章 / 点击弹窗 / 滚动收口）、工具参数表格、事件树、配置弹窗分区（字段描述 / enabled 分区）、还原按钮组——全部经事故链阻隔未经目验（单测/构建已过），需人工浏览器目验。

7. ☐ **事件树手感**（原 polish C2）
   - 内容：默认收拢是否合适、展开状态记忆（localStorage）、scope 根计数徽章信息量——产品手感决策，暂维持现状（scope 根展开 / 事件收拢）。

### D. 移动端

8. ☐ **真机 WebView 兼容缺口残余**
   - 出处：原 gap 第 5 项；核验清单 `archive/m3-realdevice-checklist.md` §1.1。
   - 现状核实（2026-10-06）：三份同源副本在档——`mobile/app/www/legacy-runtime.js`、`mobile/app/android/app/src/main/assets/public/legacy-runtime.js`、`src/webui/public/legacy-runtime.js`（另 `src/webui/dist/` 与 android `build/intermediates/` 下两份为构建产物）。
   - 动作：对目标真机 WebView 版本跑清单核验；对照 MDN/Chrome 状态更新垫片覆盖面（如 `Object.hasOwn`、`structuredClone`、`Array.prototype.at` 等按真机版本裁剪）。

### E. 架构演进与缓行（原 polish §三 + DSH 比对增量）

9. ☐ **A2 `agentchat.contracts: "^1"`**：声明位已留，等市场/版本门工作启用（勿提前加投机字段）。
10. ☐ **A3 npm 发布行包 + 市场打通**：`keywords: "agentchat"` / `agentchat.plugin: true` 已就位；发布与 `market/search` 消费是下一步。
11. ☐ **A5 dep-graph 软依赖盲区**：`ctx.get` 依赖不在图内（已文档化；补齐需静态分析，代价高收益低）。
12. ☐ **A6 ac-web-api 静态 inject 瘦身**（17 项）：级联易碎根源；非核心 inject 改 `ctx.get` 软依赖（RPC 失败容忍）或拆面。改动面大，需单独立项。
13. ☐ **A7 group 配置簇事件并源（缓行）**：created/deleted/renamed/description-set/member-added/member-removed 六事件订阅面完全重合（后端仅 ws-bridge；载荷已统一携带 GroupConfig 终值），可并为 `group/updated(group, action)`。缓行理由 = 前端按 type 分两个刷新作用域（列表态 vs 详情态），合并需前端改按 action 分流。触发条件 = 第三处同形态域出现，或前端群视图重构时顺手并源。
14. ☐ **ac-config 热更三小件**（DSH 0.2 契约比对增量；2026-10-06 逐条核实：三件均未做）
    - **P1 `config/changed` 载荷携带变更路径**：现状 = 单参文件路径（`ac-config/src/events.ts` L18；`service.ts` L88/L96 emit 只传 file），订阅方（ac-agent-presets refreshModels / ac-event-policy 等）一律全量重查。目标 = emit 增可选第二参（变更路径数组，对齐 DSH `loader/volatile-update` 语义）；`set(key)` 单键路径天然已知，`merge`/`reload` 需 diff。
    - **P2 commit 前深等价去重**：现状 = `commit()` 直写盘直 emit（`service.ts` L93-97），`set()` 同值也原子写盘 + 唤醒订阅方。目标 = 入口深等价判断，无实质变化直接返回。开放决策点 = `reload()` 内容等价时是否去重 emit、返回值 true/false 语义是否随之调整（实施时定夺并写测试锁定）。
    - **P3（候选）快照深冻结替代 structuredClone**：现状 = `all()`/`get()` 仍 `structuredClone`（`service.ts` L39/L48），消费方误改自己那份副本被静默丢弃（弱 fail-loud）。前置 = 全仓审计 `ctx.config.get(` / `.all(` 返回值有 mutate 的调用点（行为变更非纯收窄）；零 mutate 才可直接换。
    - 落点/验证阶梯/原则记档：`archive/dsh-0.2-contract-takeaways-plan.md`（§3 记档见本档 §三）。

## 二、已闭环留档（不再领；原档全文在 `archive/` 或 git 历史）

- **原 gap 第 1 项** 协议多态（cr-39：三协议纯库 + 池条目 protocol 分发）——2026-10-01 复核核销。**原 gap 第 3 项** `/models` 真代理（`llm/models` RPC + AgentPane 自动读取）——2026-10-05 复核核销。文档滞后表 A/B/C 三行同批核销（cr-267）。
- **polish**：§一 P1–P12 全部完成；§二 C3（孤儿 CSS）/ C4（PluginMeta 死接口）/ C5（市场空态引导）/ C6（目录扩至 18 条）/ C8①②（死组件清理 + 行语言收敛）——均 2026-08-30 打磨轮。
- **polish C8③ 徽章族**——2026-10-02 cr-128（webui 重构 P4「browser+usage+system 徽章归 ui-badge」）已消化：本次核实全仓无 `.plugin-state-badge` / `.perm-badge` / `.load-badge` 定义（仅 `webui/design/gallery.html` 存迁移注记），徽章语言单源 = `ui/badge.css` `.ui-badge` 族。
- **polish C7 ws-bridge 描述模板**——描述已携带事件名（`ac-ws-bridge/src/index.ts` L86 模板），叠加 A1 注册制目录（行入口自述 `extension.listeners`，2026-08-31 落地）后不再存在「同款模板文案」问题。
- **polish A1** 注册制目录（2026-08-31 落地，静态 EXTENSION_CATALOG 退役）；**A4** 生产 bundle 内置组为空为既定缩水 → 见 §三 边界备忘。
- **run_code 三立项**（`archive/run-code-hardening-backlog.md`）：① worker 防退化护栏（含后续 bundle 候选回归修复）、② 转义税轻量部分、③ lib 注册表自愈——均 2026-09-21 落地（run-code 集成 62/62、projection 9/9）。
- **run_code 画像线索**（`archive/run-code-usage-profile-2026-09-20.md`）：Ⓐ pwsh failure_class 分类、Ⓑ edit 行尾归一化 + 失配诊断、Ⓒ grep 转义建议、追记Ⓐ lib.define 非源码即时诊断、追记Ⓑ load_skill 注入型语义标注、lib 直调糖、自由变量告警——均 2026-09-21 落地。
- **原 gap 附录剔除的闭环项**：m32 白屏四处、m28 UI 插件树三个 P0、地图 §3.4 工具行五件套（突变队列/预算截断/遍历统一/str_replace 串行/text-budget）、M3.x 真机系列（X25519/LoopbackBridge/deviceId 信令/loopback 绕过）、ac-subagent journal append 失败窗口、ac-workspace M11、ac-web-api 映射、ac-app bootDist 迁移、feed-core 历史对账、webui 可见性恢复。
  - 日期存疑备注：原档给 m28 收口标称「2026-11-08」，晚于今日（2026-10-06）且 cr-log 无该日期条目（`archive/README.md`、`archive/m28-*.md` 同源标称）——按「原档标称、真实日期未可考」留档，勿据此排期；日期纠偏属母任务收口范围。

## 三、边界备忘（勿顺手恢复）

- M24/M25 缩水红线：监听器优先度/重排、**单监听器粒度治理**、capabilities 减法、签名形态统一、治理面按 Agent 细分（归 agentGate facet）。
- 停用 ac-web-server = UI 无法自救（传输本体），手工编辑 `cordis.patch.yml` 是设计兜底。
- `workspace/default` 是 src 旧轨数据，preview 迁移脚本不得触碰。
- A4：生产 bundle 内置组为空（既定缩水），由 market + 声明判据接管。
- `security-access-tier-plan.md` §8.3「prompt 级防御可被话术绕过」= 显式接受项（非待修）。
- **机制不搬（DSH 比对记档，原档 §3 全文保留在 `archive/dsh-0.2-contract-takeaways-plan.md`）**：`Volatile<T>` 原地提交 / schema 投影表单 / bundle + pnpm workspace 分发与 peer 门禁 / 分层持久化 + 高层覆盖写拒绝——不搬原因与「将来真成痛点时的现成答案」见档案 §3，勿按 DSH 形态改造本仓。

## 四、来源追踪（2026-10-06 组治理合并映射）

| 来源档案 | 处置 | 活清单落点 |
|---|---|---|
| `polish-backlog.md`（2026-08-30 打磨轮基线） | 归档 `archive/polish-backlog.md`（冻结） | C1→§一 6；C2→§一 7；A2–A7→§一 9–13；§四 边界备忘→§三；完成态→§二 |
| `run-code-hardening-backlog.md`（2026-09-19～09-21 会话） | 归档 `archive/run-code-hardening-backlog.md`（事故实录独立保留，未压缩） | 立项②残余→§一 3；立项①遗留验收→§一 5；立项①②③ 落地→§二；事故→档案 |
| `run-code-usage-profile-2026-09-20.md`（纯快照） | 归档 `archive/run-code-usage-profile-2026-09-20.md`（冻结，数据不复核） | ①④→§一 4；②方向三→§一 3；Ⓐ/Ⓑ/Ⓒ 落地→§二 |
| `dsh-0.2-contract-takeaways-plan.md`（2026-10-01 比对） | 归档 `archive/dsh-0.2-contract-takeaways-plan.md`（冻结） | P1/P2/P3→§一 14；§3 原则记档→§三 |
| 本档前身（2026-09-29 cr-23 首版缺口清单） | 就地续写为活清单 | 原开放第 2 项→§一 1；第 4 项→§一 2；第 5 项→§一 8；第 6 项→§一 3；闭环项→§二 |

> 变更登记：首版 `cr-23`（2026-09-29 登记；初登误取号 cr-31，随 cr-24 勘误改号）；2026-10-05 复核批 `cr-267`（第 1/3 项核销、第 4 项补判定面注记、滞后表 A/B/C 核销）；2026-10-06 组治理合并批 `cr-269`（母任务持有——四档归档 + 本清单重写）。
> 变更登记纪律：本档任何修改先登 cr-log，再改本档。
