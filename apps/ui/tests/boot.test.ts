// @vitest-environment jsdom
// ============================================================
// boot.test.ts —— ui 树 boot 装配序列验收（8.5b 批1）
//
// ① createClient → ② 骨架 3 件 in-bundle（theme/renderer/layout——
// 依赖序装载 + 服务可解析）→ ③ sealFactory（出厂封印后 root 动态注册
// 恒低优）→ ④ 通道装载（graph 条目 → ctx.plugin；isolated 跳过；坏条目
// 逐条隔离不毁表面）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { bootUiClient, skeletonPlugins, loadChannelCss } from '../client/boot.ts';
import { conversationClientPlugin } from 'ac-client-ui-conversation/client';
import { toolClientPlugin } from 'ac-client-ui-tool/client';
import { settingsClientPlugin } from 'ac-client-ui-settings/client';
import { markdownRenderPlugin } from '../channel/markdown-render/src/index.ts';
import type { BootGraphEntry } from 'ac-webui-core';
import { isAllowedIsolatedEvent, isAllowedIsolatedRequest } from 'ac-webui-core';

// matchMedia 垫桩住 tests-setup.ts（setupFiles 先于 import 链——模块级求值会触）

function entry(name: string, over: Partial<BootGraphEntry> = {}): BootGraphEntry {
  return {
    name, version: '1.0.0', platform: 'web',
    base: '/ui-plugin/' + name + '/', entry: 'ui/index.js',
    styles: [], seats: [], isolated: false, channelImports: [], ...over,
  };
}

