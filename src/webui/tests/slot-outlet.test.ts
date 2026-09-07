// @vitest-environment jsdom
// ============================================================
// webui/tests/slot-outlet.test.ts —— SlotOutlet 渲染语义单测（M27 S0）
//
// 覆盖（D16/D23-A）：
//   · 内外同轴 order 合并（宿主 SlotOutletItem 与插件贡献同一轴；
//     同 order 宿主居前）
//   · list 多根平铺零包裹（渲染结果无包装 DOM）
//   · single：有贡献 → 首条；无贡献 → 默认插槽原样回落
//   · data props 透传 + 条目 props（对象/工厂）优先
//   · 响应式：register/插件 fiber dispose → DOM 增量更新
//   · 隔离 ctx 包裹：贡献组件内 useContext() 拿到注册方 ctx（D17）
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { CLIENT_CONTEXT_KEY, createClient, clientPlugin, useClientContext, type ClientContext } from 'ac-client-runtime';
import { SlotCoreError } from 'ac-client-slots';
import SlotOutlet from 'ac-client-ui-renderer/client/SlotOutlet.vue';
import { SlotOutletItem } from 'ac-client-ui-renderer/client/SlotOutletItem.ts';

function mountOutlet(ctx: ClientContext, name: string, defaultSlot?: () => ReturnType<typeof h>[]) {
  const host = document.createElement('div');
  const app = createApp({
    render: () =>
      h(SlotOutlet, { name }, defaultSlot ? { default: defaultSlot } : {}),
  });
  app.provide(CLIENT_CONTEXT_KEY, ctx);
  app.mount(host);
  return { host, unmount: () => app.unmount() };
}

const Btn = defineComponent({
  props: { label: { type: String, default: '?' }, data: { type: null, default: undefined } },
  template: '<button class="ext">{{ label }}</button>',
});

/** 记录 useClientContext() 结果的贡献组件（D17 验证用） */
const Probe = defineComponent({
  props: { tag: { type: String, default: 'probe' } },
  setup(props) {
    const ctx = useClientContext();
    return () => h('span', { class: 'probe', 'data-ctx': ctx ? 'yes' : 'no' }, props.tag);
  },
});

/** 子树内经 useClientContext 读「别的域」root 级服务的形态探针
 *（回归锚：wrapComponent 劫持 CLIENT_CONTEXT_KEY 曾使 AppFrame 子树
 * 读 ctx.jobBoard 抛 "without inject" → root 崩溃退位白屏） */
const SubtreeProbe = defineComponent({
  setup() {
    const read = () => {
      try {
        const c = useClientContext();
        // 任意 root 级可解析属性（未提供的服务 = undefined 而非异常）
        return c ? `app-ctx-ok:${String((c as { theme?: unknown }).theme !== 'throw')}` : 'no-ctx';
      } catch {
        return 'threw';
      }
    };
    return () => h('div', { class: 'subtree', 'data-svc': read() }, 'host-content');
  },
});

/** inject ['slots'] 的贡献方插件（D6） */
function contrib(name: string, apply: (c: ClientContext) => void) {
  return clientPlugin({ name, inject: ['slots'], apply });
}

describe('SlotOutlet · 内外同轴 order 合并（D16-①）', () => {
  it('宿主 SlotOutletItem 与外部贡献按同一 order 轴排序；同 order 宿主居前', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:bar', kind: 'list' });
    const fiber = ctx.plugin(contrib('demo-contrib', (c) => {
      c.slots.register('demo:bar', { id: 'late', component: Btn, order: 200, props: { label: 'late' } });
      c.slots.register('demo:bar', { id: 'early', component: Btn, order: 10, props: { label: 'early' } });
      c.slots.register('demo:bar', { id: 'mid', component: Btn, order: 100, props: { label: 'mid' } });
    }));
    await fiber;
    const { host } = mountOutlet(ctx, 'demo:bar', () => [
      h(SlotOutletItem, { order: 100 }, () => h('b', null, 'host@100')), // 与 mid 同 order → 宿主居前
      h(SlotOutletItem, { order: 500 }, () => h('b', null, 'host@500')),
    ]);
    const texts = [...host.querySelectorAll('button, b')].map((n) => n.textContent);
    expect(texts).toEqual(['early', 'host@100', 'mid', 'late', 'host@500']);
  });

  it('未标记的默认插槽内容不参与 list 竞争；未声明席位渲染空', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:list' });
    const fiber = ctx.plugin(contrib('demo-contrib', (c) => {
      c.slots.register('demo:list', { id: 'a', component: Btn, props: { label: 'a' } });
    }));
    await fiber;
    const { host } = mountOutlet(ctx, 'demo:list', () => [h('i', null, 'unmarked')]);
    // 只渲染标记项与外部贡献——未标记内容不进 list 轴
    expect(host.querySelectorAll('button').length).toBe(1);
    expect(host.querySelector('i')).toBeNull();
    await fiber.dispose();
  });
});

describe('SlotOutlet · 零包裹（D23-A）', () => {
  it('多根平铺：Outlet 不引入任何包装节点', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:flat' });
    const fiber = ctx.plugin(contrib('demo-contrib', (c) => {
      c.slots.register('demo:flat', { id: 'a', component: Btn, props: { label: 'a' } });
    }));
    await fiber;
    const { host } = mountOutlet(ctx, 'demo:flat', () => [
      h(SlotOutletItem, () => h('span', null, 's1')),
    ]);
    expect(host.innerHTML).toBe('<span>s1</span><button class="ext">a</button>');
    await fiber.dispose();
  });
});

