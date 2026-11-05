# preset 身份收敛——方案档案（cr-880 已实施）

> 状态：**已实施**（cr-880，2026-11-03）。本档案接续 docs/design/plugin-dev-skill-plan.md §5 独立发现，
> 由 2026-11-03 会话全仓审计确证；同日二次会话独立复核 + 用户裁决后落地。裁决记录见 §0。

## 0. 裁决记录（2026-11-03 立项会话）

1. **「推翻重来」不成立**——领域模型（模板 → 物化 → 活体 + copy-on-write 升级）健康，
   坏的只是身份判定的表达层；重设计需迁数据（正是 cr-812 事故源）且不减少本质复杂度。
2. **权威判别方式 = ② 词形谓词 isPresetId**（用户裁决，三轮：字段 vs 词形 vs 模板注册面）。
   定位论证：预设 = 由模板诞生的**单例活体 Agent**（积累会话/记忆/技能，不可再生），类属
   出生定型终身不变——同一模板物化到保留字 id 即预设、到用户 id 即普通身份，类属由 id
   词形承载是唯一自洽落点。①字段：值需词形推导 + boot 对账修复，cr-812 已证明会丢；
   ③模板注册面：壳侧不可达（需新投递面）+ 模板下架会翻转终身类属。
3. **创建口闸门**：sanitizeAgentInput create 词法闸拒绝普通身份占用 `__<key>__` 词形
   （词形判定单源的反面闸门——防假阳性；预设只经宿主模板物化路径出生，不经此口）。
4. 词形兼容下划线（历史 id 冻结）+ presetTemplateKeyOf 归一化 `_`→`-`（模板目录查找口）。
5. 数据面裁决：`__programmatic__` 孤儿目录删除（用户确认）；`files/__*__` 既有内容原样
   保留（无害遗留）。

## 1. 问题定性与根因（已确证）

### 1.1 一个布尔承载四重身份

preset:true 实际承担：
| 身份 | 场所 | 说明 |
|---|---|---|
| 模板域标记 | 4 个 templates/*/config.json | 唯一消费者是 materializeConfigOf 的剥除本身 |
| 名册排除 | web-api rosterConfigs / collab send_agent、list_agents、update_agent_profile / memory 不建档 / timers 不调度 | 「不出现在协作/管理/调度面」 |
| 工作区形态 | ac-workspace 四处 + workspace-files | 「无个人空间，workdir=数据根」 |
| 历史残留 | 活体 dsh_minimal 残留 preset:true / __programmatic__ 孤儿目录 / collab L239 过时注释 | 认知税 |

### 1.2 活体状态分裂实锤（2026-11-03 数据根实测）

- __abap_dev__ / __creator__ / __standard__：preset 已剥（cr-812 重置过）→ 被当普通 Agent：
  名册过滤链失效（疑似回归 cr-600 修过的问题）、获得 files/<id> 个人空间、可被协作投递、可被 timers 调度。
- __dsh_minimal__：preset:true 残留（cr-812 漏网）→ 仍被当预设。
- 同一产品概念的行为由「哪个预设恰好经过 cr-812 重置」这个历史事故决定。

### 1.3 新发现：词形判定轨自身的暗坑（本会话实锤）

- PRESET_ID = /^__([a-z0-9-]+)__$/ **不吃下划线**：__dsh_minimal__ / __abap_dev__ 双双 null。
- 模板目录名用连字符（dsh-minimal / abap-dev），config.id 用下划线（__dsh_minimal__ / __abap_dev__）。
- 后果：orchestrate presetTemplateOf 对下划线 id 返 undefined（首启回落裸 {id} 兜底——被 ac-sap-adt
  preset 子行等旁路物化掩盖）；boot reconcilePresets 直接跳过下划线 id（永不升级、无 origin 记账）。
  dsh_minimal 正是因此成为 cr-812 「三预设重置」的漏网之鱼。
- reserved.ts BUILTIN_AGENT_IDS 冻结的是下划线词形——历史数据不可改，收敛方案必须兼容。

### 1.4 根因三条

1. **身份类属用可变状态表达，本质是不变词形**。预设身份恒 __<key>__（保留字锁死普通 Agent 不可占、
   子身份 id 天然不带该词形）——结构性不变量挂在可变布尔上，漂移必然。词形判定轨与标志判定轨双轨并行，
   恒不一致。
2. **单布尔绑死 5+ 正交关注点**（名册/协作/管理/空间/调度/记忆），各消费点手工组合且式样不一，
   无单一谓词，每个新消费点都是重新发明。
3. **模板域与活体域共用同一字段**——模板字段唯一命运是被剥除，剥除逻辑/时机/漏剥后果全是衍生成本。

## 1.5 实施中新确证（cr-880）

- collab L239/L625「subagent 派生条目 preset:true」注释是 cr-355 遗物：派生条目经
  deriveChildConfig 落盘本就无字段、且不进父壳 ctx.agents——该守卫对派生条目早已是
  死代码；对三预设（字段被 cr-812 剥除）同样失效。词形判定一并修活两处守卫。
- `ac-memory/src/index.ts:217` 本地类型联合的 `preset?: boolean` 随字段退役删除。

## 2. 目标终态

1. **判定单源**：isPresetId(id) 词形谓词落 ac-agents-core（零依赖纯函数，宿主直读盘/壳内存态双环境可用）。
   词形兼容下划线与连字符（历史 id 冻结）；模板键查找做 _→- 归一化。
2. **字段退役**：模板与活体 config 均不再写 preset；materializeConfigOf 剥除逻辑退役；
   deriveChildConfig 剥减层退役；契约面（ac-agents-core config.ts + ac-agents service.ts）字段删除。
3. **存量清理**：dsh_minimal 活体 preset:true 移除；__programmatic__ 孤儿目录清理（需用户确认——数据删除）。
4. 产品行为零变更（预设无个人空间/不进名册语义原样保留），纯判定机制收敛。

## 3. 消费点全量清单（2026-11-03 全仓核验，生产代码 10 处 + 数据面 + 测试面）

### 生产代码（preset 布尔判定）
| 文件:行 | 现判定 | 改为 |
|---|---|---|
| packages/ac-workspace/src/index.ts:173,230,358,544 | agent.preset（4 处，含 isPresetLike） | isPresetId(agentId) |
| packages/ac-host-rows/src/workspace-files.ts:142 | agent.preset === true | isPresetId |
| packages/ac-host-rows/src/timers-row.ts:623,651 | !a.preset | !isPresetId(a.id) |
| packages/ac-host-webui/src/web-api.ts:103 | c.preset !== true | !isPresetId(c.id)（rosterConfigs——config 读取成本顺带省） |
| packages/ac-collab-tools/src/index.ts:268,454,627 | target?.preset / a.preset !== true / current.preset | isPresetId 三处 |
| packages/ac-memory/src/index.ts:244 | agent.preset === true | isPresetId |

### 词形判定轨修正（PRESET_ID 暗坑）
| 文件:行 | 现状 | 改为 |
|---|---|---|
| packages/ac-host-rows/src/preset-origin.ts:34 | /^__([a-z0-9-]+)__$/ 不吃下划线 | 字符类加 _，捕获后 _→- 归一化再查模板 |
| apps/host/orchestrate.ts presetTemplateOf | 同上 miss | 吃 isPresetId + 归一化（首启物化对下划线 id 生效） |
| apps/host/boot.ts reconcilePresets | 同上 miss（跳过） | 同上（下划线预设纳入升级通路） |

### 契约/剥除/数据面
- packages/ac-agents-core/src/config.ts:18-19 字段删除；ac-agents/src/service.ts:30-36 字段+JSDoc 删除
  （memory L217 本地类型同步）。
- preset-builtin.ts materializeConfigOf:86-89 剥除退役；agents-core/tree.ts:148 deriveChildConfig 剥减退役。
- 4 个 templates/*/config.json 移除 "preset": true。
- 活体：workspace/home/agents/__dsh_minimal__/config.json 移除 preset:true；
  agents/__programmatic__/ 孤儿目录（无 config）删除——**需用户确认**。
