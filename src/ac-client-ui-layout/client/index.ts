// ============================================================
// ac-client-ui-layout/client/index.ts —— layout 基础件 client 半边
//（M27 S1 首个基础件 → M27.2-2 出包之七：自 webui
// clients/base/layout.ts 迁入升行包——基础七件收官）
//
// 「壳也是插件」（D19/D11）：layout 件职责：
//   · 占据 root 席位（出厂装配，D3——封印后动态抢占被拒）；
//   · 声明四 seat：sidebar / list-panel / main / overlay（§0.2）+
//     main:perspective 视角专座 + sidebar:plugin-actions（D13 别名，
//     sidebar-action 旧缝的公开席位）；
//   · AppFrame = 原 App.vue 骨架（DOM/样式零改动，D23 视觉基线锁零
//     回归）——overlay 件（文件预览/建群/用量/版本）与主区件（视角
//     容器/运行矩阵/工作区树）随件走。
// 卸载本件 = root 席位消亡 → 渲染面给出可诊断报错，宿主不残废。
// ============================================================
import AppFrame from './AppFrame.vue';
import { clientPlugin } from 'ac-client-runtime';

// SlotMap 类型化声明（S1.5-1）：layout 基础件拥有的席位词表
declare module 'ac-client-slots' {
  interface SlotMap {
    /** 应用根席位（出厂占用，D3） */
    root: { kind: 'single' };
    /** 活动栏席位 */
    sidebar: { kind: 'list' };
    /** 列表面板席位 */
    'list-panel': { kind: 'list' };
    /** 主区席位 */
    main: { kind: 'list' };
    /** 全局覆盖层席位 */
    overlay: { kind: 'list' };
    /** 视角专座（★perspective 别名，D13） */
    'main:perspective': { kind: 'list' };
    /** 侧边栏插件动作位（★sidebar-action 别名，D13） */
    'sidebar:plugin-actions': { kind: 'list' };
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

    // ── 四 seat（§0.2 视图树即 slot 树）──
    ctx.slots.declare({
      key: 'sidebar',
      kind: 'list',
      description: '活动栏席位（Sidebar 宿主 + sidebar:* 贡献）',
      ownerProps: {
        // slot-tree §5.3 z-index 配额：插件浮层禁自选高位，宿主按 seat 声明发配额
        zIndexQuota: { menu: 9999 },
      },
    });
    ctx.slots.declare({
      key: 'list-panel',
      kind: 'list',
      description: '列表面板席位（agents/sessions/tracking 三面板壳 + 域贡献）',
      ownerProps: {
        // §5.7 移动端行为继承：替换型必须继承「≤768px 左抽屉 +
        // sidebar-mobile-visible + closeSidebar inject」模式（替换型的最大隐性成本）
        mobileBehavior: 'left-drawer',
        // §5.4 行点击导航语义宿主所有：装饰型附着必须 click.stop 且不触发列表重排
        rowNavigation: 'host-owned',
      },
    });
    ctx.slots.declare({
      key: 'main',
      kind: 'list',
      description: '主区席位（视角专座容器 + 工作区分屏）',
      ownerProps: { mobileBehavior: 'workspace-overlay' },
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
      public: true,
      description: '视角专座（main:perspective = perspective 别名，D13；active 谓词选举在 PerspectiveHost）',
      ownerProps: {
        // §5.10：只读上下文（pair 视角）的 slot 需携带 readonly 声明
        readonlyContextAllowed: true,
      },
    });
    // sidebar-action 旧缝的公开席位（★D13 别名；宿主钉位：主题与全局设置之间）
    ctx.slots.declare({
      key: 'sidebar:plugin-actions',
      kind: 'list',
      public: true,
      description: '侧边栏插件动作位（sidebar:plugin-actions = sidebar-action 别名，D13）',
    });
  },
});

export default layoutClientPlugin;
