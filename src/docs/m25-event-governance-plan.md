# M25 设计稿：事件治理与运行时行树治理

> 状态：**✅ 已实施（2026-08-30，按定稿 v6 全批落地 P1-P3——三轮审查收敛
> 后的收敛终态即为实施形态）**。正文为各轮裁决的**收敛终态**；行内
> （B/N 系）仅作追溯锚点、不叙述修订过程。版本史与审查档案：
>
> | 版本 | 轮次 | 裁决系 |
> |---|---|---|
> | v1 | 本轮讨论 | 三层设计：agentGate / owning 包读取器 / @scope 作用域 / facet 切面 / 关停策略行 / before-step 补齐 |
> | v2 | UI 原型 v2 | 事件描述声明制 + 目录/Agent 两事件视图（UI 事实源 `docs/m24-m25-ui-prototype.html`） |
> | v3 | 一审 | 顺序口径 / vendor 类型与测试坑 / 读取器取舍注记 |
> | v4 | 二审 | **B1 重裁：行序 ≠ 激活序，boot 顺序条款 → "拦截 + boot 末一次性清扫"**；停用键定死；替代注册注记 |
> | v5–v6 | 三审 + 定稿 | N 系修文（清扫触发归属 / @scope 补全 / 逃逸窗 / exists 注记）+ 精简规范化（零新裁决） |
>
> 来源：**M23 后置 P7 全量收编**（热通道 / fiber→行聚合 / 反依赖图 /
> yml 行熔断 / 归属升级）+ 本轮讨论新裁（v1 系）。
> 前置：M23 ✅（events/listeners RPC / cordis.patch.yml / 动态插件熔断 /
> plugin/reload 均已就位）。**M25 P1 词汇依赖 M24 X1**（排期 X1 先行；倒排时
> agentGate 带 hooks/settings 同窗双读兜底，与 store 双读同窗退役）；其余
> 批次与 M24 无依赖（目录·事件视图壳由 M24 X2 交付，本文交付数据与开关）。

---

## 一、目标与范围

三层能力，一条主题（运行时治理——看得见、关得掉、烧不回）：

| 层 | 内容 | 粒度 |
|---|---|---|
| 1. per-Agent 事件门控 | agentGate helper + owning 包读取器 + facet 切面 + before-step 契约补齐 | (Agent × 行为[× facet]) |
| 2. 事件清单与治理 | 事件/监听器描述声明 + ac-event-policy 策略行 + (插件 × 事件) 停用集 + 目录/Agent 两事件视图 | (插件 × 事件) |
| 3. 行树治理（P7 收编） | fiber→行聚合 / 反依赖图 / yml 行熔断 / include 热通道 | 行 |

---

## 二、设计原则

1. **域主语身份完备性 → 事件作用域显式化**：载荷的主语是谁，身份通道就
   跟随谁。作用域二分（判定式：问"这次分发发生在**谁的执行里**"——能答出
   唯一 Agent 的为 run 域，答不出为 host 域）：
   - **run 域**：loop/\*、tool/\*、router/\*、llm/\*、conversation/steered
     ——身份通道齐备，可 agentGate 门控；
   - **host 域**：config/changed、plugin/\*、webui/\*、ws/connection-\*、
     ws/ack、archive/completed、job/settled、agents/updated、
     durable-interaction/\*、group/created·deleted·renamed·member-\*、
     singles/updated；
   - 细分铁律：**载荷提到 agentId ≠ run 域**（agents/updated 带 agentId、
     job/settled 带 owner，但说的是"关于某 Agent 的事"、发生在宿主上下文
     ——门控问"发生在谁的执行里"，不问"载荷在说谁"）；
   - 边界裁决（N2）：`group/message-posted` 双语境可达（用户经 RPC 发言 =
     宿主上下文；Agent 群内回帖 = 该 Agent 执行里）——判定式给不出稳定
     答案，**按 host 归**（保守端：无读取器即不可门控；JSDoc 注明双语境）；
   - **清单以全部 owning 包 events.ts 为准（上述为示例非全集）**——P1 标注
     面 = 全部 owning 包（ac-group / ac-singles / ac-web-server 等勿漏）。
   显式化载体：事件目录 JSDoc 增 `@scope run | host`（与 @mode 并列，owning
   包声明）；读取器存在性 = 结构性编码（run 域才有读取器 → agentGate 编译期
   可用性自动对齐）；events/listeners UI 可按域分组（可选）。
