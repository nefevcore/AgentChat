// ============================================================
// WorkspaceShim 沙箱消费面单测（cr-614）：会话挂载工作区即基准+授予、
// settings security.allowedPaths 并出——主线 ac-workspace 同语义。
// 数据根恒 preview/sandbox 独立目录（红线）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context } from '@agentchat/cordis';
import { WorkspaceShim, AgentsShim } from '../src/shims.ts';

const ROOT = path.resolve('preview/sandbox/workspace-shim-test-' + process.pid);
const WS_DIR = path.resolve(ROOT, 'proj'); // 模拟外挂工作区目录
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function seed(conv: string, wsId: string | null): void {
  fs.mkdirSync(path.join(ROOT, 'viewer', 'sessions', conv), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'viewer', 'sessions', conv, 'session.json'), JSON.stringify({ id: conv, workspaceId: wsId }), 'utf-8');
}

describe('WorkspaceShim 沙箱消费面（cr-614）', () => {
  it('会话挂载工作区：sandboxWorkdir 基准 = 工作区根；sandboxAllowedPaths 并入根', () => {
    fs.mkdirSync(WS_DIR, { recursive: true });
    fs.mkdirSync(path.join(ROOT), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'ws-1', name: '项目', path: WS_DIR }] }), 'utf-8');
    seed('conv-a', 'ws-1');
    const ctx = new Context();
    const shim = new WorkspaceShim(ctx, ROOT);
    expect(shim.conversationWorkspaceRoot('conv-a')).toBe(WS_DIR);
    // 挂载即基准（主线同语义——bash cwd / 相对路径锚指向工作区根）
    expect(shim.sandboxWorkdir('neko', 'conv-a')).toBe(WS_DIR);
    // 无会话 = 专用空间回落；无身份 = 数据根
    expect(shim.sandboxWorkdir('neko')).toBe(path.join(ROOT, 'files', 'neko'));
    expect(shim.sandboxAllowedPaths('neko', 'conv-a')).toEqual([WS_DIR]);
  });

  it('cr-627 宿主 owning 写者真实形态：workspaces.json 顶层数组（非包装对象）', () => {
    // ac-host-rows workspaces.ts 写的是裸数组——此前读面只认 {workspaces:[...]}
    // 包装形态，恒不命中 = conversationWorkspaceRoot 恒 null（工作区技能/
    // 沙箱授予断链根因）。两形态都必须解析成功。
    fs.mkdirSync(WS_DIR, { recursive: true });
    fs.mkdirSync(path.join(ROOT), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'workspaces.json'),
      JSON.stringify([{ id: 'ws-real', name: '仓库', path: WS_DIR, createdAt: 't', updatedAt: 't' }]), 'utf-8');
    seed('conv-host', 'ws-real');
    const ctx = new Context();
    const shim = new WorkspaceShim(ctx, ROOT);
    expect(shim.conversationWorkspaceRoot('conv-host')).toBe(WS_DIR);
    expect(shim.sandboxAllowedPaths('neko', 'conv-host')).toEqual([WS_DIR]);
  });

  it('未挂载会话 + settings security.allowedPaths 并出面（真 agents 垫片链）', () => {
    const agentDir = path.join(ROOT, 'agents', 'neko');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({
      id: 'neko', model: 'mock', tags: ['sandbox-access'],
      settings: { security: { allowedPaths: ['C:\\data\\a', '', 42] } },
    }), 'utf-8');
    const ctx = new Context();
    new AgentsShim(ctx, ROOT); // 注册 ctx.agents（settingsOf 消费面）
    const shim = new WorkspaceShim(ctx, ROOT);
    // settings 白名单并出（非字符串/空条目静默剔除——主线同语义）
    expect(shim.sandboxAllowedPaths('neko', 'conv-none')).toEqual(['C:\\data\\a']);
    // agents 服务缺席场景在第三用例覆盖（软依赖不抛）
    // 非法会话键（路径穿越）fail-safe 判未挂载
    expect(shim.conversationWorkspaceRoot('../escape')).toBeNull();
  });

  it('agents 服务缺席（软依赖）：settings 面跳过不抛', () => {
    const ctx = new Context(); // 无 agents 垫片注册
    const shim = new WorkspaceShim(ctx, ROOT);
    expect(shim.sandboxAllowedPaths('neko', 'conv-none')).toEqual([]);
  });

  it('workspaces.json / session.json 缺席或损坏 = 未挂载（不抛）', () => {
    fs.mkdirSync(path.join(ROOT, 'viewer', 'sessions', 'conv-c'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'viewer', 'sessions', 'conv-c', 'session.json'), '{oops', 'utf-8');
    fs.writeFileSync(path.join(ROOT, 'workspaces.json'), '{oops', 'utf-8');
    const ctx = new Context();
    const shim = new WorkspaceShim(ctx, ROOT);
    expect(shim.conversationWorkspaceRoot('conv-c')).toBeNull();
    expect(shim.sandboxAllowedPaths('neko', 'conv-c')).toEqual([]);
  });
});
