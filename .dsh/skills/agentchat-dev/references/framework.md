# 框架轨道：能力域 / 契约 / 注册中心 / 组合根

> 读条件：新增能力域、改契约与事件目录、改注册中心、改组合根时。
> 范例：`ac-llm` / `ac-tools` 的 `service.ts`（注册中心形态）；纯库范例 `ac-openai-completions`。

## 契约归属纪律

本项目没有独立契约包——类型中立包会让契约所有权倒置。核心规则：**谁提供 ctx.<domain>，谁声明本域契约与事件**，依托 cordis 声明合并做分布式注册。

文件布局与出口：

- owning 包内，`contract.ts` 放域类型（含 waterfall 可变载体接口），`events.ts` 放事件目录；单一类型的小域可直接进 `service.ts`。
- `index.ts` 契约出口固定两行（`export type *` + `export type {}`）——消费方 `import type {}` 一行拿全类型，运行时零依赖。
- 跨域词汇从 owning 包 type-import，并记入 devDependencies。
- 防撞名靠 domain/action 命名约定（param-case、before-xxx 配对），不靠集中式唯一文件。

事件 JSDoc 标注要求：

- 必标 **@mode waterfall|emit**：
  - waterfall 写明载体哪个字段可变异、短路语义；观察型监听器必须调 next() 也写进 JSDoc。
  - emit 写明载荷与谁该订阅。
- 必标 **@scope run|host**。判定式：「这次分发发生在谁的执行里」——答得出唯一 Agent 的为 run 域；run 域才有 agentOf 读取器、才可 per-Agent 门控。载荷带 agentId ≠ run 域。
- **emit 事件末参永不为函数**（静态测试锁定全量标注）。

调用约定：

- next() 永不带参数：改写输入的唯一方式是变异载体（`call.input = { ...call.input, model }`）。
- 实现侧必须在 waterfall 返回**之后**才读载体字段——路由发生在拦截之后。

## 新增能力域 checklist

1. 契约：`contract.ts` 声明域类型（含 waterfall 载体接口）。
2. 事件：`events.ts` 声明 domain/* + @mode + @scope + 姿势说明（谁 emit 谁声明）。
3. 服务：`service.ts` 实现注册中心；`index.ts` 契约出口两行 + 薄行 apply。
4. 组合根：`cordis.yml` 加行（id + 裸包名）+ `ac-app` TREE 同 id 行（行集一致有测试锁定）；行包声明 agentchat.plugin 标记（纯库不加，fail-closed）。
5. 可配置行：入口自述 `export const extension: ExtensionMeta`（契约住 ac-extension-core）——扩展目录随行声明自动生长，不改消费方。
6. 测试覆盖注册 / 回收 / 拦截 / 重名；事件目录进 event-catalog 静态检查。
7. 更新 `src/README.md` 契约归属总表与布局。

## 注册中心要点

- **注册即归属**：注册方法内用 `this.ctx.fiber.effect`（this.ctx 经 tracker 指向调用方插件的 context，调用方卸载自动回收）；返回 disposer 给数据驱动场景；重名抛错而非静默覆盖。
- **重资源懒实例化**：register 只存工厂，首次使用才构造；disposer 对已实例化对象调 `close?.()`。
- **执行链统一形态**：waterfall before → 真实现 → emit after；真实现抛错收敛为结果对象，after 带 error。

服务体内访问其他服务的三铁律：

1. 构造器 / 事件闭包访问依赖 → static inject 声明（fiber 依赖等待 + 构造期安全）。
2. 跨服务方法调用 → 一律 `this.ctx.get('<name>')`（直接属性访问在受限调用方下，会在目标的传递依赖处断链）。
3. 常驻定时器懒拉起、收敛即 dispose（空闲零定时器，`pnpm dev` 才能自退）。

## 持久化与治理

- 每个持久化域归 owning service：禁跨域越权写；跨服务读取走服务方法或 type-import。
- 机制任务（归档 / 备份）直调服务方法，不过 LLM；「触发 Agent 干活」统一走 source: 'event' 信封投递。
- 治理面是结构性约束：
  - per-Agent 门控只对 run 域事件存在（无身份事件编译期不可门控）。
  - 治理键 = 行名 / manifest.name（改名 = 破坏用户配置）。
  - internal/listener bail seam 仅策略行可用，其余行注册即红灯。
  - 监听器粒度永不做（无稳定 id）。
  - 治理面不按 Agent 细分——细分归 agentGate facet，两层不混。
- 新增服务名前查 README 总表防撞；浏览器侧 ClientContext 投影板加 Board 后缀避让。

## 框架反模式

- 集中式契约包（契约归属 owning package）。
- 事件在非 owning 包声明合并。
- 跨域越权写文件。
- waterfall 实现拦截前读载体字段（改写失效）。
- 在 emit 上收返回值 / 用 waterfall 做纯广播。
- 自建工具可见性判定——单源 capabilitySetOf / toolAllowedFor，ac-security 执行复检与之同构，改一处必同步另一处。
- apply 里探测可选服务再注册副作用。
