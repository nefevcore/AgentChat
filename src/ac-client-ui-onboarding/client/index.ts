// ============================================================
// ac-client-ui-onboarding/client/index.ts —— 首启向导 client 半边
//
// 贡献面：
//   · overlay 席位（order 98——版本〔97〕之后、设置〔100〕之前，
//     plan §2.3）。宿主组件 WizardOverlay 常驻（v-if 控开合）——
//     首启判定与 boot-ready 监听在组件内，行装载即具备触发能力。
//   · activity-bar:more-menu 数据席位（cr-301）：「新手引导」菜单项
//     ——重播入口（plan §3.5/D6，不放设置面板）。行卸载 → 菜单项
//     随 fiber 消失，不残留。
// ============================================================
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { defineAsyncComponent } from 'vue';
import { openOnboarding } from './onboardingBus.ts';

// 向导壳（异步：node 环境消费本模块不求值 .vue 视图链）
const WizardOverlayAsync = defineAsyncComponent(() => import('./WizardOverlay.vue'));

// 重播通道再导出（菜单项消费面）
export { openOnboarding } from './onboardingBus.ts';

/** 首启向导 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const onboardingClientPlugin = clientPlugin({
  name: 'ac-client-ui-onboarding.client',
  inject: ['slots'],
  apply(ctx: ClientContext) {
    ctx.slots.inject('overlay', () =>
      ctx.slots.register('overlay', {
        id: 'webui-domain-onboarding.wizard',
        component: WizardOverlayAsync,
        order: 98,
      }),
    );
    // 重播入口（更多菜单「新手引导」——重置到第 1 步打开向导）
    ctx.slots.inject('activity-bar:more-menu', () =>
      ctx.slots.register('activity-bar:more-menu', {
        id: 'onboarding',
        order: 10,
        meta: {
          def: {
            id: 'onboarding',
            label: '新手引导',
            icon: 'sparkles',
            onClick: openOnboarding,
          },
        },
      }),
    );
  },
});

export default onboardingClientPlugin;
