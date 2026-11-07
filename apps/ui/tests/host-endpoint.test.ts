// @vitest-environment jsdom
// ============================================================
// host-endpoint.test.ts —— webui 独立部署切片一验收（cr-917，
// webui-standalone-protocol §3.1/§3.2）
//
// 锁三面：①端点四层解析（前者赢 / 非法值落层 / 同源零变化）
// ②同源形态请求 URL 逐字节等价（回归判据——同源托管现状不破）
// ③跨源前缀化（boot-graph / WS）+ hello 握手三态。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveHostEndpoint,
  browserHostEndpoint,
  resetHostEndpointForTest,
  hostUrl,
  helloHandshake,
  UI_PROTOCOL,
} from '../client/host-endpoint.ts';
import { wireRpcBrowser, setWireSocketFactory } from '../client/rpc-wire.ts';

const PAGE = { location: { origin: 'http://localhost:5173', href: 'http://localhost:5173/' } };

function layerInputs(overrides: Partial<Parameters<typeof resolveHostEndpoint>[0]> = {}) {
  return {
    location: PAGE.location,
    queryHost: null,
    storage: null,
    injectedHost: null,
    ...overrides,
  };
}

describe('cr-917 · 端点四层发现', () => {
  it('①URL 参数最优先', () => {
    const ep = resolveHostEndpoint(layerInputs({
      queryHost: 'http://127.0.0.1:3830',
      storage: { getItem: () => 'http://elsewhere:1' },
      injectedHost: 'http://elsewhere:2',
    }));
    expect(ep).toMatchObject({ origin: 'http://127.0.0.1:3830', crossOrigin: true, source: 'url' });
  });

  it('②localStorage 次之 ③构建期注入再次 ④同源兜底', () => {
    expect(resolveHostEndpoint(layerInputs({ storage: { getItem: () => 'http://a:1' }, injectedHost: 'http://b:2' })).source).toBe('storage');
    expect(resolveHostEndpoint(layerInputs({ injectedHost: 'http://b:2' })).source).toBe('inject');
    const same = resolveHostEndpoint(layerInputs());
    expect(same).toMatchObject({ origin: PAGE.location.origin, crossOrigin: false, source: 'same-origin' });
  });

  it('非法层值忽略落下一层（显式配置错误不静默顶替同源）', () => {
    expect(resolveHostEndpoint(layerInputs({ queryHost: 'not-a-url' })).source).toBe('same-origin');
    expect(resolveHostEndpoint(layerInputs({ queryHost: 'ftp://x' })).source).toBe('same-origin');
    expect(resolveHostEndpoint(layerInputs({ queryHost: 'http://a:1/path/extra' })).origin).toBe('http://a:1');
  });

  it('层值恰为当前 origin → 同源语义（crossOrigin=false）', () => {
    expect(resolveHostEndpoint(layerInputs({ queryHost: PAGE.location.origin })).crossOrigin).toBe(false);
  });
});

describe('cr-917 · 请求 URL 前缀化', () => {
  it('同源：hostUrl 原样返回相对路径（逐字节等价）', () => {
    const same = resolveHostEndpoint(layerInputs());
    expect(hostUrl('/api/ui/boot-graph', same)).toBe('/api/ui/boot-graph');
    expect(hostUrl('/ui-plugin/demo/ui/index.js', same)).toBe('/ui-plugin/demo/ui/index.js');
  });

  it('跨源：全部宿主请求加 origin 前缀', () => {
    const cross = resolveHostEndpoint(layerInputs({ queryHost: 'http://127.0.0.1:3830' }));
    expect(hostUrl('/api/ui/boot-graph', cross)).toBe('http://127.0.0.1:3830/api/ui/boot-graph');
    expect(hostUrl('/ui-plugin/demo/ui/index.js', cross)).toBe('http://127.0.0.1:3830/ui-plugin/demo/ui/index.js');
    expect(hostUrl('/', cross)).toBe('http://127.0.0.1:3830/');
  });
});

describe('cr-917 · WS URL 随宿主端点', () => {
  const urls: string[] = [];
  class CapturingSocket {
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    sent: string[] = [];
    constructor(url: string) {
      urls.push(url);
      queueMicrotask(() => this.onopen?.());
    }
    send(text: string): void { this.sent.push(text); }
    close(): void { this.readyState = 3; }
  }

  beforeEach(() => {
    wireRpcBrowser.disposeForTest();
    setWireSocketFactory(CapturingSocket as unknown as typeof WebSocket);
  });
  afterEach(() => {
    wireRpcBrowser.disposeForTest();
    localStorage.removeItem('ac.host');
    resetHostEndpointForTest();
  });

  it('同源：WS URL 与现状逐字节等价', async () => {
    resetHostEndpointForTest();
    localStorage.removeItem('ac.host');
    await wireRpcBrowser.call('conversation/stats', undefined, 'he-1', 1000).catch(() => undefined);
    expect(urls.at(-1)).toBe('ws://' + location.host + '/ws');
  });

  it('跨源：WS 指向宿主 origin（协议随宿主）', async () => {
    resetHostEndpointForTest();
    localStorage.setItem('ac.host', 'http://127.0.0.1:3830');
    expect(browserHostEndpoint().crossOrigin).toBe(true);
    await wireRpcBrowser.call('conversation/stats', undefined, 'he-2', 1000).catch(() => undefined);
    expect(urls.at(-1)).toBe('ws://127.0.0.1:3830/ws');
  });
});

describe('cr-917 · hello 握手（§3.2）', () => {
  const cross = resolveHostEndpoint(layerInputs({ queryHost: 'http://127.0.0.1:3830' }));
  const okFetch = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('协议轴一致 → ok', async () => {
    const out = await helloHandshake(cross, okFetch({ protocol: 1, hostVersion: '9.9.9' }), 500);
    expect(out).toEqual({ kind: 'ok', reply: { protocol: 1, hostVersion: '9.9.9' } });
  });

  it('major 不匹配 → protocol-conflict（fail-loud 面）', async () => {
    const out = await helloHandshake(cross, okFetch({ protocol: 2 }), 500);
    expect(out).toEqual({ kind: 'protocol-conflict', remote: 2 });
  });

  it('不可达 / 非 JSON / 缺 protocol → unreachable / conflict 如实回报', async () => {
    const fail: typeof fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await helloHandshake(cross, fail, 500)).toMatchObject({ kind: 'unreachable' });
    const badStatus: typeof fetch = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;
    expect(await helloHandshake(cross, badStatus, 500)).toMatchObject({ kind: 'unreachable' });
    const noProtocol = await helloHandshake(cross, okFetch({ hostVersion: 'x' }), 500);
    expect(noProtocol).toMatchObject({ kind: 'protocol-conflict' });
  });

  it('握手请求打到宿主前缀端点', async () => {
    let called = '';
    const spy: typeof fetch = (async (input: RequestInfo | URL) => {
      called = String(input);
      return new Response(JSON.stringify({ protocol: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    await helloHandshake(cross, spy, 500);
    expect(called).toBe('http://127.0.0.1:3830/api/ui/hello');
  });

  it('UI_PROTOCOL 导出面 = 1（协议轴单源）', () => {
    expect(UI_PROTOCOL).toBe(1);
  });
});
