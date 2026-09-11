// ============================================================
// ac-client-ui-layout/client/index.ts —— layout 基础件 client 半边
//（M27 S1 首个基础件 → M27.2-2 出包之七：自 webui
// clients/base/layout.ts 迁入升行包——基础七件收官）
//
// 「壳也是插件」（D19/D11）：layout 件职责：
//   · 占据 root 席位（出厂装配，D3——封印后动态抢占被拒）；
//   · 声明页面骨架 seat：activity-bar / primary-sidebar / main /
//     aux-sidebar / overlay（§0.2）+ menu-bar/bottom-panel/status-bar
//     三预留席 + main:perspective 视角专座 + activity-bar:plugin-actions
//     （D13 别名，sidebar-action 旧缝的公开席位）；
//   · AppFrame = 原 App.vue 骨架（DOM/样式零改动，D23 视觉基线锁零
//     回归）——overlay 件（文件预览/建群/用量/版本）与主区件（视角
//     容器/运行矩阵/工作区树）随件走。main = keyed 选举「主区视图」
//     多选一（MainViewHost 解析——2026-11 主区语义纯化，壳零域知识：
//     让位协议随各条目 active() 住 owning 行）。
// 卸载本件 = root 席位消亡 → 渲染面给出可诊断报错，宿主不残废。
// ============================================================
import AppFrame from './AppFrame.vue';
import PerspectiveHost from './PerspectiveHost.vue';
import ActivityBarHost from './ActivityBarHost.vue';
import PrimarySidebarHost from './PrimarySidebarHost.vue';
import { clientPlugin } from 'ac-client-runtime';
import type { MainViewDef } from './mainViews.ts';

// SlotMap 类型化声明（S1.5-1）：layout 基础件拥有的席位词表。
// 页面骨架词汇（2026-11 语义定整——VSCode 布局同款语义）：
//   [menu-bar 顶部菜单栏·预留]
//   [activity-bar 活动栏][primary-sidebar 主侧边栏][main 主面板][aux-sidebar 辅助侧边栏]
//   [bottom-panel 底部面板·预留][status-bar 底部状态栏·预留]
//   overlay = 全局覆盖层（非布局区域）
// 2026-11 归并：ac-client-ui-sidebar 行并入本件（出生史：v0.6.2 L4
// 全量切 src 时自 monolith clients/base/sidebar.ts 原样升包——M28 P2
// 三面板域行贡献化后即退化为「左栏两壳 + uiStore」的骨架性资产，
// 归位壳件；活动栏/主侧边栏宿主 + 布局状态 store 随件迁入）。
declare module 'ac-client-slots' {
  interface SlotMap {
    /** 应用根席位（出厂占用，D3） */
    root: { kind: 'single' };
    /** 活动栏席位（原 sidebar——2026-11 语义定整：VSCode Activity Bar 同款） */
    'activity-bar': { kind: 'list' };
    /** 主侧边栏席位（原 list-panel——2026-11 语义定整：VSCode Primary Side Bar 同款） */
    'primary-sidebar': { kind: 'list' };
    /** 主侧边栏域面板选举席（原 list-panel:domain——随区域席改名；PrimarySidebarHost 内选举——贡献携带 meta.panel 键；M28 P0-3；M30 D1 elect 扶正） */
    'primary-sidebar:domain': { kind: 'list'; elect: true };
    /** 主面板席位（keyed 选举多选一——MainViewHost 解析：chat=视角容器兜底 / tracking=运行矩阵 / …；2026-11 主区语义纯化，原 main:tracking 专座收编） */
    main: { kind: 'list'; elect: true };
    /** 辅助侧边栏席位（原 aside——2026-11 语义定整：keyed 选举「选区」多选一，AuxSidebarHost 解析；工作区是众多选区之一，NULL 扩展位与各选区同级） */
    'aux-sidebar': { kind: 'list'; elect: true };
    /** 全局覆盖层席位 */
    overlay: { kind: 'list' };
    /** 顶部菜单栏席位（2026-11 预留——骨架词汇定整；无 outlet，实现时壳重构顶部布局） */
    'menu-bar': { kind: 'list' };
    /** 底部面板席位（2026-11 预留——VSCode Panel 同款；无 outlet，实现时壳重构底部布局） */
    'bottom-panel': { kind: 'list' };
    /** 底部状态栏席位（2026-11 预留——VSCode Status Bar 同款；无 outlet，实现时壳重构底部布局） */
    'status-bar': { kind: 'list' };
    /** 视角专座（★perspective 别名，D13；keyed 选举——PerspectiveHost 解析，M30 D1） */
    'main:perspective': { kind: 'list'; elect: true };
    /** 活动栏插件动作位（★sidebar-action 别名，D13；数据席位——宿主渲染按钮，M30 D2。第一段 = 宿主件 ActivityBar 组件〔D5——2026-11 组件与席键同步改名；第三方 manifest 词汇 = 旧轨 sidebar-action，经 slotCatalog 归一不变〕） */
    'activity-bar:plugin-actions': { kind: 'list'; data: true };
  }
}

