# Koishi Console 客户端实现研究（M27 参照系增补）

> 对象：[koishijs/webui](https://github.com/koishijs/webui)（@koishijs/client +
> @koishijs/plugin-console，main 分支实读）与[官方文档·控制台章节](https://koishi.chat/zh-CN/guide/console/client)。
> 动机：Koishi 是 cordis 生态的全插件化 WebUI 成熟先例（6k+ star、数百控制台
> 插件的市场生态），与 M27「root 即 slot」直接同题。本文记录实证发现、
> 与 DSH 参照系的差异、以及对 M27 的具体采纳建议。**只读研究，无代码改动。**

---

## 1. 架构实证（源码级）

### 1.1 客户端就是 cordis（`packages/client/client/context.ts`）

```ts
export class Context extends cordis.Context {
  constructor() {
    super()
    this.app = createApp(defineComponent({
      setup: () => () => [
        h(resolveComponent('k-slot'), { name: 'root', single: true }),   // ← root 即 slot
        h(resolveComponent('k-slot'), { name: 'global' }),               // ← 全局覆盖层 slot
      ],
    }))
    this.app.provide('cordis', this)
    this.plugin(ActionService) /* + I18n/Loader/Router/Setting/Theme 六内置服务 */
    this.on('ready', async () => { /* 等 loader.initTask → mount('#app') */ })
  }
}
```

- **「root 即 slot」是既成事实**：整个应用的根组件 = 两个 `<k-slot>`。
  连布局壳都不是宿主——`packages/client/app/{home,layout,settings,status,
  theme}/` 各是一个**基础插件**（基础 app 由插件拼装，同 DSH 结论）。
- **`useContext()` 组件级 fork**：`inject('cordis') → parent.plugin(() => {})
  → onBeforeUnmount(fork.dispose)`——**组件生命周期 = fiber 生命周期**，
  组件内注册的一切 effect 随组件卸载回收。
- **`wrapComponent`**：外部贡献组件包一层 `provide('cordis', ctx)`——
  保证插件组件树内拿到的是该插件的隔离 ctx（Vue 树与 fiber 树的桥）。
- `addEventListener` 也走 `ctx.effect`——DOM 监听随插件卸载回收。

### 1.2 slot 机制 = 一个组件 + 一个注册表（~80 行，`components/slot.ts` + `plugins/router.ts`）

```ts
// 注册面（RouterService）：views: reactive<Dict<SlotOptions[]>>
slot(options: SlotOptions) {
  return this.ctx.effect(() => {        // ← 注册即归属：fiber 卸载自动回收
    const list = this.views[options.type] ||= []
    insert(list, options)
    return () => remove(list, options)
  })
}
// 渲染面（KSlot）：模板内部 + 外部贡献 同轴合并
const internal = [...slots.default?.() || []].filter(node => node.type === KSlotItem)
  .map(node => ({ node, order: node.props?.order || 0 }))
const external = [...ctx.$router.views[props.name] || []]
  .filter(item => !item.disabled?.())
  .map(item => ({ node: h(item.component, { ...props.data }, slots), order: item.order }))
// order 降序统一排序；single 取 children[0] ?? slots.default?.()  ← 未填充回落模板默认插槽
```

三个关键设计：

1. **内外同轴竞争**：宿主模板内容（`<k-slot-item order>`）与插件贡献用
   **同一个 order 轴**排序——宿主默认内容不是「要么在要么被换」，而是
   可被插件**排到前面/后面**。
2. **single + 默认插槽 fallback**：替换型 slot 未被填充时回落 Vue 默认
   插槽（宿主默认渲染）——「未填充回落宿主默认」的最优雅实现。
3. `ctx.slot({ type, component, order, disabled })`；`k-layout`/`k-status`
   只是预命名的 single slot 组件；**任意页面可用 `<k-slot name="custom">`
   自开插口**供他插件注入（文档明示）。

### 1.3 页面/活动门控三件套（`plugins/router.ts` · Activity）

```ts
disabled() {
  if (this.ctx.bail('activity', this)) return true          // ① 事件化权限（默认拒绝）
  if (!this.fields.every(key => store[key])) return true    // ② 数据就绪门控
  if (this.when && !this.when()) return true                // ③ 自定义条件
}
dispose() { /* 卸载时若当前页被摘：redirectTo 记住原路径 → 回 home */ }
```

- 入口处一行实现 **fail-closed**：`root.on('activity', data => !data)`
  （默认禁用一切页面，auth 插件按登录态放行——权限的默认拒绝）。
- **`fields` 声明式数据依赖**：页面声明 `fields: ['custom']`，数据服务
  未就绪则页面自动隐藏——数据订阅与页面门控合一。
- 卸载导航语义：贡献被 dispose 时若正在浏览，记住 fullPath，回到 home，
  重装后恢复（redirectTo + 首导航等待 `$loader.initTask` 再 resolve）。

### 1.4 装载（`plugins/loader.ts`）

- `store.entry`（服务端 EntryProvider 推送的清单：`{files: url[], paths,
  data}`）watch-diff：消失 → `scope.dispose()`（每个扩展挂在
  `ctx.isolate('extension')` **隔离作用域**上）；新增 → 逐 file 动态加载
  （`.css` → link，`.js` → `import()` → `ctx.plugin(unwrapExports(exports),
  ctx.extension.data)`——**插件配置数据从服务端传入 plugin 第二参**）。
- `entry-data` 帧：服务端热更单插件 config → 扩展 data ref 更新（配置热更）。
- backend 实例 id（`entry._id`）变化 → `location.reload()`（后端重启检测）。

### 1.5 数据层（`client/data.ts` + `console/src/{index,service}.ts`）

- **服务端声明即客户端类型**：`store: Store = {[K in keyof
  Console.Services]?: ...}`——DataService 键的 declare module 合并直接
  派生前端 store 类型（类型层零手工同步）。
- `DataService<T> extends Service`（服务名 `console.services.<key>`）：
  `refresh()` 广播 `data` 帧——**body 可为函数、per-client 惰性求值**
  （每个连接拿到按自身权限定制的数据）；`patch()` 广播增量帧（数组
  push / 对象 assign）。推送侧可挂 `authority`。
- `broadcast` 前经 `ctx.serial('console/intercept', client, options)`——
  **每次推送可被拦截**（权限过滤在推送面而非订阅面）。
- WS 入帧：`listeners[type]` 之外还 `ctx.emit(type, body)`——**线帧直接
  进 cordis 事件总线**，插件用普通 `ctx.on` 消费帧。
- RPC：`send(type, ...args)` 60s 超时；断线 → **清空 store 全部键** →
  重连成功 → `location.reload()`（一致性靠重载，简单粗暴但零漂移）。

### 1.6 双半边包形态（`plugins/<name>/`）

每个控制台插件 = `src/`（服务端半边）+ `client/`（浏览器半边，**源码
目录**）同包；peerDep `@koishijs/plugin-console` + devDep
`@koishijs/client`。服务端 `ctx.console.addEntry({ dev: resolve(__dirname,
'../client/index.ts'), prod: resolve(__dirname, '../dist') })`——**dev 期
直服 client 源码**（vite 按需转译），prod 服预构建 dist。

### 1.7 其余面（文档 + 源码确认）

- **动作/菜单**（`plugins/action.ts`）：`ctx.action(id, {disabled, action})`
  全局唯一动作标识符（如 `explorer.save`）+ `ctx.menu(id, items)` 声明
  菜单引用动作 + `useMenu()` 组合式触发——操作与入口解耦。
- **主题**（`plugins/theme.ts`）：`ctx.theme({id: '*-dark|*-light', name,
  components})`——**布局组件可被主题整体替换**（id 后缀约束明暗）。
- **用户设置**（`plugins/setting.ts`）：`ctx.settings({type, schema})` 声明
  式表单（Schema 驱动，同插件配置管线），与插件配置（管理员）分离。

## 2. 三方对照（Koishi vs DSH vs AgentChat M27 现方案）

| 维度 | Koishi | DSH | AgentChat M27（现方案） |
|---|---|---|---|
| 客户端运行时 | 真 cordis（Context 子类） | 真 cordis（client-runner） | 计划同（vendor cordis） |
| root | `<k-slot name=root single>` + `global` | root 单席位被 ui-layout 占 | 计划同 DSH |
| slot 形状 | string key + order + disabled；single/list | SlotMap 类型化 + kind/cell 选举/store 座位/inject | 计划同 DSH |
| 宿主默认内容 | **模板默认插槽 = single fallback + 内外同轴 order** | owner props/贡献声明 | 未明确 → **采纳 Koishi** |
| 页面门控 | bail 事件 + fields 数据就绪 + 卸载导航 | —（会话面不同） | 未明确 → **采纳 Koishi** |
| 数据层 | DataService：声明即类型 + data/patch 帧 + per-client 推送 | SessionRuntime 对象层 + projection | §0.3 三层 → **帧模式可补** |
| 包形态 | **同包双半边**（src/ + client/） | 独立 client-ui 包 | 独立 ac-client-ui-* 包 → **建议改裁 Koishi 形态（D16）** |
| 装载 | entry DataService 推清单 + isolate 作用域 + import() | boot graph（__DSH_BOOT__） | 计划 boot graph → 结构同 Koishi |
| 断线策略 | 清 store + 重载 | — | 未明确 → 可裁 |
| 权限 | 页面/RPC/推送三面 authority + 默认拒绝 | — | 未设计 → **采纳默认拒绝** |

## 3. 对 M27 的采纳建议

### 3.1 直接采纳（写进 M27 的修订）

1. **SlotCore 分级起步**：S0 首版 = Koishi 形态（string key + order +
   single/list + disabled + `ctx.effect` 回收，~200 行含测试）；SlotMap
   类型化、cell 选举、store 座位、inject 面作为**增强级分批**（S0.5/S1
   之间按需）。Koishi 证明朴素形态已能撑起整个生态。
2. **SlotOutlet 语义**：内外同轴 order 合并 + **single 未填充回落默认
   插槽**（宿主默认渲染免写 fallback 分支）+ `data` props 透传 owner
   上下文。
3. **useContext 组件级 fork + wrapComponent**：组件生命周期 = fiber
   生命周期；贡献组件 provide 隔离 ctx。
4. **视角/面板门控三件套**：bail 事件（默认拒绝：入口一行禁用一切、
   由权限面放行）+ `fields` 数据就绪门控 + 卸载导航（redirectTo 记住、
   回 home、重装恢复）——吸收进 `main:perspective` 专座与
   `sidebar:list-panel` 注册项设计。
5. **DataService 帧模式**：M27 §0.3 层③域投影可增配「服务端 DataService
   聚合推送」（data 全量/patch 增量、per-client 惰性求值、推送前
   intercept 事件）——与「谁的数据谁订帧」互补：高频聚合数据由 owning
   服务端行聚合推送，低频详情仍走 RPC。
6. **线帧进事件总线**：ws-bridge 帧在前端转 `ctx.emit`——插件以普通
   `ctx.on` 消费（现 wireRpc.onWireEvent 的 cordis 化）。
7. **断线策略裁决**：清 store + 提示 + 重连后重载（Koishi 式）vs 增量
   重放（DSH 式）——AgentChat 有流式续跑场景，建议混合：活跃会话增量
   重放、其余键清空。

### 3.2 改裁建议（D16，替换 ownership v2 的一处组织决策）

**包形态：行包自带 `client/` 半边（Koishi 形态）替代独立 ac-client-ui-\*
包族（DSH 形态）**：

- ac-* 行包已是独立 workspace 包——再加 `client/` 目录 +
  `"agentchat": { "client": {...} }` 清单（M27 D7 的清单机制原样），
  `./client` 出口，dev 直服源码 / prod 预构建；
- 好处：**~33 个新包的行政成本消失**；行与 UI 版本天然同步；M23 动态
  插件结构与官方插件形态统一（都是「包内 client 半边」）；
- 配对表（ownership §3.3）语义不变，只是物理落点从「新包」改为
  「行包内目录」；纯库行（无 host 侧运行时的）仍可按需独立成
  client-ui 包——两形态并存，D7 清单不区分。
- `ac-client-slots` / `ac-client-runtime` / `@agentchat/webui-kit` 三个
  基建包维持独立（它们是运行时不是行附属）。

### 3.3 不采纳 / 需警惕的点

- **无类型化 slot key**：Koishi 全 string，跨包拼错只能运行时发现——
  M27 D1 的 SlotMap 类型化仍要（作为增强级）。
- **views 注册表 $router 名下混住 slot+page**：路由与插槽共用一个
  service 可读性差——AgentChat 分开（SlotRegistry vs 视角/面板注册）。
- **断线全清 + 重载**：对长流式会话太粗暴（见 3.1-7 的混合裁决）。
- **全局 store 单体**：`store.custom` 模式让所有数据服务平铺在一个
  响应式对象上——与 M27 §0.3 的分层（壳件私有/对象层/域投影）相比
  缺乏域隔离；AgentChat 仅在「服务端 DataService 聚合推送」通道内
  借用其帧协议，不搬其全局单体形态。

## 4. 证据索引（koishijs/webui @ main）

- `packages/client/client/context.ts`（Context/k-slot root/useContext/
  wrapComponent）、`components/slot.ts`（KSlot/KSlotItem/k-layout）、
  `plugins/router.ts`（RouterService/Activity/slot()/page()）、
  `plugins/loader.ts`（isolate 扩展/entry diff/动态 import）、
  `data.ts`（store/send/receive/connect）、`index.ts`（root 实例化 +
  activity 默认拒绝）
- `packages/console/src/index.ts`（Console/EntryProvider/broadcast
  intercept/addListener）、`service.ts`（DataService：refresh/patch/
  per-client get）
- `packages/client/app/{home,layout,settings,status,theme}/`（基础插件集）
- 文档：guide/console/{index,data,client}.html + api/console/context.html
