# creator 插件开发知识技能化——cr-879 完成报告（2026-11-03）

> 性质：实施报告——插件开发知识从 persona 迁到 skill 的决策链与落地记录。
> 状态：已实施（cr-878 AGENTS.md 瘦身 + cr-879 技能化迁移双 CR 落地）· cr-1008 2026-11-11 整理批检阅归位。
> 读者：改 creator 预设、plugin-dev 技能或 AGENTS.md 的人；日常无需阅读。

## 1. 背景与决策链

1. 用户要求逐句审计 creator 预设的人设文档（AGENTS.md，cr-810 起 persona 载体）。
2. 审计结论：文档大量内容与 plugin-dev 三件套 / restart 双件工具描述逐字重复（工具 schema 恒在同屏）；另有三处真实缺失（TS 语法边界 / provider models / ctx.on 形状）。
3. **cr-878（已完成）**：AGENTS.md 重写 3282→1990 字符（-39%）；restart_host 描述「packages/」措辞开发仓库条件化；tool-catalog.json 快照重生成。验证全绿（唯一失败 fs-tools glob cr-814 为并发负载环境性超时，单跑通过）。
4. **用户裁定**：插件开发知识本质是 skill 技能而非 persona——creator 会话多数不开发插件，却在付每会话常驻 token 税。终态：模板携带 skills/plugin-dev/SKILL.md，物化到 files/<id>/skills/（Agent 专属技能面），AGENTS.md 收缩为指路残句。
5. 框架内容开发技能（agentchat-dev 主体）用户裁定不做（desktop 用户态改框架不现实）。

## 2. 落地清单

### 机制代码（cr-879 本体）
- preset-builtin.ts：TemplateSkill 接口；模板 skills/ 扫描（SKILL_DIR_NAME = param-case 词法）；agentSkillsRoot / materializeTemplateSkills（skip-if-present + overwrite 旗标服务 reconcile follow）+ readAgentSkills（dirNames 可选——缺省全量扫描）
- preset-origin.ts：PresetOrigin.skills 指纹表；templateFingerprint 纳入 skills；reconcilePresetOrigin skills 判定分支（与 docs 同构：缺席→跟随落地 / ==origin 指纹→跟随 / 已编辑→保留 notice）；TemplateCorpus 形状导出（reconcile 输入面统一形状）
- 三物化点：orchestrate.ts（adoptShell 首启）+ agents-row.ts（createFromTemplate）+ boot.ts reconcile follow 分支（overwrite 落盘 + 活体全量技能读取输入）

### 内容本体
- templates/creator/skills/plugin-dev/SKILL.md：cr-878 版 AGENTS.md 全量 + plugin.md 动态插件域增量（工具注册四轴 / 事件落点 tool/before-execute、llm/before-chat / 迭代铁律）
- templates/creator/AGENTS.md 终收缩：3447→约 260 字符——指路 load_skill plugin-dev + 恒需项（行集告知 / 禁杀进程）

### 测试
- preset-builtin.test：skills 扫描 + 物化往返（skip-if-present / overwrite / 全量读取）
- agents-row.test：createFromTemplate 技能落地 + 重入幂等
- orchestrate-preset.test：__creator__ 首启物化断言改为技能面（load_skill 指路 + <400 字符 + 技能文件在场）
- preset-origin.test：skills 三态判定（缺席落地 / 未编辑跟随 / 已编辑 notice）+ baseline 纳入技能指纹

## 3. 验证

- typecheck / check:deps / 定向 eslint / ac-host-rows+apps/host 181 用例 / 全量 test:unit 2674/2675（唯一失败 = cr-814 环境性超时，单跑通过）/ 全量 pnpm test 2764/2765（同因）。
- **活体端到端**：restart_host 后宿主 reconcile 自动完成——技能落地 files/__creator__/skills/、AGENTS.md 活体收缩、origin 记账 skills 指纹、config preset 剥除。全程零手工干预。

## 4. 已知边界（非缺陷）

- 用户自建同名技能（活体在场但 origin 未记）→ notice 保留 + follow 被中止 → 该轮升级 AGENTS.md/config 也不跟随（docs 同款既有语义，用户数据优先取向）。
- 旧 origin（无 skills 指纹）在新机制首次 boot：模板指纹已变 → 全未编辑 → follow 同内容重写一轮 + 技能落地 + origin 更新为新格式（自愈，无迁移脚本）。

## 5. 独立发现：preset 双载语义矛盾（待单独 CR）

- 现象：preset 标志双载名册语义（cr-600 补标志）与工作区语义（无个人空间），cr-811/812 物化剥除与 cr-600 方向相反——活体状态分裂实锤（dsh_minimal 残留 preset:true，其余三预设已剥）。
- 对 cr-879 的影响：零（技能消费方是壳侧 WorkspaceShim，恒 files/<id>，不看 preset）。
- 收敛方向：isPresetId(id) 词形谓词单源判定，preset 字段整体退役——详见 2026-11-03 会话架构分析。

## 6. 环境与在途注意

- 工作树有大量其他批次在途未提交文件（cr-877 批等）——与本任务无关，勿动勿混提交。
- cr 登记：cr-878（完成）/ cr-879（完成）已登记。