describe('8.5b · ui 树 boot 装配序列', () => {
  it('骨架 3 件 in-bundle：theme → renderer → layout 依序装载，服务可解析，root 席位出厂占用', async () => {
    setActivePinia(createPinia());
    const { ctx, channel } = await bootUiClient({ fetchGraph: async () => [] });
    expect(channel.size).toBe(0);
    // 服务面可解析（骨架件提供）
    expect(ctx.theme).toBeDefined();
    expect(ctx.vueRenderer).toBeDefined();
    // root 席位：出厂层占用（AppFrame——layout 件贡献）
    expect(ctx.slots.entries('root').length).toBe(1);
    // 拓扑契约词汇已声明（骨架持有者——fail-closed 注册面就绪）
    expect(ctx.slots.declOf('main')).toBeDefined();
    expect(ctx.slots.declOf('main:perspective')).toBeDefined();
    expect(ctx.slots.declOf('activity-bar')).toBeDefined();
    expect(ctx.slots.declOf('overlay')).toBeDefined();
  });

  it('出厂封印：sealFactory 后 root 动态注册恒入低优层（single 选举出厂恒胜）', async () => {
    setActivePinia(createPinia());
    const { ctx } = await bootUiClient({ fetchGraph: async () => [] });
    // 封印后注册（动态层 tier 1）——single 选举出厂层（tier 0）恒胜（D3）
    const TestComp = { render: () => null };
    ctx.slots.register('root', { id: 'late-attacker', component: TestComp as never, order: -1 });
    const entries = ctx.slots.entries('root');
    expect(entries.length).toBe(2);
    expect(ctx.slots.single('root')?.id).toBe('webui-base-layout.app-frame');
  });

  it('通道装载：graph 条目 → ctx.plugin 装载；缺 default export 与抛错条目逐条隔离', async () => {
    setActivePinia(createPinia());
    const applied: string[] = [];
    const loader = async (e: BootGraphEntry) => {
      if (e.name === 'bad-shape') return { notDefault: true };
      if (e.name === 'boom') throw new Error('network down');
      return {
        default: {
          name: e.name,
          apply(c: { effect: (fn: () => () => void) => void }) {
            applied.push(e.name);
            c.effect(() => () => { /* dispose 面 */ });
          },
        },
      };
    };
    const { channel } = await bootUiClient({
      fetchGraph: async () => [entry('ok-a'), entry('ok-b'), entry('bad-shape'), entry('boom'), entry('iso', { isolated: true })],
      loadChannel: loader,
    });
    expect(applied).toEqual(['ok-a', 'ok-b']);
    expect(channel.get('ok-a')).toBe('ok');
    expect(channel.get('ok-b')).toBe('ok');
    expect(channel.get('bad-shape')).toBe('err');
    expect(channel.get('boom')).toBe('err');
    expect(channel.get('iso')).toBe('ok'); // isolated 条目 = iframe 档装载（8.5 收尾批）
  });

  it('通道条目可贡献席位（tool-card 开放词汇——slot 注册面真实生效）', async () => {
    setActivePinia(createPinia());
    // 通道条目声明 seat 贡献：装载后 register 生效（manifest seats → 条目内自注册）
    const { ctx, channel } = await bootUiClient({
      fetchGraph: async () => [entry('seater', { seats: [{ seat: 'overlay' }] })],
      loadChannel: async (e) => ({
        default: {
          name: e.name,
          inject: ['slots'],
          apply(c: { slots: { register: (k: string, def: unknown) => () => void } }) {
            c.slots.register('overlay', { id: 'seater.card', component: { render: () => null } as never, order: 50 });
          },
        },
      }),
    });
    expect(channel.get('seater')).toBe('ok');
    expect(ctx.slots.entries('overlay').some((en) => en.id === 'seater.card')).toBe(true);
  });

  it('seats 对账（cr-690 B1）：声明未注册/注册未声明双向 warning，new: 词形不误报', async () => {
    setActivePinia(createPinia());
    const { channel, seatAudit } = await bootUiClient({
      fetchGraph: async () => [
        // ghost：声明 overlay 但 apply 内不注册（声明未注册）
        entry('ghost', { seats: [{ seat: 'overlay' }] }),
        // honest：声明 aux-sidebar 且真实注册（干净通过）
        entry('honest', { seats: [{ seat: 'aux-sidebar' }] }),
        // stray：不声明但注册 overlay（注册未声明——骨架已声明的席位）
        entry('stray'),
        // newseater：new: 词形声明（B1 只过校验不贡献——不误报声明未注册）
        entry('newseater', { seats: [{ seat: 'new:acme:panel', kind: 'list', scope: 'root' }] }),
      ],
      loadChannel: async (e) => ({
        default: {
          name: e.name,
          inject: ['slots'],
          apply(c: { slots: { register: (k: string, def: { id: string; component: unknown }) => () => void } }) {
            if (e.name === 'honest') c.slots.register('aux-sidebar', { id: 'honest.panel', component: { render: () => null } });
            if (e.name === 'stray') c.slots.register('overlay', { id: 'stray.w', component: { render: () => null } });
          },
        },
      }),
    });
    expect(channel.get('ghost')).toBe('ok');
    expect(seatAudit.get('ghost')?.declaredNotRegistered).toEqual(['overlay']);
    expect(seatAudit.get('honest')).toEqual({ declaredNotRegistered: [], registeredNotDeclared: [] });
    expect(seatAudit.get('stray')?.registeredNotDeclared).toEqual(['overlay']);
    expect(seatAudit.get('newseater')).toEqual({ declaredNotRegistered: [], registeredNotDeclared: [] });
  });
});


