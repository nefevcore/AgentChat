// ============================================================
// WorkspaceShim 沙箱消费面单测（cr-614）：会话挂载工作区即基准+授予、
// settings security.allowedPaths 并出——主线 ac-workspace 同语义。
// 数据根恒 sandbox 独立目录（红线）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context } from '@agentchat/cordis';
import { WorkspaceShim, AgentsShim } from '../src/shims.ts';

// cr-755：影子形态 config 物化在 children 嵌套域——get 顶层缺席须回落
// （否则 tags 丢失 → run_code SDK 投影空）。

const ROOT = path.resolve('sandbox/workspace-shim-test-' + process.pid);
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
    // 无会话 = 专用空间回落（cr-754：首触懒建——主线 ensureAgentWorkdir
    // 同构，无人物化目录的 Agent 不再得到幻影基准）；无身份 = 数据根
    expect(shim.sandboxWorkdir('neko')).toBe(path.join(ROOT, 'files', 'neko'));
    expect(fs.existsSync(path.join(ROOT, 'files', 'neko'))).toBe(true);
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

  it('cr-755 影子形态：AgentsShim.get 顶层缺席回落 children 嵌套域（tags 可达）', () => {
    // 物化子域 config（仅嵌套域，顶层不建——影子形态事实）
    const childDir = path.join(ROOT, 'agents', 'papa', 'children', 'sub-x');
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(childDir, 'config.json'), JSON.stringify({
      id: 'sub-x', model: 'mock', tags: ['tc-programmatic', 'fs'],
    }), 'utf-8');
    const ctx = new Context();
    const shim = new AgentsShim(ctx, ROOT, undefined, 'papa');
    // 回落命中：嵌套域 config 可读，tags 完整（投影链的授权输入）
    expect(shim.get('sub-x')).toMatchObject({ id: 'sub-x', tags: ['tc-programmatic', 'fs'] });
    expect(shim.settingsOf('sub-x')).toEqual({}); // 无 settings = 空合并（不 undefined）
    // 无 parent 的 shim：顶层缺席即 undefined（原语义不变）——独立 ctx
    //（同 root 双注册 agents 服务 = 冲突）
    const bare = new AgentsShim(new Context(), ROOT);
    expect(bare.get('sub-x')).toBeUndefined();
  });

  // cr-758 显式 workdir 层：主线 ac-workspace 同序第二层——子 Agent 的
  // 工作区锚点快照（spawn 物化进 settings.security.workdir）经此层生效
  //（子会话键 parent~sub-x 是新对桶，singles 挂载信息结构上到不了子壳）。
  it('cr-758 显式 settings security.workdir：非挂载会话基准 = workdir（层序：挂载 > workdir > 专用空间）', () => {
    const WS2 = path.resolve(ROOT, 'proj2'); // 第二工作区（层序判别用）
    fs.mkdirSync(WS_DIR, { recursive: true });
    fs.mkdirSync(WS2, { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'ws-1', name: '项目', path: WS_DIR }] }), 'utf-8');
    seed('conv-mount', 'ws-1');
    // 子 config（影子嵌套域）带 workdir 快照——AgentsShim settingsOf 读取
    const childDir = path.join(ROOT, 'agents', 'papa', 'children', 'sub-x');
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(childDir, 'config.json'), JSON.stringify({
      id: 'sub-x', model: 'mock', settings: { security: { workdir: WS2 } },
    }), 'utf-8');
    // 无 workdir 的对照组 Agent
    fs.mkdirSync(path.join(ROOT, 'agents', 'plain'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'agents', 'plain', 'config.json'), JSON.stringify({ id: 'plain', model: 'mock' }), 'utf-8');
    const ctx = new Context();
    new AgentsShim(ctx, ROOT, undefined, 'papa');
    const shim = new WorkspaceShim(ctx, ROOT);
    // 子对桶会话键（singles 无记录）与无会话形态：基准 = 快照 workdir
    expect(shim.sandboxWorkdir('sub-x', 'papa~sub-x')).toBe(WS2);
    expect(shim.sandboxWorkdir('sub-x')).toBe(WS2);
    // 层序：会话挂载仍最优先（主线同序）
    expect(shim.sandboxWorkdir('sub-x', 'conv-mount')).toBe(WS_DIR);
    // 无 workdir 的 Agent 不受影响：专用空间回落
    expect(shim.sandboxWorkdir('plain')).toBe(path.join(ROOT, 'files', 'plain'));
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
