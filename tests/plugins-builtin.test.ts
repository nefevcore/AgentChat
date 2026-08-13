// ============================================================
// src/plugins/builtin + builtin-math 集成测试
//
// 验证：插件注册 → resolveTools（工厂烘焙沙箱）→ 工具可用；
//       hooks 按名解析；沙箱越界拒绝 / allowedPaths 放行。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { PluginRegistry } from '../src/plugins/registry';
import builtinPlugin from '../src/plugins/builtin';
import mathPlugin from '../src/plugins/builtin-math';
import type { AgentConfig } from '../src/agents/config';

let ws = '';
let shared = '';

beforeEach(() => {
  const base = path.join(os.tmpdir(), `agentchat-plugins-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  ws = path.join(base, 'ws');
  shared = path.join(base, 'shared');
  fs.mkdirSync(ws, { recursive: true });
  process.env.AGENTCHAT_WORKSPACE = ws;
});

afterEach(() => {
  delete process.env.AGENTCHAT_WORKSPACE;
  if (fs.existsSync(path.dirname(ws))) fs.rmSync(path.dirname(ws), { recursive: true, force: true });
});

const cfg: AgentConfig = { agent_id: 'a', name: 'A' };

describe('builtin 工具（工厂 per-Agent 烘焙）', () => {
  it('解析出 read/write/edit/bash（requires 自动注入协作/基础工具）', () => {
    const r = new PluginRegistry();
    r.register(builtinPlugin);
    const tools = r.resolveTools(['read', 'write', 'edit', 'bash'], cfg);
    // 显式声明的 4 个基础工具 + requires:['agent'] 自动注入的协作工具
    for (const name of ['read', 'write', 'edit', 'bash']) {
      expect(tools.get(name)?.definition.function.name).toBe(name);
    }
    expect(tools.get('send_agent')).toBeDefined();
    expect(tools.get('send_group')).toBeDefined();
    expect(tools.get('query_history')).toBeDefined();
    // dev 工具不满足 cfg（无 tags）→ 不注入
    expect(tools.get('browser')).toBeUndefined();
    expect(tools.get('code_search')).toBeUndefined();
  });

  it('write/read 往返（工作区内，read 输出 Hashline v2）', async () => {
    const r = new PluginRegistry();
    r.register(builtinPlugin);
    const tools = r.resolveTools(['write', 'read'], cfg);
    const write = tools.get('write')!;
    const read = tools.get('read')!;

    const w = await write.execute({ path: 'hello.txt', content: '你好，世界' });
    expect(w).toContain('已写入');
    const out = await read.execute({ path: 'hello.txt' });
    // Hashline v2：JSON 包装 + [PATH#TAG] 头部 + 行号:内容
    const parsed = JSON.parse(out as string);
    expect(parsed.status).toBe('success');
    expect(parsed.data.content).toContain('[hello.txt#');
    expect(parsed.data.content).toContain('1:你好，世界');
    expect(parsed.data.file_tag).toMatch(/^[0-9a-f]{4}$/);
  });

  it('edit 查找替换（兼容旧参数 old_string/new_string + path）', async () => {
    const r = new PluginRegistry();
    r.register(builtinPlugin);
    const tools = r.resolveTools(['write', 'edit', 'read'], cfg);
    await tools.get('write')!.execute({ path: 'a.txt', content: 'foo bar baz' });
    const e = await tools.get('edit')!.execute({ path: 'a.txt', old_string: 'bar', new_string: 'BAR' });
    const parsed = JSON.parse(e as string);
    expect(parsed.status).toBe('success');
    expect(parsed.data.edits_applied).toBeGreaterThan(0);
    const out = await tools.get('read')!.execute({ path: 'a.txt' });
    expect(JSON.parse(out as string).data.content).toContain('1:foo BAR baz');
  });

  it('越界路径被沙箱拒绝', async () => {
    const r = new PluginRegistry();
    r.register(builtinPlugin);
    const write = r.resolveTools(['write'], cfg).get('write')!;
    const read = r.resolveTools(['read'], cfg).get('read')!;
    await expect(write.execute({ path: '../escape.txt', content: 'x' })).rejects.toThrow('越界');
    await expect(read.execute({ path: '../escape.txt' })).rejects.toThrow('越界');
  });

  it('security.allowedPaths 放行（绝对路径）', async () => {
    const cfg2: AgentConfig = { agent_id: 'a', name: 'A', security: { allowedPaths: [shared] } };
    fs.mkdirSync(shared, { recursive: true });
    const r = new PluginRegistry();
    r.register(builtinPlugin);
    const write = r.resolveTools(['write'], cfg2).get('write')!;
    // 相对路径 ../shared/x.txt 应落在 shared 内
    await write.execute({ path: `../${path.basename(shared)}/x.txt`, content: 'ok' });
    expect(fs.readFileSync(path.join(shared, 'x.txt'), 'utf-8')).toBe('ok');
  });

  it('getAllowedPaths：从 security 命名空间读取；缺省 undefined（L3 归属）', async () => {
    const { getAllowedPaths } = await import('../src/plugins/builtin/tools/shared');
    const withPaths: AgentConfig = { agent_id: 'a', name: 'A', security: { allowedPaths: ['/tmp/a', '../shared'] } };
    expect(getAllowedPaths(withPaths)).toEqual(['/tmp/a', '../shared']);
    expect(getAllowedPaths({ agent_id: 'a', name: 'A' })).toBeUndefined();
  });

  it('敏感文件黑名单：内置 DENY 拒绝 ~/.agentchat / .env / *.pem 等', async () => {
    const { isDeniedPath, resolveSafePath } = await import('../src/plugins/builtin/tools/shared');
    const c: AgentConfig = { agent_id: 'a', name: 'A' };
    // 文件名模式（任意目录层级）
    expect(isDeniedPath(c, path.join(ws, '.env'))).toBe(true);
    expect(isDeniedPath(c, path.join(ws, 'a', '.env'))).toBe(true);
    expect(isDeniedPath(c, path.join(ws, 'a', 'key.pem'))).toBe(true);
    expect(isDeniedPath(c, path.join(ws, 'a', 'id_rsa'))).toBe(true);
    expect(isDeniedPath(c, path.join(ws, 'a', 'github_rsa'))).toBe(true);
    expect(isDeniedPath(c, path.join(ws, 'a', '.npmrc'))).toBe(true);
    expect(isDeniedPath(c, path.join(ws, 'a', '.git-credentials'))).toBe(true);
    // 家目录凭据目录整目录
    expect(isDeniedPath(c, path.join(os.homedir(), '.agentchat', 'credentials.json'))).toBe(true);
    // 普通文件不误伤
    expect(isDeniedPath(c, path.join(ws, 'a', 'notes.txt'))).toBe(false);
    expect(isDeniedPath(c, path.join(ws, 'a', 'env.example'))).toBe(false);
    // resolveSafePath 集成：工作区内写 .env 被拒（DENY 优先于 allow）
    expect(() => resolveSafePath(c, 'a/.env')).toThrow('敏感文件黑名单');
    expect(() => resolveSafePath(c, 'a/notes.txt')).not.toThrow();
  });

  it('security.denyPaths 追加黑名单（内置 DENY 仍生效）', async () => {
    const { isDeniedPath, getDenyPatterns } = await import('../src/plugins/builtin/tools/shared');
    const c: AgentConfig = { agent_id: 'a', name: 'A', security: { denyPaths: ['**/*.secret.txt'] } };
    expect(isDeniedPath(c, path.join(ws, 'x.secret.txt'))).toBe(true);
    expect(getDenyPatterns(c).length).toBeGreaterThan(7); // 内置 7 条 + 追加
    // 内置仍生效（追加不可覆盖内置）
    expect(isDeniedPath(c, path.join(ws, '.env'))).toBe(true);
  });
});

describe('builtin hooks', () => {
  it('按名解析 runEnd save-session 钩子', async () => {
    const r = new PluginRegistry();
    r.register(builtinPlugin);
    const res = r.resolveHooks({ runEnd: ['builtin.save-session'] }, cfg);
    expect(res.runEndHook).toHaveLength(1);

    // 无 dialogId 时安全返回
    await res.runEndHook![0]({} as any, { content: 'ok', interrupted: false, messages: [] } as any);
  });
});

describe('builtin-math（node:vm 表达式求值）', () => {
  it('注册后解析 math 并执行表达式', async () => {
    const r = new PluginRegistry();
    r.register(mathPlugin);
    const math = r.resolveTools(['math'], cfg).get('math')!;
    expect(await math.execute({ expression: '1+2*3' })).toContain('7');
    expect(await math.execute({ expression: 'sqrt(16)' })).toContain('4');
    expect(r.listPlugins().map(p => p.name)).toContain('builtin-math');
  });

  it('vm 沙箱隔离：表达式无法访问 process/require 等全局', async () => {
    const r = new PluginRegistry();
    r.register(mathPlugin);
    const math = r.resolveTools(['math'], cfg).get('math')!;
    // 访问 process 应报错（未定义），返回 error 而非泄露
    const out = await math.execute({ expression: 'process.version' });
    expect(String(out)).toContain('status":"error');
    expect(String(out)).not.toContain('node');
  });
});