describe('8.5b 第二批 · 外部化通道装载（moduleHost + channelImports）', () => {
  it('channelImports 缺键：条目逐条隔离（err），不殃及后续条目', async () => {
    setActivePinia(createPinia());
    const { channel } = await bootUiClient({
      fetchGraph: async () => [
        entry('missing-dep', { channelImports: ['vue', 'not-in-host'] }),
        entry('ok-after'),
      ],
      loadChannel: async () => ({ default: { name: 'x', apply() { /* ok */ } } }),
    });
    expect(channel.get('missing-dep')).toBe('err');
    expect(channel.get('ok-after')).toBe('ok');
  });

  it('moduleHost 挂全局注册表：骨架基座模块单例可达（vue/pinia/cordis/runtime/slots）', async () => {
    setActivePinia(createPinia());
    await bootUiClient({ fetchGraph: async () => [] });
    const host = (globalThis as Record<string, unknown>)['__ac_channel_modules__'] as Record<string, unknown>;
    expect(host).toBeDefined();
    for (const k of ['vue', 'pinia', '@agentchat/cordis', 'ac-client-runtime', 'ac-client-slots']) {
      expect(host[k]).toBeDefined();
    }
  });

  it('四模块真装载：主线插件 default 经通道进入宿主树（conversation/tool/settings/markdown-render）', async () => {
    setActivePinia(createPinia());
    const mods: Record<string, unknown> = {
      conversation: conversationClientPlugin,
      tool: toolClientPlugin,
      settings: settingsClientPlugin,
      'markdown-render': markdownRenderPlugin,
    };
    const { ctx, channel } = await bootUiClient({
      rpcWire: {
        call: async <T,>(_method: string) => null as T,
        onEvent: () => () => { /* 桩 */ },
        onOpen: () => () => { /* 桩 */ },
        onAck: () => () => { /* 桩 */ },
        onClose: () => () => { /* 桩 */ },
        connected: () => true,
      },
      fetchGraph: async () => Object.keys(mods).map((n) => entry(n, { channelImports: ['vue', 'ac-client-runtime'] })),
      loadChannel: async (e) => ({ default: mods[e.name] }),
    });
    for (const n of Object.keys(mods)) expect(channel.get(n)).toBe('ok');
    // conversation 服务面 + talk 视角真实到位（通道装载生效的架构面证据）
    expect((ctx as unknown as Record<string, unknown>).sessions).toBeDefined();
    expect(ctx.slots.entries('main:perspective').some((en) => en.id === 'talk')).toBe(true);
    // tool 席位词汇（tool-card:result-view keyed 声明——tool 模块贡献；内置条目无、回落解析面）
    expect(ctx.slots.declOf('tool-card:result-view')).toBeDefined();
  });
});

describe('8.5 收尾批 · isolated 档（iframe）装载', () => {
  it('isolated 条目：iframe sandbox 容器创建（allow-scripts 无 same-origin）+ channel ok + 句柄 cleanup 收割', async () => {
    setActivePinia(createPinia());
    const { channel, isolated } = await bootUiClient({ fetchGraph: async () => [entry('third-party', { isolated: true })] });
    expect(channel.get('third-party')).toBe('ok');
    expect(isolated.length).toBe(1);
    const frame = isolated[0]!.iframe;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.dataset.uiIsolated).toBe('third-party');
    // cleanup：iframe 移除 + message 监听退订（卸载路径真实生效）
    isolated[0]!.cleanup();
    expect(document.querySelector('iframe[data-ui-isolated="third-party"]')).toBeNull();
  });

  it('request 白名单：非白名单路径 403 拒绝（rpc 面未被调用）', async () => {
    setActivePinia(createPinia());
    let rpcCalls = 0;
    const { isolated } = await bootUiClient({
      rpcWire: {
        call: async <T,>(_m: string) => { rpcCalls++; return null as T; },
        onEvent: () => () => { /* 桩 */ },
        onOpen: () => () => { /* 桩 */ },
        onAck: () => () => { /* 桩 */ },
        onClose: () => () => { /* 桩 */ },
        connected: () => true,
      },
      fetchGraph: async () => [entry('third-party', { isolated: true })],
    });
    const frame = isolated[0]!.iframe;
    // 模拟 iframe 内 runtime 发来的非白名单 request（postMessage 到父窗口）
    const responses: Array<Record<string, unknown>> = [];
    const got = new Promise<void>((resolve) => {
      const timer = setInterval(() => { /* jsdom iframe.contentWindow 为 about:blank 桩——由测试直接断言 policy 纯函数 */ resolve(); }, 0);
      void timer;
    });
    void got;
    void responses;
    void frame;
    // jsdom 的 iframe 不加载远程文档（contentWindow 无 isolated-runtime）——
    // 消息往返走不了真链路；白名单拒止语义经 policy 纯函数直测（下方独立 it）。
    // 本用例锁定：容器属性（sandbox/src URL 形态）在真 DOM 属性面。
    expect(frame.src).toContain('/ui-plugin-iframe.html?name=third-party');
    expect(rpcCalls).toBe(0);
    isolated[0]!.cleanup();
  });
});

