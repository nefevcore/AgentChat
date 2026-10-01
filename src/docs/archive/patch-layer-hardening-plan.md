# Patch 层加固计划（patch layer hardening plan）

> 2026-09-27 立项（cr-8）；2026-09-28 实施落地（cr-11），验证全绿。背景：DSH（DeepSeek Harness）插件启停实现调研——
> 两项目同源 cordis 4，启停链路同构（cordis.patch.yml 偏好层 + include 热通道 +
> fiber.update 事务化行树变更）。DSH 实现见其 packages/boot/plugin-manager
> （setPluginEnabled / writePluginEnabled / reconcileProfilePatches）。本计划吸收
> 调研结论中的两处实施项，并记录三处不采纳裁决（防回头再议）。

## 一、动机与根因

### 1.1 缺陷一：程序写入抹掉手工内容，与设计卖点自相矛盾

patch 文件的定位（M23 A2，见 ac-plugin-core/src/patch.ts 文件头）：人可读、
可手工急救——坏文件 fail-soft 不阻断 boot，用户可以手改自救。但现状
setPatchEntry 是「读 → 内存 upsert → dumpPatches 全量重序列化」：

- 用户手工写的注释、条目顺序、行内格式在任何一次 UI 启停后全部丢失；
- fail-soft 承诺「坏文件人可修」，但修好后的下一次程序写入又把文件冲平。

根因：把「单条 upsert」实现成了「整文件重写」。DSH 对应层（patch.ts，44 行）
用 eemeli/yaml 的 parseDocument 做 AST 级编辑，注释与手写格式原样保留。

### 1.2 缺陷二：setPatch 未落地时谎报「重启后生效」

现状三态 'hot' / 'written' / 'no-include-row'。落地核对（2026-08-30 事故加固）
失败时回落 'written' + restartRequired=true。但核对失败的常见成因是「patch id
不在装配文件原文」（include 的 warn+skip 语义）——这种 patch 重启后同样
warn+skip，永远不会生效，UI 显示「重启后生效」是误导。核对只堵住了谎报
'hot'，没堵住谎报 'written'。

根因：核对发生在写文件之后，已无法区分「热通道故障但 id 有效（重启可救）」
与「id 根本不在装配树（重启无效）」。DSH 的顺序是先 listPlugins 校验再落盘，
未知 id 直接 throw 且不写文件。

## 二、语义决策

### 2.1 实施：setPatchEntry 改 AST 编辑（保注释保格式）

- 新增运行时依赖 yaml（eemeli，^2，零传递依赖）——与 js-yaml 分工：读路径
  readPatchFile（fail-soft）零改动；写路径 upsert 用 parseDocument AST 编辑
  （同库读改写，保注释/保条目序）。
- 同 id 匹配取最后一条（findLast）：include 的 buildMap 是 Map.set 逐条覆盖 =
  last-wins 应用语义；现状 find 首条在文件含重复 id（手工编辑可能产生）时
  改了不生效——顺带修复。
- 新追加条目用 flow 风格 - { id: x, disabled: true } 对齐 dumpPatches 既有
  外观；已存在条目的编辑天然保持原格式。
- 损坏文件（parse errors 非空）→ throw 拒绝覆盖（行为变更，理由见 §4.1）。

### 2.2 实施：setPatch 前置装配树校验（fail-loud）

- include 在位时：落盘之前枚举装配树 entry id（复用 enumerateDisablableEntryIds），
  id 不在树 → throw，不写文件——对齐 DSH 的「先校验再落盘」顺序。
- include 不在位：维持现状（no-include-row / dist 形态 written）——无树可校验，不猜。
- 落地核对保留为兜底（校验与 fiber.update 之间树漂移的窗口）。

### 2.3 裁决：不采纳项