2. **两层关停分离**：per-Agent = 分发时门控（agentGate 自查）；进程级 =
   注册期拦截（internal/listener 策略行）——不焊在同一机制上。作用域
   显式化**不改变键位结论**：run 域可门控 ≠ per-Agent 配置键可带事件名
   （事件挂载是易变内政、一份配置 1:N 服务多个监听器——框架级键到行为
   为止；行为内细分 = 作者自定义字段/facet，非框架键维度）。
3. **命名读取器，不做中央注册表**：读取器住 owning 包、调用点显式选择；
   禁止"事件名→提取器"运行时分发表（契约所有权倒置，M23 已否的形态）。
4. **签名层不抹平**：身份通道形态差异（request 字段 / 首参 / 载体字段 /
   llm 的 meta 记录）各随其分发结构，由读取器层归一——统一签名是无收益
   的破坏性翻搅。
5. **吞掉注册 ≠ veto**：waterfall 链由剩余监听器自动构造——关停语义 =
   "该插件在该事件上不存在"，链条其余部分照常（ADR-7 顺序无关收敛保证
   任意子集成立）。

---

## 三、目标设计

### 3.1 loop/before-step 契约补齐（域内唯一身份缺口）

```ts
export interface LoopStepCall {
  /** 发起 Agent id（查 AgentConfig.settings 用；宿主直调/子代理 = undefined）
   *  ——与 LoopStepTransform.agent 同款步级身份通道 */
  agent: string | undefined;
  messages: LlmMessage[];
}
```

- 发射点一行（`request.agent` 已在作用域内）；现状消费者 = 0，纯加法。
- **不加 envelope**：emit 事件带 envelope 是 WS 过滤的真实需要，waterfall
  载体带 agent 是门控的真实需要——各按需要出生，per-conversation 步级注入
  出现真实用例时再加。

### 3.2 agentOf 命名读取器（owning 包导出，类型锚定自家契约）

| owning 包 | 读取器 | 覆盖事件 |
|---|---|---|
| ac-agent-loop | `agentOfRunCall` / `agentOfRunRequest` / `agentOfStepCall` / `agentOfStepTransform` / `agentOfRunTransform` | before-run / run-started·after-run / before-step / transform-step / transform-run |
| ac-tools | `agentOfExecution` / `agentOfToolTransform` | before-execute / transform-result（after-execute 同形） |
| ac-router | `agentOfMessage` | message-received / reply-completed（首参直读） |
| ac-llm | `agentOfChatCall` / `agentOfChatInput` | before-chat / delta-\*·chat-error（`meta.agent` 通道——loop 注入的 input.meta） |
| ac-conversation | `agentOfSteered` | conversation/steered（首参直读） |

- 每个一行、防御性短路（undefined → 门控 fail-open）。
- **存在性**：十个读取器当前一个都不存在（全部待建）——表中各事件的
  **载荷身份通道**已存在，唯 before-step 的通道随 §3.1 新增。
- **取舍**：emit 通知类事件（step-started / after-step 首参即 agentId、
  tool/progress 的 call 同形）默认不预铺读取器——用到再提（一行成本）；
  表内为首期门控主人群（waterfall 拦截/变换面）。
- **失败模式锚定**：读取器读错载荷形状 → undefined → 门控静默放行（最阴的
  失败形态）。对策 = 读取器签名直接用自家 contract 类型——载荷变形在
  **定义处** typecheck 红，而非散落消费者静默漂移。