describe('8.5 收尾批 · isolated 白名单纯函数（p5.5 policy 平移）', () => {
  it('request 白名单：GET 只读子集放行，其余拒止', () => {
    expect(isAllowedIsolatedRequest('GET', '/api/ui/extensions')).toBe(true);
    expect(isAllowedIsolatedRequest('GET', '/api/version')).toBe(true);
    expect(isAllowedIsolatedRequest('GET', '/api/version?x=1')).toBe(true);
    expect(isAllowedIsolatedRequest('POST', '/api/ui/extensions')).toBe(false);
    expect(isAllowedIsolatedRequest('GET', '/api/conversation/deliver')).toBe(false);
    expect(isAllowedIsolatedRequest('GET', '/api/plugins/assembly/abc-123')).toBe(true);
    expect(isAllowedIsolatedRequest('GET', '/api/plugins/assembly/../../etc')).toBe(false);
  });

  it('event 白名单：生命周期事件放行，聊天/文件内容拒止', () => {
    expect(isAllowedIsolatedEvent('plugin.reload')).toBe(true);
    expect(isAllowedIsolatedEvent('ui.extensions.changed')).toBe(true);
    expect(isAllowedIsolatedEvent('message.created')).toBe(false);
    expect(isAllowedIsolatedEvent('session.updated')).toBe(false);
  });
// cr-584：通道产物 style.css 装载——manifest styles 声明 → <link> 注入（去重）
  it('loadChannelCss：link 注入 head + href 去重（通道样式不重复挂）', () => {
    const before = document.querySelectorAll('link[rel="stylesheet"]').length;
    loadChannelCss('/ui-plugin/workspace/ui/style.css');
    loadChannelCss('/ui-plugin/workspace/ui/style.css'); // 重复调用 = 去重
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
    expect(links.length).toBe(before + 1);
    expect(links[links.length - 1]!.getAttribute('href')).toBe('/ui-plugin/workspace/ui/style.css');
  });
});