| 候选 | 裁决 | 依据 |
|---|---|---|
| DSH 'overridden' 第四态（被更高层 patch 覆盖时显式暴露） | 不迁移 | DSH 的层叠覆盖来自其多层 patch 栈（profile 层 + bundle 层 + 全局层）；AC 是单层 cordis.patch.yml，不存在层叠场景——该语境不成立 |
| 启停与装包统一锁域（DSH: profile/package.json 文件锁） | 无需做 | AC 已由 withRootLock 数据根串行队列统一（patch 写口 + registry mutation 共用，F5/G10）——现状已满足 |
| Agent 启停工具入口（DSH plugin_manager：Agent 可启停/装卸） | 维持不做 | DSH 把启停当「Agent 可代理的高危操作」；AC 治理姿态是启停属用户主权（UI 专属 + 级联确认）。若未来要做，须先过 per-Agent 门控与权限面裁决，不在本计划范围 |

## 三、实施清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | src/ac-plugin-core/package.json | dependencies + yaml: ^2 |
| 2 | src/ac-plugin-core/src/patch.ts | setPatchEntry 改 AST 路径：parseDocument → findLast 匹配（setIn disabled / 追加 flow 条目）→ 原子写；损坏 throw；文件头注释同步更新 |
| 3 | src/ac-plugin-registry/src/service.ts | setPatch 前置校验：include 在位且 id 不在 enumerateDisablableEntryIds 树 → throw（对齐 DSH unknown-plugin 语义） |
| 4 | src/ac-app/tests/patch-layer.integration.test.ts | 增断言：① 手工注释在 upsert 往返后原样保留；② 损坏文件 throw；③ 重复 id 改末条；④ 未知 id setPatch throw 且文件未写 |
| 5 | src/docs/cr-log.md | 本计划登记（cr-8，已随方案落地） |

writePatchFile / readPatchFile / resetPatches / patch-rpc 降级路径 / vendor
include / boot / bootstrap / 前端：零改动（论证见 §4.2）。

## 四、影响面

### 4.1 行为变更（三处，均为根因修复的代价）

1. 损坏 patch 文件：从「fail-soft 读空 → 全量覆盖（自愈但丢用户内容）」变
   「throw 拒绝覆盖」。理由：覆盖恰恰会抹掉用户手写一半的急救内容，与 fail-soft
   的急救设计矛盾；拒绝 + 报错让人先修文件。调用方错误透传：service.setPatch
   → RPC → UI 通用错误提示；patch-rpc 降级路径同样透传。
2. 文件含重复 id：upsert 目标从首条变末条（对齐 include last-wins）。
3. 未知行 id：setPatch 从「写文件 + written/restartRequired（重启也无效）」
   变「throw 不写」。

### 4.2 不动面（影响面收敛的论证）

- writePatchFile 三处调用（resetPatches factory/minimal、patch-rpc 降级 reset）
  全是还原语义，全量重写即正确行为——本计划不动它，影响面从「全写路径」
  收敛到「单条 upsert 一条路径」。
- 既有 cordis.patch.yml（程序生成的行内格式）AST 读写兼容，无需迁移。
- readPatchFile 的 fail-soft 语义及其测试锁定零改动；两库分工边界 = 读 js-yaml
  / 写 eemeli（仅 setPatchEntry 内部，不外泄）。

### 4.3 新依赖

- yaml@^2：纯 JS、零运行时传递依赖；进 ac-plugin-core dependencies
  （check:deps 校验声明）。

## 五、验证阶梯

```
pnpm typecheck && pnpm test:unit && pnpm check:deps
npx eslint src/ac-plugin-core/src/patch.ts src/ac-plugin-registry/src/service.ts
pnpm test:integration   # 改动持久化层；定向 npx vitest run src/ac-app
```

不动契约/事件/行集 → 无需 smoke；不动前端 → 无需 webui:typecheck。

## 六、工作量

约 0.5 天：patch.ts ~50 行、service.ts ~10 行、测试 ~80 行。方案先行，实施可
拆两步独立提交（2.1 保注释 / 2.2 前置校验），互不阻塞。