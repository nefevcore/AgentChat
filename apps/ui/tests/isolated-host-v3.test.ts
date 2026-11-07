// @vitest-environment jsdom
// ============================================================
// isolated-host-v3.test.ts —— isolated 档 v3 壳侧验收（cr-934；
// webui-v3 §4.6 裁决八）。jsdom 不跑 iframe 脚本——沙盒内语义靠
// srcdoc 字串断言（生成器为纯函数）+ 父窗半边真跑（消息/席位/代理）。
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ClientContext } from 'ac-client-runtime';
import type { Wire, WireRow } from 'ac-webui-core';
import {
  generateIsolatedDoc,
  isAllowedIsolatedRequestV3,
  loadIsolatedRowV3,
} from '../client/isolated-host-v3.ts';
import { bootUiClientV3 } from '../client/boot-v3.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// ---------------- srcdoc 生成（纯函数面） ----------------

describe('generateIsolatedDoc · 自举文档生成', () => {
  it('内联模块表（__ModuleLoader__ 注册 + 同步 require + 未命中 loud throw）与 entry 装载序', () => {
    const doc = generateIsolatedDoc({ id: 'iso-x', entryUrl: 'http://127.0.0.1:3830/ui-asset/iso-x/r1/index.js' });
    expect(doc).toContain('window.__ModuleLoader__');
    expect(doc).toContain("factories.set(reg.id, reg.factory)");
    expect(doc).toContain('模块不可解析（isolated 独立模块表未命中注册表）');
    expect(doc).toContain('模块环');
    // 装载序：注册表先行 → entry script 到达后 require(rowId) → install(ctx)
    expect(doc.indexOf('window.__ModuleLoader__')).toBeLessThan(doc.indexOf('acRequire(PLUGIN)'));
    expect(doc).toContain('"http://127.0.0.1:3830/ui-asset/iso-x/r1/index.js"');
    // 受限 ctx 契约词汇在场（无 Vue / 无 slot 注册面）
    expect(doc).toContain('onUnload');
    expect(doc).toContain('install(ctx)（isolated 契约：request/onEvent/onUnload）');
    expect(doc).not.toContain('vue');
  });

  it('CSP 收紧：脚本源限宿主 origin，嵌入词 < 转义防早闭合', () => {
    const doc = generateIsolatedDoc({ id: 'a<b', entryUrl: 'https://h.example/x.js' });
    expect(doc).toContain("script-src 'unsafe-inline' https://h.example");
    expect(doc).toContain('\\u003c'); // 嵌入 JSON 的 < 一律转义
    expect(doc).not.toContain('</script' + 'a<b'); // 不会带出第二个 script 块
  });
});

// ---------------- 白名单纯函数 ----------------

describe('isAllowedIsolatedRequestV3 · request 路径白名单', () => {
  it('GET /api/ 与 /ui-asset/ 前缀放行；其余方法/路径/绝对 URL 拒', () => {
    expect(isAllowedIsolatedRequestV3('GET', '/api/ui/wire')).toBe(true);
    expect(isAllowedIsolatedRequestV3('GET', '/api/config?v=1')).toBe(true);
    expect(isAllowedIsolatedRequestV3('GET', '/ui-asset/iso-x/r1/index.js')).toBe(true);
    expect(isAllowedIsolatedRequestV3('POST', '/api/ui/wire')).toBe(false); // 只读 GET 子集
    expect(isAllowedIsolatedRequestV3('GET', '/evil')).toBe(false);
    expect(isAllowedIsolatedRequestV3('GET', 'https://evil.example/api/x')).toBe(false); // 须路径词形
  });
});

// ---------------- 父窗宿主半边（真跑） ----------------

interface FakeCtx {
  registered: Array<{ key: string; entry: Record<string, unknown> }>;
  onEventCalls: string[];
  disposedEvents: number;
}

function fakeCtx(): { ctx: ClientContext; fake: FakeCtx } {
  const fake: FakeCtx = { registered: [], onEventCalls: [], disposedEvents: 0 };
  const ctx = {
    slots: {
      register: (key: string, entry: Record<string, unknown>) => {
        fake.registered.push({ key, entry });
        return () => { /* 桩 */ };
      },
    },
    rpc: {
      onEvent: () => {
        fake.onEventCalls.push('sub');
        return () => { fake.disposedEvents++; };
      },
    },
  } as unknown as ClientContext;
  return { ctx, fake };
}

function isoRow(over: Partial<WireRow> = {}): WireRow & { entry: string } {
  return { id: 'iso-x', version: '1.0.0', entry: '/ui-asset/iso-x/r1/index.js', seats: [], isolated: true, ...over };
}

/** 模拟 iframe → 父窗消息（source 校验面必须命中 contentWindow） */
function postFromIframe(iframe: HTMLIFrameElement, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow }));
}

