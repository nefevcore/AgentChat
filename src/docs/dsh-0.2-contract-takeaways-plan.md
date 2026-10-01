# DSH 0.2 插件契约比对——增量计划

> 日期：2026-10-01。状态：**记档待迭代**（比对分析完成，实施条目未动工）。
> 背景：DSH（DeepSeek Harness）0.1.2-rc.1 → 0.2.0-rc.2 插件契约转向「声明式组合」，
> 与 AgentChat 同出 cordis 生态。原始比对报告（外部文档）：
> `C:\Users\xiaofeng\Documents\Dev\WorkDev\adt\docs\dsh-0.2-plugin-contract-changes.md`。

## 1. 比对结论

DSH 0.2 废弃的三件事——扫描目录发现预设、插件命令式注册设置面板
（`settings.installSection`）、CLI reconcile 安装——恰是 AgentChat 出生即无的地形：
预设 = 注册中心 + 数据行（ac-agent-presets）、表单 = 入口自述（extension.fields）、
安装 = 工具化人审闭环（install_plugin）。四个变更面（预设载体 / 配置表单 / 热更 /
分发）全部收敛到「插件声明数据、宿主统一驱动」，与插槽-插头 / 注册即归属同向——
架构选择获外部验证，**无结构性缺口**。可落地增量集中在 ac-config 热更链路三个小件，
另有两条原则记档。

结构性差异备忘（非缺口）：DSH 预设是「插件组合单元」（可挂服务、isolate 隔离域、
按会话挂载 fiber）；AgentChat 预设是「数据实体」（AgentConfig 物化进 agents 注册表，
「Agent 是数据不是插件」）。带代码的预设需求由「行出厂 + tags 门控可见性」承接。

## 2. 实施条目（按价值排序，均为 ac-config 单包改动）

### P1 `config/changed` 载荷携带变更路径

- 现状：载荷 = 文件路径，订阅方（ac-agent-presets refreshModels / ac-event-policy 等）
  一律全量重查。
- 目标：emit 增加第二参（可选）：变更路径数组（DSH `loader/volatile-update` 同款语义，
  订阅方先判相关性再重查）。`set(key)` 单键路径天然已知；`merge`/`reload` 需 diff。
- 落点：`ac-config/src/service.ts`（commit/set/reload diff 旧新全量）+ `events.ts`
  JSDoc 同步。
- 兼容：新增可选参，存量订阅方零改动。

### P2 commit 前深等价去重

- 现状：`set()` 同值也原子写盘 + emit——订阅方空转唤醒
  （presets 的 refreshModels 得自比对 model 消化）。
- 目标：`commit()` 入口深等价判断，无实质变化直接返回不写盘不发事件
  （DSH `equalExceptVolatile` 同款原则）。
- 开放决策点：`reload()` 是「外部改文件后的同步入口」——内容等价时应去重 emit，
  但返回值 true/false 语义是否随之调整，实施时定夺并写测试锁定。

### P3（候选）快照深冻结替代 structuredClone

- 现状：`config.get/all` 每次 structuredClone——「源不可污染」靠拷贝保证，
  消费方误改自己那份副本会被静默丢弃（弱 fail-loud）。
- DSH 姿态：`Volatile.get()` 深冻结快照——读零拷贝、误改原地抛错。
- 前置：**全仓审计** `ctx.config.get(`/`.all(` 返回值有 mutate 的调用点——
  此为行为变更非纯收窄。
- 决策点：审计发现 mutate 消费方 = 放弃或逐点改造；零 mutate = 直接换。

## 3. 原则记档（机制不搬，原因与出路）

| DSH 机制 | 不搬原因 | 值得记档的原则 |
|---|---|---|
| `Volatile<T>` 原地提交（volatile 字段变更不重挂载） | 热更状态已路由进 ac-config 全局域，row config 无热更痛点 | 若未来某行 cordis 配置热更成真痛点：schema 标冷热字段、热字段不重挂载是现成答案 |
| schema 投影表单（`volatileForm()`） | extension.fields 描述的是 per-Agent settings 层（DSH 没有的层），手写自述即唯一事实源 | — |
| bundle + pnpm workspace 分发、peer 硬门禁 | 受众不同（人类 npm 作者 vs Agent 自开发 + 人审闭环）；manifest contracts range 已提供等价门禁 | — |
| 分层持久化 + 高层覆盖写拒绝 | 全局默认 ∪ per-Agent 差异两层在 UI 可见，无遮蔽 footgun | 若多层配置叠加出现「编辑被静默遮蔽」类事故，此为解法 |

文档实践借用：DSH 迁移报告的形态——结论逐条标注核验方式（运行时实测 vs 文档依据
分开计）+ 通用迁移检查清单 + 踩坑实录——值得下次破坏性契约变更时复用。

## 4. 验证阶梯（实施时）

三件均为 ac-config 单包改动，每条动手前先登 CR：

```
pnpm typecheck && pnpm test:unit && pnpm check:deps
npx eslint src/ac-config
npx vitest run src/ac-config   # 包内直接跑找不到用例
```

P1 动 events.ts 载荷 = 动事件契约 → 追加 `pnpm smoke`。