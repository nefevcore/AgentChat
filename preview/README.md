# preview/ —— 壳模型旁路重建轨（cr-488 立项，2026-10-17）

> 性质：per-agent 壳模型新架构的旁路重建开发目录（R-10 裁决形态）。开发期零兼容、
> 不背旧账；整体稳定后 cutover 覆盖主线。设计裁决与工程规格见 `src/docs/`：
> shell-model-unification.md（S0 + P2 五条，2026-10-17 裁决）· host-shell-row-manifest.md
> （行集 47+35）· protocol-spec-envelope-lock-guardian.md（信封/锁/监护）·
> auth-registry-data-format.md · ui-tree.md；母档案 per-agent-instance-architecture.md
> （R-1…R-12）与 cell-runtime-and-architecture-evolution.md（已收档）。

## 目录约定

- `apps/` —— 宿主与 CLI 壳入口（宿主 = 邮局 + 监护人 + webui + 授权注册表写者；壳 = boot
  agent 子树的进程，唯一形态）。
- `packages/` —— 纯库与能力行（信封协议 / 指纹 / 授权投影 / sandbox-core 等两侧共用件）。
- `sandbox/` —— preview 开发期数据根与临时产物（独立数据根，绝不共用主线——R-10 隔离纪律）。

## 开发序（D9 preview 内部里程碑，获自由后不设强制序）

壳 / 账本 / 投递可并行推进；最小验收参照 D9 三步：会话形态统一 spike → activation
单例锁 + agent 子树 CLI 形态（前置：门禁链数据化）→ 宿主邮局化（跨进程投递跑通）。

## 纪律

- 一切变更先登记 CR；日期 = 真实日历日 YYYY-MM-DD。
- preview 轨的行集/契约变更须回写 host-shell-row-manifest.md（与两表锁定测试同批）。
- cutover 前恒等门测试与导入脚本不进本目录（切换前置，见 R-10）。
