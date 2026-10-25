// ============================================================
// ac-client-ui-desktop-storage/tests/desktop-bridge-client.test.ts
// —— 桥客户端降级语义锁（非桌面形态自探失败 → 节静默隐藏）
//
// bridge.ts 的 useDesktopBridge 是本节「非桌面形态自动降级隐藏」的
// 全部前提（src/index.ts 头注与 StorageHost 门控 v-if="ready && info"
// 都指向它）。此前该模块全仓零测试：壳层桥服务端回归（startBridge
// 端口防御链）住 desktop/tests，但客户端探测逻辑从未锁定。cr-481
// 补锁四条契约：候选序列形状、探活失败降级、非 ok 顺延、基址复用。
//（jsdom 环境供 location/fetch 桩；vi.resetModules 隔离模块级 bridgeBase；
//  端口按 location.port 动态匹配——jsdom 缺省 3000，不硬编码）
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// @vitest-environment jsdom

describe('useDesktopBridge 降级语义（bridge.ts）', () => {
  const fetchMock = vi.fn();
  let warn: ReturnType<typeof vi.spyOn> | undefined;
  const port = () => Number(location.port); // jsdom 缺省 3000
  /** 构造 StorageInfo 应答 */
  const infoJson = (p: string) => async () => ({ dataRoot: p, defaultDataRoot: p, customized: false, total: 1, breakdown: {}, platform: 'win32' });

  beforeEach(() => {
    vi.resetModules(); // 模块级 bridgeBase 每用例重置
    vi.stubGlobal('fetch', fetchMock);
    // jsdom 缺 AbortSignal.timeout —— 用 abort 信号替身（探活立即失败即可）
    vi.stubGlobal('AbortSignal', Object.assign(AbortSignal, { timeout: () => AbortSignal.abort() }));
    fetchMock.mockReset();
    // 桥不可达时 fetch reject——抑制 jsdom 控制台噪音
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    warn?.mockRestore();
  });

  it('候选序列：page port+1..+4 依序探测，首个成功者胜出并缓存基址', async () => {
    const P = port();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes(`:${P + 3}/`)) {
        return { ok: true, json: infoJson('/d') };
      }
      throw new TypeError('fetch failed');
    });
    const { useDesktopBridge } = await import('../client/bridge.ts');
    const b = useDesktopBridge();
    await vi.waitFor(() => expect(b.ready.value).toBe(true));
    expect(b.info.value?.dataRoot).toBe('/d');
    // 基址复用：后续 pick 不再探测，直发胜出候选
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ canceled: false, path: '/new' }) });
    await b.pick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`:${P + 3}/`);
  });

  it('全候选失败 → ready=false（非桌面形态降级：StorageHost 门控隐藏本节）', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    const { useDesktopBridge } = await import('../client/bridge.ts');
    const b = useDesktopBridge();
    // ready=false 是初始态——以四候选探尽为完成信号再断言终态
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(b.ready.value).toBe(false);
    expect(b.info.value).toBeNull();
  });

  it('非 ok 应答视同不可达 → 顺延次候选（端口被占场景）', async () => {
    const P = port();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes(`:${P + 1}/`)) return { ok: false, status: 404 };
      if (String(url).includes(`:${P + 2}/`)) {
        return { ok: true, json: infoJson('/x') };
      }
      throw new TypeError('unreachable');
    });
    const { useDesktopBridge } = await import('../client/bridge.ts');
    const b = useDesktopBridge();
    await vi.waitFor(() => expect(b.ready.value).toBe(true));
    expect(b.info.value).not.toBeNull();
  });

  it('未探活调 pick/setRoot → 拒绝（防御性兜底抛错，不静默空转）', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    const { useDesktopBridge } = await import('../client/bridge.ts');
    const b = useDesktopBridge();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4)); // 探测收束
    fetchMock.mockReset();
    await expect(b.pick()).rejects.toThrow(/不可用/);
    await expect(b.setRoot('/p', true)).rejects.toThrow(/不可用/);
    expect(fetchMock).not.toHaveBeenCalled(); // 未发起网络请求
  });
});