- collab-tools L239 过时注释（「派生条目 preset:true」——materializeChild 现剥除）订正。

### 测试面（同步改）
- preset-builtin.test:21-22（模板断言）、agents-row.test:114,116（创建物断言）、
  shadow.test:28,48（子身份断言）、orchestrate-preset.test:42（剥除断言）。
- 新增：isPresetId 词形单测（含下划线/连字符/普通 id/子身份 id）；PRESET_ID 归一化往返。
- 既有 preset:true 测试种子（memory.test:386、timers-row.test:108、workspace-files.test:34、
  settings-of.test:78、shadow.test:16）——改用 __x__ 词形 id 或随字段退役删除断言。

## 4. 实施步骤草案（立项 CR 后按序）

1. ac-agents-core 落 isPresetId + 单测（先行——零依赖纯函数，其他改动全吃它）。
2. PRESET_ID 归一化修正（preset-origin.ts + orchestrate + boot）——修复下划线预设的物化/升级通路（独立可交付）。
3. 10 处消费点机械替换（每处同款改法）。
4. 契约字段删除 + 剥除逻辑退役 + 模板数据面清理（编译器兜底找漏改点）。
5. 活体数据清理（dsh_minimal preset:true 移除；__programmatic__ 孤儿目录问用户后删）。
6. 测试面同步 + 新增词形单测。
7. 验证阶梯：pnpm typecheck && pnpm test:unit && pnpm check:deps + 定向 eslint；
   动了契约/行集/装配链 → pnpm test 全量；宿主装载行改动 → restart_host 活体验证（名册四预设缺席、
   files/__standard__ 等个人空间目录不再生成、singles 选用面正常）。

## 5. 需用户裁决的设计决策

1. **词形判定兼容策略**：接受下划线+连字符双词形（推荐——历史 id 冻结不可改）vs 数据迁移统一词形（风险大不推荐）。
2. **virtual 是否一并收敛**：workspace-files/timers 等处的 preset||virtual 组合是否抽成单一谓词
   （如 isRosterEligible）——建议本次只收敛 preset，virtual 语义另议（牵扯 viewer 端点语义）。
3. **模板 config 的 preset:true 移除**：目录位置已是充分标记，字段冗余——建议移除（preset-builtin.test
   断言同步）。
4. **__programmatic__ 孤儿目录**：cr-355 移除子行后的残留空目录，建议删（数据删除，需确认）。

## 6. 风险与回归面

- 改动面 10+ 包，但每处机械替换 + 编译器兜底（字段删除后 .preset 引用即 type error）。
- 行为回归风险最高点：rosterConfigs（名册混入/漏出）、workspace agentWorkdir（个人空间形态切换）、
   timers（预设被意外调度）。三处各自已有测试锁定，改断言时保持语义等价。
- 词形归一化修正会让 dsh_minimal/abap_dev 首次进入 reconcile 通路：首次 boot 判 origin 缺席 → baseline
  补记现状（无内容回写，安全）；abap_dev 经 ac-sap-adt 子行物化过，config 已在场——同样走 baseline。
- 与 cr-879（已完成）零耦合；与 cr-877 批等在途文件无交集。