- 无身份的事件**不出读取器**；agentGate 签名强制传 agentOf → 无身份事件
  编译期不可门控（把"不该门控"编码进类型）。

### 3.3 agentGate 门控 helper（新纯库包 `ac-gate-core`）

```ts
export function agentGate<L extends (...args: any[]) => any>(
  ctx: Context, pluginName: string,
  agentOf: (first: Parameters<L>[0]) => string | undefined,
  inner: L,
  opts?: { facet?: string },
): L;
```

- **软依赖**：内部 `ctx.get('agents')`——没有 agents 服务的组合里 gated
  插件照常运行（恒放行），与"无配置 = 启用"语义一致；不用裸 `ctx.agents`
  （事件闭包里受限解析会断链，M12 铁律 2）。
- **waterfall 停用 = `return next()`**（末参函数判定）：机械保证 next()
  纪律——人手写自查"忘了调 next()"这个反模式从根上消灭；emit 停用 =
  跳过。前提锁定：末参函数启发式要求 emit 事件末参永不为函数——P1 加
  目录锁定测试（对 @mode emit 声明做静态检查）。
- **facet 切面子键**（一插件多 run 域事件的细分关停）：逐监听器包裹时传
  `{ facet: 'redact' }` → 读
  `settings[pluginName][facet].enabled ?? settings[pluginName].enabled`
  （子键覆盖、回落行为级——与 A1 同款"具体覆盖一般"）。性质：facet 名由
  作者命名（稳定语义承诺，非事件名——重构挂载不碎配置）；**耦合由作者
  裁定**（不可分的监听器共享 facet 或不传——半开状态源头不存在，如
  session 的 checkpoint 与积累永不拆分）；catalog `fields` 声明 facet 字段
  即进弹窗/全局默认层（deepMerge 天然支持嵌套）。**不引入事件名键**：
  治理键 stale = 良性 no-op（注册不存在了），per-Agent 事件键 stale =
  行为静默回退（配置没变、行为变了）——后果不对称，事件名键只住治理面。
- **配置读取**：走 `settingsOf`（M24 A1 落地后合成全局默认 + 差异层；未
  落地直读 `settings[pluginName]` 差异层——接口同形）。排期 X1 先行；若
  倒排，agentGate 带 `settings[名] ?? hooks[名]` 同窗双读兜底（与 store
  双读同窗退役），防 fail-open 静默失效。若本批先于 M24 A1 落地，读点
  升级归 M24 A1 批次验收（M24 §2.2 认领）。
- 模板与技能更新：event-row 模板的 `agentFilter` 手动自查升级为 agentGate
  用法；agentchat-plugin-dev 技能同步。

### 3.4 事件清单与治理（进程级）：描述声明 + `ac-event-policy` 策略行

**事件/监听器描述（声明制）**：`ctx.on` 无描述位（vendor options 仅
prepend/global，不碰 vendor）——

- 出厂行：owning 行在目录声明 `{ event, 事件描述, 监听器角色, facet,
  respectsEnabled? }`（EXTENSION_CATALOG 演进：targets 粗粒度落点 →
  监听器级声明；`respectsEnabled` 标记该行是否自查 enabled——M24
  Agent·事件视图据此告警"停用未必生效"，agentGate 普及后自然收敛）；
- 动态插件：manifest `provides.events` 扩展 `string[]` →
  `Array<string | { name, description }>`（M23 对账语义兼容）；
- 新 RPC `events/descriptions`：声明目录 × `events/listeners` 按
  `owner::event` 交叉（未声明的监听器如实只显 owner——覆盖面渐进）。

**目录·事件视图**（M24 X2 交付壳，本文交付数据）：@scope 分组的事件清单
（事件名 + @mode + 描述 + 监听器链含角色注释）+ 每行治理开关。

**Agent·事件视图**：本 Agent 生效链 = `events/listeners` × `agents/assembly`
settings 门控态——行为级停用 M24 即可前端计算；facet 感知随本文（声明目录
携带 facet → 停用态灰显对应监听器，与 agentGate 同语义）。本页无事件粒度
开关（粒度边界：per-Agent 到行为/facet 为止）。