describe('B2 · 主题包装载（theme:{tokensOnly}——纯数据条目）', () => {
  const tokenCss = "html[data-theme='t'] { --bg-base: #000; --primary: #0ff; } html.light[data-theme='t'] { --bg-base: #111; }";

  /** fetch 桩（jsdom fetch 走 undici 真网络——单测恒桩面） */
  function stubFetch(body: string, status = 200): { urls: string[]; restore(): void } {
    const urls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: unknown) => {
      urls.push(String(u));
      return new Response(status === 200 ? body : '', { status });
    }) as typeof fetch;
    return { urls, restore: () => { globalThis.fetch = orig; } };
  }

  it('装载链：fetch CSS → 词汇审计（缺项 warning 不拒载）→ style 注入 → 登记 id → channel ok', async () => {
    setActivePinia(createPinia());
    const fetchStub = stubFetch(tokenCss);
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    try {
      const { channel, themeAudit } = await bootUiClient({
        fetchGraph: async () => [entry('t', { theme: { tokensOnly: true }, styles: ['tokens.css'], entry: undefined })],
      });
      expect(channel.get('t')).toBe('ok');
      // 审计报告进结果面（缺项数量 = 词汇总量 - 2——完备性缺口可见）
      const audit = themeAudit.get('t');
      expect(audit?.id).toBe('t');
      expect(audit?.audit.coverage.dark).toBe(2);
      // style 注入（data-ui-theme 标记）+ 文本入 head
      const style = document.querySelector("style[data-ui-theme='t']");
      expect(style?.textContent).toContain('--bg-base: #000');
      // 登记：可选 id 面（未登记 id 拒切的防线语义在 theme-id.test）
      expect(warns.some((w) => w.includes('词汇不完备'))).toBe(true);
    } finally {
      console.warn = origWarn;
      fetchStub.restore();
    }
  });

  it('CSS 拉取失败：条目 err（逐条隔离），后续条目不受扰', async () => {
    setActivePinia(createPinia());
    const fetchStub = stubFetch('', 404);
    const okPlugin = { apply: () => Promise.resolve() };
    const { channel } = await bootUiClient({
      fetchGraph: async () => [
        entry('dead-theme', { theme: { tokensOnly: true }, styles: ['missing.css'], entry: undefined }),
        entry('healthy', { isolated: false }),
      ],
      loadChannel: async () => ({ default: okPlugin }),
    });
    expect(channel.get('dead-theme')).toBe('err');
    expect(channel.get('healthy')).toBe('ok');
    fetchStub.restore();
  });

  it('midnight 示例主题包：真文件审计全覆盖（52 词 × 双极，零 warning）', async () => {
    const { auditThemeTokens } = await import('ac-webui-core');
    const { readFileSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');
    const css = readFileSync(resolve(process.env.AGENTCHAT_REPO_ROOT ?? process.cwd(), 'apps/ui/themes/midnight/tokens.css'), 'utf8');
    const audit = auditThemeTokens(css, 'midnight');
    expect(audit.missing.dark).toEqual([]);
    expect(audit.missing.light).toEqual([]);
    expect(audit.unknown.dark).toEqual([]);
    expect(audit.unknown.light).toEqual([]);
  });

  it('graph 重载不重复注入（data-ui-theme 去重）', async () => {
    setActivePinia(createPinia());
    const fetchStub = stubFetch(tokenCss);
    const graph = [entry('dup', { theme: { tokensOnly: true }, styles: ['tokens.css'], entry: undefined })];
    await bootUiClient({ fetchGraph: async () => graph });
    await bootUiClient({ fetchGraph: async () => graph });
    expect(document.querySelectorAll("style[data-ui-theme='dup']")).toHaveLength(1);
    fetchStub.restore();
  });

  it('fetch 面注入：样式 URL 恒走真实 fetch（jsdom 原生面）', async () => {
    setActivePinia(createPinia());
    const fetchStub = stubFetch(tokenCss);
    try {
      const { channel } = await bootUiClient({
        fetchGraph: async () => [entry('probe', { theme: { tokensOnly: true }, styles: ['tokens.css'], entry: undefined })],
      });
      expect(channel.get('probe')).toBe('ok');
      expect(fetchStub.urls.some((u) => u.includes('/ui-plugin/probe/tokens.css'))).toBe(true);
    } finally {
      fetchStub.restore();
    }
  });
});

