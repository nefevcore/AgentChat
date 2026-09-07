// ============================================================
// webui/src/runtime/slots-demo.ts —— S0 验收 demo 页（M27 §2-S0）
//
// 纯 slot 装配玩具界面：root 由 slot 装配（被玩具 layout 基础件出厂
// 占据），含一个插件贡献位 + 宿主内置项的同轴 order 演示。
// 临时入口：main.ts 按 ?slots-demo 查询参分流；S1 起主应用切换到
// 同款装配序列（本文件退役为 S0 验收存档）。
//
// 装配序列与 §0.1 对齐：① await createClient → ② install(vueRenderer) →
// ③ 基础插件（玩具 layout 件）+ 出厂封印 → ④ 域插件（玩具）→ ⑥ mount。
// 插件一律对象形态 + inject 声明（D6：依赖一律 inject，不用行序/时序）。
// ============================================================
import { createApp, defineComponent, h } from 'vue';
import { CLIENT_CONTEXT_KEY, createClient, clientPlugin, type ClientContext } from 'ac-client-runtime';
import SlotOutlet from '../components/SlotOutlet.vue';
import { SlotOutletItem } from '../components/SlotOutletItem';
import { createVueRenderer, type VueSlotRenderer } from './vueRenderer';

// ---- 玩具 layout 基础件（占 root + 声明两个 seat） ----

const DemoAppFrame = defineComponent({
  name: 'DemoAppFrame',
  setup() {
    return () =>
      h('div', { class: 'slots-demo' }, [
        h('header', { class: 'slots-demo-header' }, [
          h('h1', null, 'Slot Demo · root 即 slot（M27 S0）'),
          // D16-① 演示：宿主内置项也走同轴 order（order 50，居两个插件钮之间）
          h(
            SlotOutlet,
            { name: 'demo:toolbar', data: { where: 'header' } },
            {
              default: () => [
                h(SlotOutletItem, { order: 50 }, () => h('button', { class: 'demo-btn demo-btn--host' }, '宿主内置钮 (order 50)')),
              ],
            },
          ),
        ]),
        h('main', { class: 'slots-demo-main' }, [
          h('p', null, 'root 席位被玩具 layout 基础件出厂占据；工具条席位 = 宿主内置项 + 插件贡献同轴合并。'),
          h('p', null, '点击「卸载 demo-greeter」→ 其 fiber dispose → 全部贡献自动级联回收（D5）。'),
        ]),
        h('footer', { class: 'slots-demo-footer' }, [h(SlotOutlet, { name: 'demo:status' })]),
      ]);
  },
});

const DemoPluginButton = defineComponent({
  name: 'DemoPluginButton',
  props: {
    data: { type: null, default: undefined },
    label: { type: String, default: '插件贡献' },
  },
  setup(props) {
    return () => h('button', { class: 'demo-btn demo-btn--plugin' }, props.label);
  },
});

const DemoStatusLine = defineComponent({
  name: 'DemoStatusLine',
  props: {
    source: { type: String, default: '' },
  },
  setup(props) {
    return () => h('span', { class: 'demo-status' }, `status ← ${props.source}`);
  },
});

const DemoUnloadButton = defineComponent({
  name: 'DemoUnloadButton',
  setup() {
    return () =>
      h(
        'button',
        {
          class: 'demo-btn demo-btn--unload',
          onClick: () => {
            void unloadGreeter();
          },
        },
        '卸载 demo-greeter（级联回收演示）',
      );
  },
});

// ---- 装配（与 mount 分离：node 单测可跑） ----

let greeterFiber: { dispose: () => Promise<void> } | undefined;

async function unloadGreeter(): Promise<void> {
  await greeterFiber?.dispose();
  greeterFiber = undefined;
}

export async function assembleSlotsDemo(ctx: ClientContext): Promise<VueSlotRenderer> {
  // ② install(vueRenderer)——boot-once 唯一渲染器安装口
  const renderer = createVueRenderer(ctx);
  ctx.slots.install(renderer);
  // ③ 基础插件集合（玩具版：单 layout 件）——占 root + 声明 seat
  const layout = ctx.plugin(clientPlugin({
    name: 'demo-layout',
    inject: ['slots'],
    apply(c) {
      c.slots.declare({ key: 'root', kind: 'single', factory: true, description: '应用根席位（出厂占用，M27 D3）' });
      c.slots.register('root', { id: 'demo-layout.app-frame', component: DemoAppFrame, order: 0 });
      c.slots.declare({ key: 'demo:toolbar', kind: 'list', description: '头部工具条贡献位' });
      c.slots.declare({ key: 'demo:status', kind: 'list', public: true, description: '页脚状态行贡献位' });
    },
  }));
  await layout;
  // 出厂封印：此后 root 动态注册一律拒绝（D3）
  ctx.slots.sealFactory();
  // ④ 域插件（玩具版）：向既有 seat 贡献
  greeterFiber = ctx.plugin(clientPlugin({
    name: 'demo-greeter',
    inject: ['slots'],
    apply(c) {
      c.slots.register('demo:toolbar', {
        id: 'demo-greeter.btn-early',
        component: DemoPluginButton,
        order: 20,
        props: { label: '插件钮 (order 20)' },
      });
      c.slots.register('demo:toolbar', {
        id: 'demo-greeter.btn-late',
        component: DemoPluginButton,
        order: 120,
        props: (data) => ({ label: `插件尾钮 (order 120, where=${String((data as { where?: string })?.where ?? '?')})` }),
      });
      c.slots.register('demo:toolbar', { id: 'demo-greeter.unload', component: DemoUnloadButton, order: 200 });
      c.slots.register('demo:status', { id: 'demo-greeter.status', component: DemoStatusLine, props: { source: 'demo-greeter 插件' } });
    },
  }));
  await greeterFiber;
  return renderer;
}

/** mount：?slots-demo 查询参入口（main.ts 分流） */
export async function mountSlotsDemo(selector: string): Promise<void> {
  const ctx = await createClient(); // ①
  const renderer = await assembleSlotsDemo(ctx); // ②③④（含封印）
  // ⑥ app.mount(renderSlot('root'))——唯一 ctx 级渲染入口
  const app = createApp({
    name: 'AcSlotsDemoRoot',
    render: () => renderer.renderSlot('root'),
  });
  app.provide(CLIENT_CONTEXT_KEY, ctx);
  app.mount(selector);
}