/** layout 基础件 client 半边插件（boot graph base 阶段装载；宿主半边见 src/index.ts） */
export const layoutClientPlugin = clientPlugin({
  name: 'ac-client-ui-layout.client',
  inject: ['slots'],
  apply(ctx) {
    // ── root 单席位（D3）：出厂占用，封印后动态注册一律拒绝 ──
    ctx.slots.declare({
      key: 'root',
      kind: 'single',
      factory: true,
      description: '应用根席位（layout 基础件出厂占用——M27 D3）',
    });
    ctx.slots.register('root', { id: 'webui-base-layout.app-frame', component: AppFrame, order: 0 });

    // ── 布局区域 seat（§0.2 视图树即 slot 树；2026-11 语义定整命名）──
    ctx.slots.declare({
      key: 'activity-bar',
      kind: 'list',
      description: '活动栏席位（VSCode Activity Bar 同款——ActivityBarHost 宿主 + 活动栏贡献）',
      ownerProps: {
        // slot-tree §5.3 z-index 配额：插件浮层禁自选高位，宿主按 seat 声明发配额
        zIndexQuota: { menu: 9999 },
      },
    });
    ctx.slots.declare({
      key: 'primary-sidebar',
      kind: 'list',
      description: '主侧边栏席位（VSCode Primary Side Bar 同款——三面板壳 + 域贡献）',
      ownerProps: {
        // §5.7 移动端行为继承：替换型必须继承「≤768px 左抽屉 +
        // sidebar-mobile-visible + closeSidebar inject」模式（替换型的最大隐性成本）
        mobileBehavior: 'left-drawer',
        // §5.4 行点击导航语义宿主所有：装饰型附着必须 click.stop 且不触发列表重排
        rowNavigation: 'host-owned',
      },
    });
    // 主区视图席位（2026-11 主区语义纯化：keyed 选举多选一——原
    // 「main 容器 + main:tracking 专座 + 壳内让位协议」收编为单一选举
    // 轴）：条目 = 主区视图 def（active 谓词 × order 选举，MainViewHost
    // 解析；keepAlive 旗标定生命周期——chat 文档流保活 / 其余 volatile）。
    // 让位协议随 active() 住 owning 行——壳零域知识；条目缺席（行卸载）
    // → 非候选 → 兜底 chat 直显（壳不残废，内在于选举）
    ctx.slots.declare({
      key: 'main',
      kind: 'list',
      elect: true,
      description: '主面板席位（keyed 选举多选一——MainViewHost 按 active × order 选举：chat=视角容器兜底(100) / tracking=运行矩阵(50) / …；keepAlive 条目文档流保活，volatile 条目随选举挂卸）',
    });
    // 辅助侧边栏席位（2026-11 语义定整·层级修正：席位 = 第四区域本身
    // ——VSCode Auxiliary Side Bar 同款；「工作区」= 众多选区之一，NULL
    // 扩展位与各选区同级）：条目 = 选区 def（active × order 选举，
    // AuxSidebarHost 解析；rail 收起态把手资产随条目声明——域行供，壳零域
    // 文案知识；选区缺省 volatile——区域收起即卸载）。选区缺席（行
    // 卸载）→ 区域整体消失（rail/分屏一并不渲染——占用门控内在于
    // 选举，壳不残废）
    ctx.slots.declare({
      key: 'aux-sidebar',
      kind: 'list',
      elect: true,
      description: '辅助侧边栏席位（VSCode Auxiliary Side Bar 同款——keyed 选举「选区」多选一：workspace=工作区树 / …；AuxSidebarHost 按 active × order 选举，rail 收起态资产随条目声明；选区缺席 → 区域整体消失）',
      ownerProps: { mobileBehavior: 'workspace-overlay' },
    });
    // ── 骨架预留席（2026-11 语义定整：页面骨架词汇补全——declare 占名
    //    即预留〔fail-closed 注册面就绪〕；无 outlet/无布局行——实现时
    //    壳重构顶部/底部布局后开口，贡献面按届时裁决）──
    ctx.slots.declare({
      key: 'menu-bar',
      kind: 'list',
      description: '顶部菜单栏席位（骨架预留——VSCode Menu Bar 同款；实现时壳重构顶部布局后开口）',
    });
    ctx.slots.declare({
      key: 'bottom-panel',
      kind: 'list',
      description: '底部面板席位（骨架预留——VSCode Panel 同款：终端/输出/问题类多页签容器；实现时壳重构底部布局后开口）',
    });
    ctx.slots.declare({
      key: 'status-bar',
      kind: 'list',
      description: '底部状态栏席位（骨架预留——VSCode Status Bar 同款：状态项追加型；实现时壳重构底部布局后开口）',
    });
    ctx.slots.declare({
      key: 'overlay',
      kind: 'list',
      description: '全局覆盖层席位（弹窗与各域覆盖层）',
      ownerProps: {
        // §5.3 z-index 配额秩序（现状阶梯进配额表；插件弹窗/浮层禁自选高位）
        zIndexQuota: { modal: 1200, installConfirm: 1250, governance: 1280, entryPicker: 1300 },
        // §5.2 弹窗骨架四态回落（loading/error/empty/content）
        fourStateFallback: true,
        // §5.8 命令式通道保留（ask()/open()/定位参数——slot 化不破坏等价协议）
        imperativeChannels: ['ask', 'open', 'locate'],
      },
    });
    // 视角专座（★perspective 收编目标：PerspectiveHost 宿主，D9 于 S2 升 keyed 选举）
    ctx.slots.declare({
      key: 'main:perspective',
      kind: 'list',
      elect: true,
      public: true,
      description: '视角专座（main:perspective = perspective 别名，D13；active 谓词选举在 PerspectiveHost——keyed 选举席 M30 D1）',
      ownerProps: {
        // §5.10：只读上下文（pair 视角）的 slot 需携带 readonly 声明
        readonlyContextAllowed: true,
      },
    });
    // sidebar-action 旧缝的公开席位（★D13 别名；宿主钉位：主题与全局设置之间）
    ctx.slots.declare({
      key: 'activity-bar:plugin-actions',
      kind: 'list',
      data: true,
      public: true,
      description: '活动栏插件动作位（activity-bar:plugin-actions = sidebar-action 别名，D13；数据席位——ActivityBarHost 渲染按钮、贡献供 meta.def，M30 D2；2026-11 席键随区域席/宿主件同步改名，第三方 manifest 旧轨词汇经 slotCatalog 归一不变）',
    });

    // ── main 席位宿主条目（M30 D4 条目化 + 2026-11 主区语义纯化）：
    //    chat = 恒真兜底主区视图（order 100——覆盖类视图居前赢选举），
    //    组件仍是 PerspectiveHost（视角容器——内部经 main:perspective
    //    选举会话视角 pair/talk/group/single）。keepAlive = true：文档流
    //    保活（会话视图局部态〔草稿/滚动跟随/卡片展开〕不因主区视图
    //    切换丢失——机制裁决见 MainViewHost）。注册置于全部 declare 之后
    //    （fail-closed）；条目化副产 = EntryErrorBoundary 崩溃隔离 +
    //    wrapComponent fiber 对齐（S1.5-5/D17）。 ──
    ctx.slots.register('main', {
      id: 'webui-base-layout.perspective-host',
      component: PerspectiveHost,
      order: 100,
      meta: {
        def: {
          id: 'chat', order: 100, keepAlive: true,
          active: () => true,
          component: PerspectiveHost,
        } satisfies MainViewDef,
      },
    });

    // ── 左侧导航区宿主贡献（2026-11 归并自 ac-client-ui-sidebar 行——
    //    注册置于全部 declare 之后〔fail-closed：原行在 layout 之后装载
    //    天然满足时序，归并后须显式后置〕）：活动栏 + 主侧边栏两壳随
    //    壳件走，域内容（agents/sessions/tracking 面板）仍是各域行的
    //    primary-sidebar:domain 选举贡献 ──
    ctx.slots.register('activity-bar', {
      id: 'webui-base-layout.activity-bar',
      component: ActivityBarHost,
    });
    ctx.slots.register('primary-sidebar', {
      id: 'webui-base-layout.primary-sidebar',
      component: PrimarySidebarHost,
    });
    // 域面板选举席（M28 P0-3）：域行面板贡献登记处——壳按 ui.primaryPanel
    // 对 meta.panel 选举（不经外层 primary-sidebar outlet 渲染，防叠加；M30 D1）
    ctx.slots.declare({
      key: 'primary-sidebar:domain',
      kind: 'list',
      elect: true,
      description: '主侧边栏域面板选举席（PrimarySidebarHost 按 ui.primaryPanel × meta.panel 选举渲染；贡献 = 各域行面板，M28 P0-3；keyed 选举席 M30 D1）',
      ownerProps: {
        // §5.7 移动端行为继承（同 primary-sidebar 席位：左抽屉模式）
        mobileBehavior: 'left-drawer',
        // §5.4 行点击导航语义宿主所有
        rowNavigation: 'host-owned',
      },
    });
  },
});

export default layoutClientPlugin;