**ac-event-policy 策略行**：

- **机制**：`ctx.on('internal/listener', function (name, listener, options)
  { … }, { global: true })`——bail 事件，`this` = 注册方 Context →
  `this.fiber?.name` 定位注册方；键 `` `${owner}::${name}` `` 命中停用集 →
  **返回替代注册**（`() => true`）——监听器从未进 `_hooks`。
- **boot 覆盖（B1 重裁——"拦截 + boot 末一次性清扫"）**：拦截只能拦
  "策略行就位之后"的注册；loader **并发创建行**（`EntryGroup.update`
  `Promise.allSettled`）、fiber 各自激活无屏障——**行序 ≠ 激活序**，boot
  期出厂行注册可能先于策略行就位（哪些逃逸随 import 时序非确定漂移），
  "紧随装载 + 行位断言"不可行（cordis.yml 头注"行序无激活语义"维持）。
  三件套：
  - **拦截**管策略行就位后的一切注册——运行时 install / 插件重载全覆盖；
  - **boot 末一次性清扫**：boot 收敛点（include `EntryTree.await()` 语义 /
    loader 空闲）对 `_hooks` 按停用集做**单次**清扫——收口 boot 期逃逸
    注册。与"不做运行时 splice"不矛盾：被否的是**响应式**热改（配置热更
    随时 splice → 与注册表漂移）；单次清扫发生在全部注册尘埃落定后、与
    重载互斥，语义收敛。
  - **清扫触发归属（N1）**：普通行无法感知"boot 已收敛"——由组合根认领：
    `ac-app/src/boot.ts` 在 `await ctx.loader.create(...)` 收敛后显式调用
    策略行清扫口（该文件已有组合根职责先例：内联 bin.js 16 行 + patch
    注入）；程序化路径（bootTree 无 loader、串行 await）由测试直调清扫口。
- **策略行自身 reload 逃逸窗（N6）**：行重挂期间 `internal/listener` 无
  消费者、注册逃逸且 boot 已过——apply 收尾时**自追一次清扫**（幂等）；
  窗口极窄（dev/HMR），如实声明。
- **vendor 私有面三重防线**（与热通道同款）：清扫幂等测试 + 重载后清扫
  no-op 测试 + boot 后 `_hooks` 不含停用键条目断言。
- **internal/\* 恒放行**（守卫：策略行自己的 seam 不可被停，防自锁）。
- **停用键格式（定死）**：停用集存 config.json
  `events.disabled: string[]`，键 = `events/listeners` 的 owner **原文**
  （不迁移）；P3 聚合**只改呈现不改键**，策略行匹配对 fiber 名与聚合行名
  双命中（防显示升级后按行名书写的新键失配）。
- **生效时机**：注册期拦截 + boot 末清扫；`config/changed` 热更只影响
  **后续**注册（已注册条目等重载/重启——与 patch 停用同款 UX）。
- **fiber 生命周期安全**：吞注册路径 vendor `register()` 未执行、无 effect
  disposer（卸载天然无操作）；清扫路径条目正常移除，插件卸载时原 disposer
  unregister 落空 → no-op。
- **bail 单链纪律**：internal/listener 是首胜单链——**此 seam 仅本策略行
  使用**（规约 + 测试锁定：其余行注册即红灯；判据排除 vendor 自带消费者
  [EventsService 构造器 internal/update 特判]，且 `events/listeners` RPC
  过滤 `internal/*`——测试直读 `_hooks`）。
- **实现注记**：vendor `internal/listener` 类型声明为
  `(this, name, listener, prepend: boolean)`，运行时实参是 **options 对象**
  ——实现侧 cast（不碰 vendor）；策略行收到的 listener 是 `reflect.bind`
  包装后的形式；替代注册对**任何真值**生效——替代函数做成幂等。