function responsesOf(spy: { mock: { calls: Array<Array<unknown>> } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map((c) => c[0] as Record<string, unknown>)
    .filter((m) => m.source === 'agentchat-ui-iframe-host');
}

describe('loadIsolatedRowV3 · 父窗宿主', () => {
  it('sandbox iframe（allow-scripts、无 allow-same-origin）+ srcdoc 自举 + 席位占位注册', () => {
    const { ctx, fake } = fakeCtx();
    const handle = loadIsolatedRowV3(ctx, isoRow({ seats: ['tool-card'] }));
    expect(handle.iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(handle.iframe.srcdoc).toContain('ui-asset/iso-x/r1/index.js');
    expect(document.body.contains(handle.iframe)).toBe(true); // 屏幕外寄存
    expect(fake.registered.map((r) => r.key)).toEqual(['tool-card']);
    expect(fake.registered[0]!.entry.id).toBe('iso-x'); // 占位 entry id = 行 id
    expect(fake.registered[0]!.entry.component).toBeDefined();
  });

  it('request 白名单代理：越权路径 403 拒；放行路径经 fetch 代理回数据', async () => {
    const { ctx } = fakeCtx();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"a":1}' })));
    const handle = loadIsolatedRowV3(ctx, isoRow());
    const post = vi.spyOn(handle.iframe.contentWindow!, 'postMessage');

    postFromIframe(handle.iframe, { source: 'agentchat-ui-plugin-iframe', plugin: 'iso-x', kind: 'request', id: 1, path: '/evil', init: { method: 'GET' } });
    postFromIframe(handle.iframe, { source: 'agentchat-ui-plugin-iframe', plugin: 'iso-x', kind: 'request', id: 2, path: '/api/config', init: { method: 'GET' } });
    await new Promise((r) => setTimeout(r, 0));

    const responses = responsesOf(post);
    expect(responses.find((m) => m.id === 1)).toMatchObject({ ok: false, status: 403 });
    expect(responses.find((m) => m.id === 2)).toMatchObject({ ok: true, status: 200, data: { a: 1 } });
  });

  it('事件订阅白名单：放行类型经 ctx.rpc.onEvent 转发源；越权类型不订阅', async () => {
    const { ctx, fake } = fakeCtx();
    const handle = loadIsolatedRowV3(ctx, isoRow());
    const post = vi.spyOn(handle.iframe.contentWindow!, 'postMessage');

    postFromIframe(handle.iframe, { source: 'agentchat-ui-plugin-iframe', plugin: 'iso-x', kind: 'subscribe', type: 'evil.event' });
    postFromIframe(handle.iframe, { source: 'agentchat-ui-plugin-iframe', plugin: 'iso-x', kind: 'subscribe', type: 'plugin.reload' });
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.onEventCalls.length).toBe(1); // 越权类型不落地订阅

    handle.cleanup();
    expect(fake.disposedEvents).toBe(1); // cleanup 收割订阅
    expect(document.body.contains(handle.iframe)).toBe(false);
  });
});

// ---------------- boot-v3 接线面 ----------------

describe('boot-v3 · isolated 行接线', () => {
  it('isolated 行不再跳过：iframe 宿主 + 席位占位 + styles 注入；rev 变化 = 重建', async () => {
    setActivePinia(createPinia());
    let current: Wire = {
      rev: 'r1',
      rows: [isoRow({ seats: ['main'], styles: ['/ui-asset/iso-x/r1/style.css'] })],
      seeds: {},
      warnings: [],
    };
    const { ctx, channel, reload } = await bootUiClientV3({ fetchWire: async () => current });
    expect(channel.get('iso-x')).toBe('ok');
    const frame1 = document.querySelector('iframe[data-ui-isolated="iso-x"]') as HTMLIFrameElement;
    expect(frame1).not.toBeNull();
    expect(frame1.srcdoc).toContain('/ui-asset/iso-x/r1/index.js');
    expect(ctx.slots.entries('main').some((e) => e.id === 'iso-x')).toBe(true); // 占位进声明席位
    expect(document.querySelector('link[href$="style.css"]')).not.toBeNull(); // styles 照常注入

    current = {
      rev: 'r2',
      rows: [isoRow({ seats: ['main'], entry: '/ui-asset/iso-x/r2/index.js', styles: ['/ui-asset/iso-x/r1/style.css'] })],
      seeds: {},
      warnings: [],
    };
    await reload();
    const frames = document.querySelectorAll('iframe[data-ui-isolated="iso-x"]');
    expect(frames.length).toBe(1); // 旧档清理，不叠加
    expect((frames[0] as HTMLIFrameElement).srcdoc).toContain('/r2/index.js');
  });
});
