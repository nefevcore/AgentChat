---
name: cr
description: CR 变更登记制度——一切代码/文档变更动手前先登记 CR 取号（时间线追溯主键）。要登记变更、查变更历史、流转状态时用本技能。
---

# CR 变更登记

CR = Change Record（变更记录）：**动手前登记、注释引用 cr 号、项目变动沿时间线可追溯**。登记是自律动作，不是审批流。

## 三件分工

| 件 | 职责 | 写入纪律 |
|---|---|---|
| `cr/cr-log.md` | 纯索引（一行一 CR） | **append-only，永不手编**——只走 append |
| `cr/cr-meta.json` | 状态/标签/引用（稀疏） | CLI 维护禁手编——append/set 写入 |
| `cr/logs/cr-N.md` | 详情正本（可选） | 整文件自由写；**CR 只登记变更情报**，规划类内容写项目文档区勿入 |

## 核心循环

1. **动手前**：`node cr/cr.mjs append '一句话描述' [#标签] [→cr-引用] [--status plan|doing]`
   - 自动取号（索引最大号+1）、当日日期；缺省 done（随批闭环），在途 doing、立项 plan。
   - 代码注释里引用拿到的 cr 号（`// cr-N 2026-xx-xx …`）——追溯链的另一半。
2. **细节沉淀**（可选）：写 `cr/logs/cr-N.md`——动机/改动面/裁决/验证。
3. **收口**：`node cr/cr.mjs set <N> done`（或 drop + 缘由）——只改 meta，不动索引。
4. **守门**（git 项目）：`node cr/cr-git.mjs check`。

## 命令速查

```
node cr/cr.mjs append '一句话描述' [#标签…] [→cr-引用…] [--status plan|doing|done|drop] [--date YYYY-MM-DD]
node cr/cr.mjs get <crN> [crM …]            # 索引行 + meta + 详情聚合
node cr/cr.mjs set <crN> <plan|doing|done|drop>
node cr/cr.mjs grep [head|detail] <词>… [--status S] [--id cr-N] [--scope #x] [-n N] [--oneline]
node cr/cr.mjs stats                        # 计数 + plan/doing 欠账清单
node cr/cr.mjs init [目标项目路径]           # 落地 cr/（重跑 = 升级工具）
node cr/cr-git.mjs migrate                  # v3.1 一次性：行内块剥离入 meta（幂等）
node cr/cr-git.mjs sync [--rebuild]         # cr-commits.json 投影（生成物禁手改）
node cr/cr-git.mjs check                    # 守门
```

- grep 缺省 head（只查索引行）；detail 连 logs/ 详情一并检索（命中行带文件出处）。
- commit message 里写 cr 号（如 `fix(llm): cr-1042 …`），sync 投影建立 cr↔commit 反向索引。
- 台账（cr-log.md + cr-meta.json）攒批独立 chore 提交，不随功能提交混；logs/ 详情可随功能提交。

## 状态机

plan → doing → done；任何态可 drop（留缘由）。无 meta 记录 = done 无标签。
