// ============================================================
// webui/src/clients/base/settings.ts —— settings 基础件
//（M27.2-1：基础七件之七——先 webui 内插件化，出包随 M27.2-2）
//
// 职责（ownership §3.2 落点；席位自 hostLedger 代持转正——M27.2-1）：
//   · SettingsPanel 壳+左树+保存编排（overlay 席位出厂贡献——
//     SettingsOverlayHost 绑线经 ui store 直连）；
//   · settings:main-view / agent-pane:tab 两席位声明（★settings-tab:
//     global / settings-tab:agent 别名，D13——第三方 manifest ui.slots
//     可声明的公开子集）。
//
// 可摘除性（D19）：卸载本件 = 设置面板出厂贡献消失 + 两席位声明回收
// → 设置入口空态（ui.openGlobalSettings 无消费面），宿主不残废。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import SettingsOverlayHost from './SettingsOverlayHost.vue';

// SlotMap 类型化声明：settings 基础件拥有的席位词表（自 hostLedger 转正）
declare module 'ac-client-slots' {
  interface SlotMap {
    /** 全局设置页签（★settings-tab:global 别名） */
    'settings:main-view': { kind: 'list'; props: { globalConfig?: unknown } };
    /** Agent 编辑页页签（★settings-tab:agent 别名；base props = agentId/raw/effective/emit） */
    'agent-pane:tab': { kind: 'list'; props: { agentId?: string } };
  }
}

/** settings 基础件（装配序列第③步尾——overlay 席位声明后的出厂贡献） */
export const settingsBasePlugin = clientPlugin({
  name: 'webui-base-settings',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    // 全局设置页签（★settings-tab:global 别名；原 hostLedger 代持声明原样迁入）
    ctx.slots.declare({
      key: 'settings:main-view',
      kind: 'list',
      public: true,
      description: '全局设置页签（settings:main-view = settings-tab:global 别名，D13）',
      ownerProps: {
        // §5.9 启停两层分家不可绕开：任何 card-actions 类 slot 不得提供
        // 第四条启停路径（强制停用=插件目录 / 软停用=全局默认层 / 差异层=Agent ext）
        noExtraTogglePath: true,
      },
    });
    // Agent 设置页签（★settings-tab:agent 别名）
    ctx.slots.declare({
      key: 'agent-pane:tab',
      kind: 'list',
      public: true,
      description: 'Agent 编辑页页签（agent-pane:tab = settings-tab:agent 别名，D13）',
      ownerProps: { noExtraTogglePath: true },
    });
    // 设置面板出厂贡献（overlay 席位——原 AppFrame 内联内容）
    ctx.slots.register('overlay', {
      id: 'webui-base-settings.panel',
      component: SettingsOverlayHost,
    });
  },
});
