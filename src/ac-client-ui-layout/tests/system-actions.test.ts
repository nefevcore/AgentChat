// ============================================================
// ac-client-ui-layout/tests/system-actions.test.ts —— 备份执行器/
// 版本检查单源（cr-332 并源）行为锁 + kit 图标消费面锁。
//
// 备份 toast 反馈（busy → ok/error 同 key 原位刷新）此前零测试——
// 两份内联实现已走散正是无锁之故；并源后锁单点。node 环境。
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBackupRunner, checkUpdateOnce } from '../client/systemActions.ts';

// mock 对象经 vi.hoisted 提升（vi.mock 工厂在模块加载前执行——不能引用
// 顶层变量；vi.hoisted 是 vitest 的合法提升通道）
const mocks = vi.hoisted(() => ({
  toastBusy: vi.fn(), toastOk: vi.fn(), toastError: vi.fn(),
  backupNow: vi.fn(), fetchVersion: vi.fn(),
}));
// toast 单例 mock（webui-kit 全局态——单测不渲染 ToastHost，直捕写口）
vi.mock('@agentchat/webui-kit', () => ({
  toastBusy: mocks.toastBusy,
  toastOk: mocks.toastOk,
  toastError: mocks.toastError,
}));
// systemApi mock（RPC 边界外置——只测执行器编排）
vi.mock('ac-client-ui-system/client/systemApi.ts', () => ({
  backupNow: mocks.backupNow,
  fetchVersion: mocks.fetchVersion,
}));

const { toastBusy, toastOk, toastError, backupNow, fetchVersion } = mocks;

// localStorage 垫片（node 环境无 window——checkUpdateOnce 读 simulateUpdate 通道）
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

beforeEach(() => {
  for (const fn of [toastBusy, toastOk, toastError, backupNow, fetchVersion]) fn.mockClear();
});

describe('createBackupRunner（备份执行器单源）', () => {
  it('成功路径：busy → ok 同 key 原位刷新；完成后 busy 复位', async () => {
    backupNow.mockResolvedValueOnce({ status: 'ok', file: 'b.zip', size: 2 * 1024 * 1024, keep: 3 });
    const { busy, run } = createBackupRunner({} as never);
    const p = run();
    expect(busy.value).toBe(true);
    expect(toastBusy).toHaveBeenCalledWith('正在备份…', { key: 'backup' });
    await p;
    expect(toastOk).toHaveBeenCalledWith('备份完成：b.zip（2.0MB，保留 3 份）', { key: 'backup' });
    expect(busy.value).toBe(false);
  });

  it('业务失败路径（status≠ok）：toastError 原位刷新', async () => {
    backupNow.mockResolvedValueOnce({ status: 'err', error: '磁盘满' });
    const { run } = createBackupRunner({} as never);
    await run();
    expect(toastError).toHaveBeenCalledWith('备份失败：磁盘满', { key: 'backup' });
  });

  it('异常路径（RPC reject）：错误消息透传', async () => {
    backupNow.mockRejectedValueOnce(new Error('网络错误'));
    const { run } = createBackupRunner({} as never);
    await run();
    expect(toastError).toHaveBeenCalledWith('备份失败：网络错误', { key: 'backup' });
  });

  it('busy 防重入：执行中再点 = no-op（不二次发 RPC）', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    backupNow.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    const { busy, run } = createBackupRunner({} as never);
    const first = run();
    await run(); // busy 中再点
    expect(backupNow).toHaveBeenCalledTimes(1);
    resolveFirst({ status: 'ok' });
    await first;
    expect(busy.value).toBe(false);
  });
});

describe('checkUpdateOnce（版本检查单源）', () => {
  it('hasUpdate 透传；失败静默 false（不误报红点）', async () => {
    fetchVersion.mockResolvedValueOnce({ hasUpdate: true });
    expect(await checkUpdateOnce({} as never)).toBe(true);
    fetchVersion.mockResolvedValueOnce({ hasUpdate: false });
    expect(await checkUpdateOnce({} as never)).toBe(false);
    fetchVersion.mockRejectedValueOnce(new Error('offline'));
    expect(await checkUpdateOnce(undefined)).toBe(false);
  });
});