- **RPC**：`events/policy-list`（停用集 × events/listeners 交叉呈现）/
  `events/policy-set`（写 config + 影响提示：已注册条目附重载/重启指引）。
  注意 `events/listeners` 天然漏零监听器事件（空链不显）——**全量事件
  清单以声明目录为准**；Agent·事件视图算生效链同理。
- **UI**：目录·事件每行开关；automatic / 基础设施行二次确认 + 承重警示
  （实例：关掉 ac-session 的 `router/reply-completed` 破坏会话桶一致性）。

### 3.5 行树治理（M23 P7 收编）

- **fiber→顶层行聚合**：沿 fiber 祖先链定位挂载行；匿名 fiber 继承父名的
  假边在聚合时归并。消费方：events/listeners owner 裸名 → 行名、
  plugin/rows 动态同名判据 registry 名单近似 → 精确 fiber 归属、yml 行
  熔断归属。**聚合只改呈现，不改任何键**（§3.4 双命中）。
- **反依赖图**：运行时 fiber 树构建（fiber 名 × `fiber.inject` 键集传递
  闭包）→ RPC 透出 + UI 停用承重行级联警告（"停用 ac-llm 将断链
  llm-openai/agent-loop/web-api/…"）+ `ctx.get` 软依赖盲区 UI 说明 +
  保护行标记（security / plugin-gates：二次确认特殊文案，不指望图）。
- **yml 行熔断**：`{global:true}` 订阅 `internal/status`（FAILED ≠ 级联
  PENDING）+ 失败 ≥3 写 patch disable + `setPatch` 再启用清计数（与动态
  插件熔断同款生命周期）。
- **include 热通道**：`ctx.registry.get(Include)` 取 fiber →
  `fiber.update({ path: './cordis.yml', patches })` 事务化行树变更（失败
  回滚保持旧树）→ `setPatch` 返回 `hot` 态（M23 三态契约补全，接口不变）。
  **F10 写回守卫维持**："patch-set + 树操作后 cordis.yml 字节不变"测试
  仍须绿（`fiber.update` noSave 语义显式验证）。

---

## 四、迁移步骤（分批，每批独立可验收）

验收命令统一：`pnpm --filter ac-webui-app typecheck` +
`pnpm exec vitest run preview/webui/tests` + `pnpm preview:typecheck &&
pnpm preview:test` + `pnpm preview:smoke` / boot 手测该批功能。

**P1 契约与门控基建**：before-step 补 agent（契约 + 发射点 + 读取器 +
events.ts JSDoc 同步）+ 五包读取器 + 全部 owning 包事件目录补 `@scope`
标注（group/singles/web-server 勿漏）+ `ac-gate-core`（agentGate，含
waterfall/emit/无身份/无 agents 服务/facet 子键覆盖/倒排双读兜底六形态
测试）+ 目录锁定测试（@mode emit 事件末参永不为函数）+ 模板与技能更新。

**P2 事件清单与治理**：事件描述声明（EXTENSION_CATALOG 演进含
respectsEnabled + manifest provides.events 扩展 + 校验兼容）+
`events/descriptions` RPC + ac-event-policy（bail 拦截 + boot 末清扫
[触发 = boot.ts 组合根收敛后调用；bootTree 路径测试直调] + internal/\*
守卫 + 热更 + 行内自追清扫）+ config `events.disabled` 域 +
`events/policy-list·policy-set` RPC + 目录·事件视图（描述 + @scope 分组 +
治理开关与承重警示；全量清单以声明目录为准）+ Agent·事件视图 facet 感知。
测试：吞注册语义 / boot 后 `_hooks` 不含停用键条目（清扫断言）/ 清扫幂等
与重载后 no-op / 自锁守卫 / 重载生效 / bail 单链纪律（排除 vendor 自带
消费者、直读 `_hooks`）/ 描述交叉形状 / provides.events 新旧形状兼容 /
@scope 标注全量 owning 包。

