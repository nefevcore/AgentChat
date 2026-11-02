// ============================================================
// face-ops-open-local.test.ts —— workspace/open-local 上下文定位
//（cr-827 回归锚：此前相对路径恒按数据根解析，挂载工作区文件打不开）
// 桩 web 面捕获 RPC 处理器。cr-839：runNativeOpen 以模块级 mock 注入——
// 旧版真派发会在跑测试的机器上弹系统默认程序打开沙箱临时文件（文件随
// afterEach 删除 = 打开不存在的文件，无辜拉起 VSCode/记事本）。mock 后
// 断言升级：验证定位产出的绝对路径正确传给派发器（比 opened 二态强）。
// native-open 行为面由 ac-workspace/native-open.test.ts 锁。
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerOpsFace } from '../src/face-ops.ts';
import type { Context } from '@agentchat/cordis';

// runNativeOpen stub（opened 恒 true；调用参数可断言）。其余导出（parentDirOf
// 等——open-targets 链消费）经 importOriginal 保真。
vi.mock('ac-workspace/src/native-open.ts', async (importOriginal) => {
  const actual = await importOriginal<{}>();
  return { ...actual, runNativeOpen: vi.fn(async () => ({ opened: true })) };
});
import { runNativeOpen } from 'ac-workspace/src/native-open.ts';

const ROOT = path.join('sandbox', 'test-open-local-' + process.pid);
const WS_DIR = path.join(ROOT, 'ws-mount');

beforeEach(() => {
  vi.mocked(runNativeOpen).mockClear();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(WS_DIR, 'src'), { recursive: true });
  fs.writeFileSync(path.join(WS_DIR, 'src', 'app.ts'), 'export {}\n');
  fs.writeFileSync(path.join(ROOT, 'workspaces.json'), JSON.stringify([{ id: 'ws-1', name: 'ws', path: WS_DIR, createdAt: '', updatedAt: '' }]));
  fs.mkdirSync(path.join(ROOT, 'viewer', 'sessions', 'conv-1'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'viewer', 'sessions', 'conv-1', 'session.json'), JSON.stringify({ id: 'conv-1', agentId: 'neko', workspaceId: 'ws-1', status: 'active', createdAt: '', updatedAt: '' }));
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function captureRpc(): (method: string, params: unknown) => Promise<Record<string, unknown>> {
  const handlers = new Map<string, (params: unknown) => unknown>();
  registerOpsFace(
    { registerRpc: (m: string, h: (params: unknown) => unknown) => { handlers.set(m, h); } },
    {} as Context,
    { dataRoot: ROOT },
  );
  return (method, params) => Promise.resolve(handlers.get(method)!(params) as Promise<Record<string, unknown>>);
}

describe('workspace/open-local 上下文定位（cr-827）', () => {
  it('会话挂载工作区的相对路径可打开（按 session.json workspaceId 推导基准）', async () => {
    const rpc = captureRpc();
    const r = await rpc('workspace/open-local', { path: 'src/app.ts', conversationId: 'conv-1' });
    expect(r.error).toBeUndefined();
    expect(r.opened).toBe(true);
    // 定位产出的绝对路径正确传给派发器（挂载工作区基准）
    expect(vi.mocked(runNativeOpen).mock.calls.map((c) => c[0])).toEqual([path.resolve(WS_DIR, 'src', 'app.ts')]);
  });

  it('无上下文的相对路径仍按数据根解析（数据根内不存在 = error，不派发）', async () => {
    const rpc = captureRpc();
    const r = await rpc('workspace/open-local', { path: 'src/app.ts' });
    expect(String(r.error)).toContain('文件不存在或不可读');
    expect(vi.mocked(runNativeOpen)).not.toHaveBeenCalled();
  });

  it('数据根内文件（无上下文）与 agentId 基准推导均可命中', async () => {
    fs.writeFileSync(path.join(ROOT, 'note.md'), 'hi');
    fs.mkdirSync(path.join(ROOT, 'files', 'neko'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'files', 'neko', 'memo.txt'), 'm');
    fs.mkdirSync(path.join(ROOT, 'agents', 'neko'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'agents', 'neko', 'config.json'), JSON.stringify({ id: 'neko' }));
    const rpc = captureRpc();
    expect((await rpc('workspace/open-local', { path: 'note.md' })).opened).toBe(true);
    expect((await rpc('workspace/open-local', { path: 'memo.txt', agentId: 'neko' })).opened).toBe(true);
    expect(vi.mocked(runNativeOpen).mock.calls.map((c) => c[0])).toEqual([
      path.resolve(ROOT, 'note.md'),
      path.resolve(ROOT, 'files', 'neko', 'memo.txt'),
    ]);
  });
});