// ============================================================
// webui/src/clients/base/layout.ts —— layout 基础件（M27 S1 首个基础件）
//
// 「壳也是插件」（D19/D11）：基础七件随 webui 分发、不单独成行，
// 与域插件走同一条 slot 轨道。layout 件职责：
//   · 占据 root 席位（出厂装配，D3——封印后动态抢占被拒）；
//   · 声明四 seat：sidebar / list-panel / main / overlay（§0.2）+
//     main:perspective 视角专座 + sidebar:plugin-actions（D13 别名，
//     sidebar-action 旧缝的公开席位）；
//   · AppFrame = 原 App.vue 骨架原样迁入（DOM/样式零改动，D23 视觉
//     基线锁零回归）。
// 卸载本件 = root 席位消亡 → 渲染面给出可诊断报错（S1 验收演示：
// 「卸载 layout 件 → root 空且有可诊断报错」，宿主不残废）。
// ============================================================
import AppFrame from './AppFrame.vue';
import { clientPlugin } from 'ac-client-runtime';

export const layoutBasePlugin = clientPlugin({
  name: 'webui-base-layout',
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
    ctx.slots.declare({ key: 'sidebar', kind: 'list', description: '活动栏席位（Sidebar 宿主 + sidebar:* 贡献）' });
    ctx.slots.declare({ key: 'list-panel', kind: 'list', description: '列表面板席位（agents/sessions/tracking 三面板壳 + 域贡献）' });
    ctx.slots.declare({ key: 'main', kind: 'list', description: '主区席位（视角专座容器 + 工作区分屏）' });
    ctx.slots.declare({ key: 'overlay', kind: 'list', description: '全局覆盖层席位（弹窗与各域覆盖层）' });
    // 视角专座（★perspective 收编目标：PerspectiveHost 宿主，D9 于 S2 升 keyed 选举）
    ctx.slots.declare({
      key: 'main:perspective',
      kind: 'list',
      public: true,
      description: '视角专座（main:perspective = perspective 别名，D13；active 谓词选举在 PerspectiveHost）',
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
