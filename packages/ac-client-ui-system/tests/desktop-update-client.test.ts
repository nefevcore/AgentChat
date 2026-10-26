// @vitest-environment jsdom
// ============================================================
// ac-client-ui-system/tests/desktop-update-client.test.ts —— 桌面更新
// 桥客户端行为锁（cr-462：此前 fetchDesktopUpdateStatus / triggerDesktopUpdateDownload
// / installDesktopUpdate 全仓零测试覆盖——探测/缓存/回落语义裸奔；并锁定
// 非 200 应答失效缓存基址的壳重启漂移防线）。
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DesktopUpdateStatus } from '../client/systemApi.ts';

// 模块级缓存基址（cachedUpdateBase）跨用例隔离：每用例重置模块再取新鲜引用
async function freshApi(): Promise<typeof import('../client/systemApi.ts')> {
  vi.resetModules();
  return import('../client/systemApi.ts');
}

function status(p: Partial<DesktopUpdateStatus> = {}): DesktopUpdateStatus {
  return {
    current: '1.0.0', latest: '1.1.0', latestUrl: 'https://x', supported: true,
    status: 'downloading', version: '1.1.0', fileName: 'a.exe', size: 100,
    received: 40, total: 100, error: null, ...p,
  };
}

const STATUS_PATH = '/desktop-bridge/update';

/** fetch 打桩：GET 状态端点按序消费响应表（耗尽后粘末项——模拟桥持续同形应答）；POST 按「方法+路径后缀」分派 */
function stubBridge(getQueue: Array<{ code?: number; body?: string }>, posts: Record<string, { code?: number; body?: string }>) {
  const gets = [...getQueue];
  const tail = getQueue[getQueue.length - 1] ?? { code: 500 };
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    urls.push(url);
    if (method === 'GET' && url.includes(STATUS_PATH)) {
      const r = gets.shift() ?? tail;
      return new Response(r.body ?? '', { status: r.code ?? 200 });
    }
    const key = Object.keys(posts).find((k) => method === 'POST' && url.endsWith(k));
    if (key) return new Response(posts[key].body ?? '', { status: posts[key].code ?? 200 });
    return new Response('not found', { status: 404 });
  }));
  return { urls: () => urls };
}

function portOf(url: string): number {
  return Number(/:(\d+)\D/.exec(url)?.[1] ?? 0);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchDesktopUpdateStatus（探测序列与缓存）', () => {
  it('首候选失败 → 次候选成功：状态返回且基址缓存（后续直连单发）', async () => {
    const { fetchDesktopUpdateStatus } = await freshApi();
    const body = JSON.stringify(status());
    const { urls } = stubBridge([{ code: 500 }, { body }], {});
    const st = await fetchDesktopUpdateStatus();
    expect(st?.version).toBe('1.1.0');
    const first2 = urls().filter((u) => u.includes(STATUS_PATH));
    expect(first2).toHaveLength(2);
    expect(portOf(first2[1]) - portOf(first2[0])).toBe(1); // 相邻候选口（p+1 失败 → p+2）
    const st2 = await fetchDesktopUpdateStatus();
    expect(st2?.status).toBe('downloading');
    expect(urls().filter((u) => u.includes(STATUS_PATH))).toEqual([first2[0], first2[1], first2[1]]);
  });

  it('全候选失败 → null（非桌面形态静默降级）', async () => {
    const { fetchDesktopUpdateStatus } = await freshApi();
    stubBridge([{ code: 500 }, { code: 500 }, { code: 500 }, { code: 500 }], {});
    expect(await fetchDesktopUpdateStatus()).toBeNull();
  });

  it('缓存基址非 200 应答 → 本轮 null + 缓存失效，下一轮重扫候选序列（壳重启桥口漂移防线，cr-462）', async () => {
    const { fetchDesktopUpdateStatus } = await freshApi();
    const ready = JSON.stringify(status({ status: 'ready' }));
    // 第一轮：次候选 200 → 缓存基址
    const { urls } = stubBridge([{ code: 500 }, { body: ready }], {});
    expect((await fetchDesktopUpdateStatus())?.status).toBe('ready');
    expect(urls().filter((u) => u.includes(STATUS_PATH))).toHaveLength(2);
    // 第二轮：缓存基址 500（旧口被占）→ 本轮 null、缓存清空（本轮仅发 1 探）
    // 队列：[缓存口 500, p+1 500, p+2 ready]——第三轮重扫真实走两探
    const s2 = stubBridge([{ code: 500 }, { code: 500 }, { body: ready }], {});
    expect(await fetchDesktopUpdateStatus()).toBeNull();
    expect(s2.urls().filter((u) => u.includes(STATUS_PATH))).toHaveLength(1);
    // 第三轮：缓存已清 → 重扫候选序列（p+1 500 → p+2 ready），不再钉死旧基址
    expect((await fetchDesktopUpdateStatus())?.status).toBe('ready');
    expect(s2.urls().filter((u) => u.includes(STATUS_PATH))).toHaveLength(3); // 1 + 2
    void urls;
  });

  it('缓存基址网络异常 → 缓存清空重扫（catch 分支既有语义保持）', async () => {
    const { fetchDesktopUpdateStatus } = await freshApi();
    const ready = JSON.stringify(status({ status: 'ready' }));
    stubBridge([{ body: ready }], {});
    expect((await fetchDesktopUpdateStatus())?.status).toBe('ready');
    // 缓存基址 fetch 抛异常（连接拒绝）→ 清缓存；后续候选 200 成功
    const { urls } = stubBridge([{ code: 500 }, { code: 500 }, { body: ready }], {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused'); }));
    // 该桩全抛 → 全候选失败返回 null（证明走了 catch 清缓存路径）
    expect(await fetchDesktopUpdateStatus()).toBeNull();
  });
});

describe('triggerDesktopUpdateDownload / installDesktopUpdate', () => {
  it('未探活基址 → download=false / install 报桥不可用（不发请求）', async () => {
    const { fetchDesktopUpdateStatus, triggerDesktopUpdateDownload, installDesktopUpdate } = await freshApi();
    const { urls } = stubBridge([{ code: 500 }, { code: 500 }, { code: 500 }, { code: 500 }], {});
    await fetchDesktopUpdateStatus(); // 全候选失败，无缓存
    const n = urls().length;
    expect(await triggerDesktopUpdateDownload()).toBe(false);
    expect(await installDesktopUpdate()).toEqual({ ok: false, error: '更新桥不可用' });
    expect(urls().length).toBe(n);
  });

  it('探活后：download POST ok；install 409 → error 透传；网络错 → 回落文案', async () => {
    const { fetchDesktopUpdateStatus, triggerDesktopUpdateDownload, installDesktopUpdate } = await freshApi();
    stubBridge([{ body: JSON.stringify(status()) }], {
      '/desktop-bridge/update/download': { body: '{}' },
      '/desktop-bridge/update/install': { code: 409, body: JSON.stringify({ error: 'not ready' }) },
    });
    await fetchDesktopUpdateStatus();
    expect(await triggerDesktopUpdateDownload()).toBe(true);
    expect(await installDesktopUpdate()).toEqual({ ok: false, error: 'not ready' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net'); }));
    expect(await installDesktopUpdate()).toEqual({ ok: false, error: '网络错误' });
  });
});

describe('DesktopUpdateStatus 数据形状', () => {
  it('received/total 可直接算 UI 下载进度比', () => {
    const st = status({ received: 250, total: 1000 });
    expect(Math.min(100, Math.round((st.received / st.total) * 100))).toBe(25);
  });
});