**P3 行树治理**（聚合是本批首项；P2 期间归属键暂用裸 fiber 名，聚合落地
后统一升级呈现）：聚合映射 → events/listeners 与 plugin/rows 归属升级 →
反依赖图 + 级联警告 + 保护行 → yml 行熔断 → 热通道 + setPatch hot 态 +
F10 守卫维持。

---

## 五、风险与显式缩水

**风险与对策**：

- **承重半边关停**：单事件关停可破坏插件内部不变量（session 桶一致性、
  archive 三闸）——UI 警示 + automatic 行二次确认补偿；机械上不做依赖
  分析（监听器间数据流不可见）。
- **agentGate fail-open 静默**：读取器形状错读 = 恒放行——类型锚定
  owning 包 + 读取器单测缓解；不接受运行时告警（热路径）。
- **热通道贴 vendor 私有面**（M23 H2 已判）：F10 写回守卫 + `noSave`
  语义验证 + 失败回滚测试三重防线。

**显式缩水（接受，不恢复）**：

1. 监听器优先度/重排不做（M23 §3.5 裁决维持）：prepend 双档 + 关停二档
   够用；`internal/listener` bail 的剩余用途仅本策略行。
2. **单个监听器粒度永不做**：监听器无稳定 id（只有 owner + 数组位置），
   waterfall 链序语义下按位置定位不可靠——治理面 (插件 × 事件) 是可稳定
   寻址的最小粒度（facet 是作者命名的行为切面，非监听器寻址，不冲突）。
3. 签名形态统一不做（§二.4）。
4. 治理面（events.disabled）不做按 Agent 细分——per-Agent 细分归 agentGate
   （行为 + facet）职责，两层不混。
5. 描述声明是渐进覆盖面：未声明的监听器只显 owner 裸名，不做自动推断。

---

## 六、事实源索引

| 内容 | 文件 |
|---|---|
| loop/* 事件目录与载荷形状（契约补齐点） | `preview/ac-agent-loop/src/{contract,events}.ts` |
| before-step 发射点（request.agent 在作用域） | `preview/ac-agent-loop/src/service.ts`（step()） |
| tool/* · router/* 事件目录（读取器落点） | `preview/ac-tools/src/events.ts`、`ac-router/src/events.ts` |
| internal/listener bail 语义（替代注册） | `src/vendor/cordis/src/events.ts`（EventsService.on） |
| loader 并发模型 + EntryTree.await（B1 证据与清扫收敛点） | `src/vendor/loader/src/config/{group,tree}.ts` |
| fiber 树 / internal/status（聚合与 yml 熔断数据源） | `src/vendor/cordis/src/fiber.ts` |
| include 热通道（fiber.update 事务化） | `src/vendor/include/src/index.ts` |
| 组合根清扫触发认领点（N1） | `preview/ac-app/src/boot.ts` |
| events/listeners RPC（归属升级对象） | `preview/ac-web-api/src/index.ts` |
| 事件描述声明落点（targets → 监听器级演进） | `preview/ac-web-api/src/index.ts`（EXTENSION_CATALOG） |
| manifest provides 形状（events 扩展落点） | `preview/ac-plugin-core/src/manifest.ts` |
| cordis.patch.yml 域 + setPatch 三态（hot 态补全对象） | `preview/ac-plugin-core/src/patch.ts`、`ac-plugin-registry/src/service.ts` |
| F10 写回守卫（热通道后须维持） | `preview/ac-app/tests/patch-layer.test.ts` |
| **UI 事实源（事件视图/治理开关/Agent 生效链原型）** | `preview/docs/m24-m25-ui-prototype.html` |
| 契约归属 / 读取器住 owning 包纪律 | `.dsh/skills/agentchat-framework-dev` |
| settings[具名] 词汇 / settingsOf / 全局默认层 | `preview/docs/m24-global-defaults-plan.md`（X1 / A1 / X2） |
| 三轮审查档案（B/C/D·N 系裁决出处） | `preview/docs/m24-m25-review.md` |
| P7 原始裁决 | `preview/docs/m23-agent-plugin-plan.md` §3.4/§五 P7 |
