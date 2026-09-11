// ============================================================
// ac-client-ui-settings/client/index.ts —— settings 基础件
// client 半边（M27.2-1 webui 内插件化 → M27.2-2 出包之六）
//
// 职责（ownership §3.2 落点；席位自 hostLedger 代持转正——M27.2-1）：
//   · SettingsPanel 壳+左树+保存编排（overlay 席位出厂贡献——
//     SettingsOverlayHost 绑线经 ui store 直连）；
//   · settings:main-view / agent-pane:tab 两席位声明（★settings-tab:
//     global / settings-tab:agent 别名，D13——第三方 manifest ui.slots
//     可声明的公开子集；解析面 extensionTabs.ts、注册面 bridge 留
//     webui core/extensions）。
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
    /**
     * 设置节选举席（M28 P2 + 2026-11 左树数据化）
     *
     * 贡献 meta 契约：{ section: 选举键（selectedNode 匹配）,
     * label: 左树叶词条 } + 顶层 order（叶序轴，升序稳定）。左树叶与
     * 右区内容同席派生（sectionTree.ts）——一节一叶同源，行装卸叶/节
     * 同步退场。出厂贡献：模型管理 ← ui-llm-pool、搜索引擎 ←
     * ui-search-pool、插件库 ← ui-plugin-registry、Agent 设置 ←
     * ui-agents、全局定时 ← ui-timer；无贡献 = 内容区空态；M30 D1
     * elect 扶正
     */
    'settings:section': { kind: 'list'; elect: true };
  }
}

/** settings 基础件 client 半边插件（boot graph base 阶段装载；宿主半边见 src/index.ts） */
export const settingsClientPlugin = clientPlugin({
  name: 'ac-client-ui-settings.client',
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
    // 设置节选举席（M28 P2 + 2026-11 左树数据化）：域行大件节贡献登记处
    // ——SettingsPanel 按 selectedNode 对 meta.section 选举渲染（不经
    // settings:main-view outlet，防叠加；M30 D1），左树平铺叶自贡献
    // meta.label/order 派生（sectionTree.ts）——一节一叶同源，行卸载
    // 整枝退场
    ctx.slots.declare({
      key: 'settings:section',
      kind: 'list',
      elect: true,
      description: '设置节选举席（SettingsPanel 按 selectedNode × meta.section 选举渲染；左树叶自贡献 meta.label + 顶层 order 派生——一节一叶同源，行装卸叶/节同步退场；M28 P2 / M30 D1 / 2026-11 左树数据化）',
      ownerProps: { noExtraTogglePath: true },
    });
    // 设置面板出厂贡献（overlay 席位——原 AppFrame 内联内容）
    ctx.slots.register('overlay', {
      id: 'webui-base-settings.panel',
      component: SettingsOverlayHost,
    });
  },
});

export default settingsClientPlugin;
