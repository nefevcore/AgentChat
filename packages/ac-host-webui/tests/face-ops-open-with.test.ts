// ============================================================
// face-ops-open-with.test.ts —— workspace/open-with 定位与守卫
//（cr-829 回归锚）。桩 web 面捕获 RPC 处理器；probe 面不可注入
// RPC（生产 probe）——真机面由 open-targets.test.ts 锁，此处锁定位/
// 未知 id / kind 拒三类可离线断言的行为（win32 宿主 notepad 恒可解析，
// 作为「可用目标」参与断言；解析缺席面已由纯模块测试覆盖）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerOpsFace } from '../src/face-ops.ts';
import type { Context } from '@agentchat/cordis';

const ROOT = path.join('sandbox', 'test-open-with-' + process.pid);
const WS_DIR = path.join(ROOT, 'ws-mount');

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(WS_DIR, 'src'), { recursive: true });
  fs.writeFileSync(path.join(WS_DIR, 'src', 'app.ts'), 'export {};\n');
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

describe('workspace/open-with 定位与守卫（cr-829）', () => {
  it('未知 id → error（不尝试启动）', async () => {
    const rpc = captureRpc();
    const r = await rpc('workspace/open-with', { id: 'nope', path: 'src/app.ts', conversationId: 'conv-1' });
    expect(String(r.error)).toContain('应用不可用');
  });

  it('文件不存在 → error（定位面与 open-local 同源）', async () => {
    const rpc = captureRpc();
    const r = await rpc('workspace/open-with', { id: 'vscode', path: 'no/such.ts', conversationId: 'conv-1' });
    expect(String(r.error)).toContain('文件不存在或不可读');
  });

  it('kind 守卫：仅目录目标拒文件路径', async () => {
    const rpc = captureRpc();
    const r = await rpc('workspace/open-with', { id: 'windowsterminal', path: 'src/app.ts', conversationId: 'conv-1' });
    // windowsterminal 本机未装时 = 应用不可用；装了 = kind 拒——两态都证明守卫先于启动
    expect(r.opened).toBeUndefined();
  });

  it('open-targets 清单：条目形 { id, label, kind }', async () => {
    const rpc = captureRpc();
    const r = await rpc('workspace/open-targets', {});
    const targets = r.targets as Array<{ id: string; label: string; kind: string }>;
    expect(Array.isArray(targets)).toBe(true);
    for (const t of targets) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.label).toBe('string');
      expect(['dir', 'file', 'both']).toContain(t.kind);
    }
  });
});