describe('SlotOutlet · single 语义（D16-②）', () => {
  it('无贡献 → 默认插槽原样回落；有贡献 → 首条替换', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:one', kind: 'single' });
    const { host } = mountOutlet(ctx, 'demo:one', () => [h('div', { class: 'fallback' }, '默认渲染')]);
    expect(host.querySelector('.fallback')?.textContent).toBe('默认渲染');

    const fiber = ctx.plugin(contrib('demo-contrib', (c) => {
      c.slots.register('demo:one', { id: 'x', component: Btn, order: 10, props: { label: 'X' } });
      c.slots.register('demo:one', { id: 'y', component: Btn, order: 20, props: { label: 'Y' } });
    }));
    await fiber;
    await nextTick();
    expect(host.querySelectorAll('button').length).toBe(1);
    expect(host.querySelector('button')?.textContent).toBe('X'); // 最低 order 首条
    expect(host.querySelector('.fallback')).toBeNull();
    await fiber.dispose();
  });
});

describe('SlotOutlet · data 透传（D16-③）', () => {
  it('条目 props 工厂收到 owner data；对象 props 与 data 一并透传', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:data' });
    const seen: unknown[] = [];
    const Recorder = defineComponent({
      props: { data: { type: null, default: undefined }, label: String },
      setup(p) {
        seen.push({ data: p.data, label: p.label });
        return () => h('b', null, p.label ?? '');
      },
    });
    const fiber = ctx.plugin(contrib('demo-contrib', (c) => {
      c.slots.register('demo:data', {
        id: 'r',
        component: Recorder,
        props: (d) => ({ label: `got:${String((d as { v?: number })?.v)}` }),
      });
    }));
    await fiber;
    const { host } = mountOutlet(ctx, 'demo:data');
    // mountOutlet 未传 data —— 经第二个 Outlet 传 data 验证
    const host2 = document.createElement('div');
    const app2 = createApp({ render: () => h(SlotOutlet, { name: 'demo:data', data: { v: 7 } }) });
    app2.provide(CLIENT_CONTEXT_KEY, ctx);
    app2.mount(host2);
    expect(host2.querySelector('b')?.textContent).toBe('got:7');
    expect(seen.some((s) => (s as { label?: string })?.label === 'got:7')).toBe(true);
    expect(host.textContent).toBe('got:undefined'); // 无 data → undefined 透传
    await fiber.dispose();
  });
});

describe('SlotOutlet · 响应式（版本计数轴，D14/D4）', () => {
  it('register / 插件 dispose → DOM 增量更新（不重挂宿主内容）', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:live' });
    const { host } = mountOutlet(ctx, 'demo:live', () => [
      h(SlotOutletItem, () => h('span', { class: 'anchor' }, '锚')),
    ]);
    expect(host.querySelector('.anchor')).not.toBeNull();

    const fiber = ctx.plugin(contrib('demo-contrib', (c) => {
      c.slots.register('demo:live', { id: 'p', component: Btn, order: -1, props: { label: '前插' } });
    }));
    await fiber;
    await nextTick();
    expect(host.querySelector('button')?.textContent).toBe('前插');
    const anchor = host.querySelector('.anchor');
    expect(anchor?.textContent).toBe('锚');

    await fiber.dispose();
    await nextTick();
    expect(host.querySelector('button')).toBeNull();
    expect(host.querySelector('.anchor')?.textContent).toBe('锚');
  });
});

describe('SlotOutlet · 隔离 ctx 包裹（D17）', () => {
  it('贡献组件内 useClientContext() 拿到注册方 ctx', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:probe' });
    const fiber = ctx.plugin(contrib('demo-contrib', (c) => {
      c.slots.register('demo:probe', { id: 'p', component: Probe });
    }));
    await fiber;
    const { host } = mountOutlet(ctx, 'demo:probe');
    expect(host.querySelector('.probe')?.getAttribute('data-ctx')).toBe('yes');
    await fiber.dispose();
  });

  it('owner 包裹不劫持子树的应用级服务解析（回归锚：AppFrame 子树读 ctx.jobBoard）', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'root', kind: 'single', factory: true });
    // 模拟形态：layout 插件（owner）占 root，子树经 useClientContext 读
    // 另一域插件提供的 root 级服务（jobs 域 pilot 的 AppFrame 场景）
    const layout = ctx.plugin(contrib('demo-layout', (c) => {
      c.slots.register('root', { id: 'frame', component: SubtreeProbe });
    }));
    await layout;
    ctx.slots.sealFactory();
    const jobs = ctx.plugin(contrib('demo-jobs', () => { /* 服务由真实插件提供；本用例直接挂 provide 形态 */ }));
    await jobs;
    const host = document.createElement('div');
    const app = createApp({ render: () => h(SlotOutlet, { name: 'root' }) });
    app.provide(CLIENT_CONTEXT_KEY, ctx);
    app.mount(host);
    expect(host.querySelector('.subtree')?.getAttribute('data-svc')).toContain('app-ctx-ok');
    app.unmount();
    await jobs.dispose();
    await layout.dispose();
  });
});

describe('SlotOutlet · fail-closed 兜底', () => {
  it('向未声明席位注册仍由注册表拒绝（Outlet 渲染空不掩盖错误）', async () => {
    const ctx = await createClient();
    expect(() => ctx.slots.register('undeclared:seat', { id: 'a', component: Btn })).toThrowError(SlotCoreError);
    const { host } = mountOutlet(ctx, 'undeclared:seat', () => [h(SlotOutletItem, () => h('b', null, 'host'))]);
    expect(host.querySelector('b')?.textContent).toBe('host');
  });
});