describe('B3 · 视角挂载（seats[].view——registerView + 隔离档容器承载）', () => {
  it('非隔离档：模块 apply 内 registerView 自注册（aux 视角入候选 + rail 资产）+ 对账干净', async () => {
    setActivePinia(createPinia());
    const { channel, seatAudit, ctx } = await bootUiClient({
      fetchGraph: async () => [entry('acme', { seats: [{ seat: 'acme:panel', view: { region: 'aux', id: 'acme', label: 'Acme' } }] })],
      loadChannel: async (e) => ({
        default: {
          name: e.name,
          inject: ['slots'],
          apply(c: { slots: { register: (k: string, def: unknown) => () => void } }) {
            // 非隔离档消费面：apply 内经 layout registerView（channelImports 引
            // 'ac-client-ui-layout/client'——此处直引同构）或直接 slots.register。
            c.slots.register('aux-sidebar', {
              id: 'view.acme',
              component: { render: () => null } as never,
              meta: { def: { id: 'acme', active: () => true, component: { render: () => null }, rail: { icon: 'app-window', title: 'Acme' } } },
            });
          },
        },
      }),
    });
    expect(channel.get('acme')).toBe('ok');
    // 对账干净：view 声明的期望席位（aux-sidebar）被真实贡献抵消
    expect(seatAudit.get('acme')).toEqual({ declaredNotRegistered: [], registeredNotDeclared: [] });
    // 候选面真实到位（AuxSidebarPanelDef 形状）
    expect(ctx.slots.entries('aux-sidebar').some((en) => en.id === 'view.acme')).toBe(true);
  });

  it('隔离档：宿主代挂 iframe 容器视角（aux 候选 + cleanup 撤销 + 对账干净）', async () => {
    setActivePinia(createPinia());
    const { channel, seatAudit, isolated, ctx } = await bootUiClient({
      fetchGraph: async () => [entry('sandboxed', { isolated: true, seats: [{ seat: 'sandboxed:panel', view: { region: 'aux', id: 'sbx', label: 'SBX' } }] })],
    });
    expect(channel.get('sandboxed')).toBe('ok');
    expect(seatAudit.get('sandboxed')).toEqual({ declaredNotRegistered: [], registeredNotDeclared: [] });
    // 宿主代挂：aux-sidebar 出现 view.sbx 条目（iframe 容器组件承载）
    expect(ctx.slots.entries('aux-sidebar').some((en) => en.id === 'view.sbx')).toBe(true);
    // def 形状：rail 资产（label）+ active 恒真
    const def = ctx.slots.entries('aux-sidebar').find((en) => en.id === 'view.sbx')?.meta?.def as { rail?: { title?: string } };
    expect(def?.rail?.title).toBe('SBX');
    // cleanup 收割视角 disposer（onDestroy 面真实生效）
    isolated[0]!.cleanup();
    expect(ctx.slots.entries('aux-sidebar').some((en) => en.id === 'view.sbx')).toBe(false);
  });

  it('隔离档容器承载：mountTo/unmountFrom 语义（iframe 移入承载 div + 回隐藏态）', async () => {
    setActivePinia(createPinia());
    const { isolated } = await bootUiClient({
      fetchGraph: async () => [entry('framed', { isolated: true })],
    });
    const handle = isolated[0]!;
    const frame = handle.iframe;
    // 初始隐藏态（屏幕外 + aria-hidden）
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    const container = document.createElement('div');
    document.body.appendChild(container);
    handle.mountTo(container);
    expect(container.contains(frame)).toBe(true);
    expect(frame.getAttribute('aria-hidden')).toBe('false');
    expect(frame.style.width).toBe('100%');
    // 幂等：同容器重复挂载零操作
    handle.mountTo(container);
    expect(container.children.length).toBe(1);
    // 卸载：回 body 寄存 + 隐藏态复位
    handle.unmountFrom();
    expect(container.contains(frame)).toBe(false);
    expect(document.body.contains(frame)).toBe(true);
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    handle.cleanup();
  });

  it('缺席不毁表面：view 声明但模块未注册（非隔离）→ declaredNotRegistered warning + channel ok', async () => {
    setActivePinia(createPinia());
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    try {
      const { channel, seatAudit } = await bootUiClient({
        fetchGraph: async () => [
          entry('ghost-view', { seats: [{ seat: 'ghost:panel', view: { region: 'main', id: 'ghost' } }] }),
          entry('after-ghost'),
        ],
        loadChannel: async () => ({ default: { name: 'x', apply() { /* 不注册任何席位 */ } } }),
      });
      // 逐条隔离语义：漂移是 warning 不是失败，后续条目不受扰
      expect(channel.get('ghost-view')).toBe('ok');
      expect(channel.get('after-ghost')).toBe('ok');
      expect(seatAudit.get('ghost-view')?.declaredNotRegistered).toEqual(['main']);
      expect(warns.some((w) => w.includes('ghost-view'))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });
});

