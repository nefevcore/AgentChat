// ============================================================
// ac-workspace：目录/脚本分发 + 默认 user(virtual)/admin register +
// 首启消息（经 session append）+ 二次启动幂等 + virtual 短路
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import { ConfigService } from 'ac-config';
import * as agentsRow from 'ac-agents';
import * as agentStoreRow from 'ac-agent-store';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from 'ac-session';
import * as toolsRow from 'ac-tools';
import * as workspaceRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-workspace-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string, options: Record<string, unknown> = {}, withRouter = false) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = withRouter
    ? [toolsRow, llmRow, loopRow, agentStoreRow, agentsRow, routerRow, sessionRow, workspaceRow]
    : [agentStoreRow, agentsRow, sessionRow, workspaceRow];
  const configs: Record<string, unknown> = {
    'ac-agent-store': { root },
    'ac-session': { root },
    'ac-workspace': { root, ...options },
  };
  for (const row of rows) {
    const name = (row as { name: string }).name;
    const fiber =
      configs[name] === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, configs[name]);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).workspace) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('上传引用双形态解析 + 内容寻址去重（多模态/缩略图链路）', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  it('resolveFile/readFile：files/ 前缀（上传返回形）直通 + 数据根锚定 + 敏感遮蔽', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const up = ctx.workspace.saveUpload('admin', 'dot.png', PNG);
    // files/ 前缀（上传返回形——raw 直链/物化/预览的通用引用；
    // 会话区重构二轮：锚点上移数据根，files 是真实子目录直通）
    expect(ctx.workspace.resolveFile(up.path)).toBe(path.resolve(root, 'files', 'admin', '_tmp', up.storedName));
    // readFile 同款（预览端点）
    expect(ctx.workspace.readFile(up.path).base64).toBe(true);
    // 数据根相对的其他路径同样可达（树形——agents 域文件等）
    fs.mkdirSync(path.join(root, 'agents', 'bot'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', 'bot', 'config.json'), '{}');
    expect(ctx.workspace.readFile('agents/bot/config.json').content).toBe('{}');
    // 敏感遮蔽已停用（2026-12 裁决：本地单用户应用，泄露后果用户自担）：
    // 控制面文件树可见、读口可读（恢复遮蔽时还原为 toThrow(/敏感文件/)）
    fs.writeFileSync(path.join(root, 'config.json'), '{"llmProviders":{}}');
    fs.writeFileSync(path.join(root, 'credentials.json'), '{"vault":{}}');
    const rootTree = ctx.workspace.tree('');
    expect(rootTree.children.some((c) => c.name === 'config.json')).toBe(true);
    expect(rootTree.children.some((c) => c.name === 'credentials.json')).toBe(true);
    expect(rootTree.children.some((c) => c.name === 'files' && c.type === 'dir')).toBe(true);
    expect(ctx.workspace.readFile('config.json').content).toBe('{"llmProviders":{}}');
    expect(ctx.workspace.resolveFile('credentials.json')).toBe(path.resolve(root, 'credentials.json'));
    // 内置文件名模式（任意层级）同停用：files 下的 .env 读口可读；
    // 数据根基准内 dotfile 仍不入树（控制面噪音口径——外挂工作区
    // 才是用户内容，dotfile 如实入树见下侧用例）
    fs.writeFileSync(path.join(root, 'files', 'admin', '.env'), 'SECRET=1');
    const filesTree = ctx.workspace.tree('files/admin');
    expect(filesTree.children.some((c) => c.name === '.env')).toBe(false); // dotfile 不入树（数据根基准口径不变）
    expect(ctx.workspace.readFile('files/admin/.env').content).toBe('SECRET=1'); // 读口不再拒
  });

  it('resolveFile 路径守卫：别名词形（win32 大小写/junction·symlink）不误拦；../ 逃逸照拒', async ({ skip }) => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    fs.mkdirSync(path.join(root, 'files', 'admin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'files', 'admin', 'x.txt'), 'x');
    // ../ 逃逸照拒（词法真越界——身份回退只追加放行，不放宽逃逸）
    expect(() => ctx.workspace.resolveFile('../outside.txt')).toThrow(/路径越界/);
    // 别名：兄弟 symlink/junction 指进 files/admin（词法失配、身份回退放行）
    const alias = path.join(os.tmpdir(), `ac-ws-alias-${Date.now().toString(36)}`);
    try {
      fs.symlinkSync(path.join(root, 'files', 'admin'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      skip('当前环境不支持 symlink/junction');
      return;
    }
    tmps.push(alias); // afterEach 统一清理
    expect(ctx.workspace.resolveFile(path.join(alias, 'x.txt'))).toBe(path.join(alias, 'x.txt'));
    // win32：同一文件的大小写变体（手输/拼贴绝对路径的常见词形）
    if (process.platform === 'win32') {
      const upper = path.join(root.toUpperCase(), 'files', 'admin', 'x.txt');
      expect(ctx.workspace.resolveFile(upper)).toBe(upper);
    }
  });

  it('saveUpload 内容寻址：同内容幂等（同 path、磁盘单文件），异内容共存', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const a1 = ctx.workspace.saveUpload('admin', 'a.png', PNG);
    const a2 = ctx.workspace.saveUpload('admin', '重命名同内容.png', PNG); // 不同名同内容
    expect(a2.path).toBe(a1.path); // 同内容同 path
    expect(a2.storedName).toBe(a1.storedName);
    const dir = path.join(root, 'files', 'admin', '_tmp');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
    expect(files).toHaveLength(1); // 磁盘零重复
    // 异内容共存（不同 hash）
    const b = ctx.workspace.saveUpload('admin', 'b.png', Buffer.concat([PNG, PNG]));
    expect(b.path).not.toBe(a1.path);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.png'))).toHaveLength(2);
  });

  it('saveUpload 会话感知：agentId 缺席 + 独立会话 sid → 推导承载 Agent 桶（经 ensureAgentWorkdir）', async () => {
    const root = tmpRoot();
    // stub singles：sid → agentId（与 bootWithSingles 同款结构面，多暴露 agentId）
    const h = await boot(root);
    const { Service } = await import('@agentchat/cordis');
    class SinglesStub extends Service {
      constructor(c: any) {
        super(c, 'singles');
      }
      get(sid: string): { workspaceId?: string; agentId?: string } | null {
        return sid === 'sid-neko' ? { agentId: 'neko' } : null;
      }
    }
    void new SinglesStub(h.ctx as any);
    // 常规 Agent（非预设）：桶 = 专用空间 files/neko（ensureAgentWorkdir 事实源）
    const up = h.ctx.workspace.saveUpload(undefined, 'x.png', PNG, 'sid-neko');
    expect(up.path).toBe('files/neko/_tmp/' + up.storedName);
    expect(fs.existsSync(path.join(root, 'files', 'neko', '_tmp', up.storedName))).toBe(true);
    // 显式 agentId 仍最优先（不因 conversationId 分流）
    const direct = h.ctx.workspace.saveUpload('admin', 'x.png', PNG, 'sid-neko');
    expect(direct.path).toBe('files/admin/_tmp/' + direct.storedName);
    // 非独立会话 / 未登记承载 Agent → shared 兜底（原行为）
    const fallback = h.ctx.workspace.saveUpload(undefined, 'x.png', PNG, 'sid-none');
    expect(fallback.path).toBe('files/shared/_tmp/' + fallback.storedName);
  });

  it('saveUpload 会话感知：预设承载 Agent → 直建 files/<id>/_tmp（无专用空间，read 基准 = 数据根）', async () => {
    const root = tmpRoot();
    const h = await boot(root);
    const { Service } = await import('@agentchat/cordis');
    class SinglesStub extends Service {
      constructor(c: any) {
        super(c, 'singles');
      }
      get(sid: string): { workspaceId?: string; agentId?: string } | null {
        return sid === 'sid-preset' ? { agentId: 'researcher' } : null;
      }
    }
    void new SinglesStub(h.ctx as any);
    // 预设 Agent 不在 agents 注册表（isPresetLike）→ 不走专用空间事实源，
    // 直建 files/researcher/_tmp（桶随会话承载 Agent 分桶；预设 read 基准 =
    // 数据根，files/ 前缀引用相对根可达）
    const up = h.ctx.workspace.saveUpload(undefined, 'y.png', PNG, 'sid-preset');
    expect(up.path).toBe('files/researcher/_tmp/' + up.storedName);
    expect(fs.existsSync(path.join(root, 'files', 'researcher', '_tmp', up.storedName))).toBe(true);
  });
});

describe('ac-workspace 读面工作区推导（M32：Agent 回复相对路径按基准定位）', () => {
  /** stub singles（conversationWorkspaceRoot 消费 get(sid) → workspaceId 结构面） */
  async function bootWithSingles(root: string, sessions: Map<string, { workspaceId?: string }>) {
    const h = await boot(root);
    const { Service } = await import('@agentchat/cordis');
    class SinglesStub extends Service {
      constructor(c: any) {
        super(c, 'singles');
      }
      get(sid: string): { workspaceId?: string } | null {
        return sessions.get(sid) ?? null;
      }
    }
    void new SinglesStub(h.ctx as any);
    return h;
  }

  it('Agent 专用空间基准：files/<id>/ 内文件可经相对路径读（displayPath = 绝对路径）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'neko', model: 'm' });
    const dir = path.join(root, 'files', 'neko', 'notes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.md'), 'hi');
    // 相对引用（Agent 回复形）：数据根未命中 → files/neko 基准命中
    const r = ctx.workspace.readFile('notes/a.md', undefined, { agentId: 'neko' });
    expect(r.content).toBe('hi');
    expect(r.path).toBe(path.join(dir, 'a.md'));
    // 绝对路径引用（Agent 回复内联绝对路径形）同样可读
    expect(ctx.workspace.readFile(path.join(dir, 'a.md'), undefined, { agentId: 'neko' }).content).toBe('hi');
    // resolveFile 同源推导
    expect(ctx.workspace.resolveFile('notes/a.md', { agentId: 'neko' })).toBe(path.join(dir, 'a.md'));
    // 无 context：相对路径照旧未命中（原行为——ENOENT 直抛，HTTP 面转 404）
    expect(() => ctx.workspace.readFile('notes/a.md')).toThrow();
  });

  it('会话挂载工作区基准（single）：优先于 Agent 基准；数据根优先于一切', async () => {
    const root = tmpRoot();
    const sessions = new Map<string, { workspaceId?: string }>();
    const { ctx } = await bootWithSingles(root, sessions);
    // 登记工作区 + 造文件
    const wsRoot = path.join(root, 'project');
    fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'src', 'app.ts'), 'export {}');
    const reg = ctx.workspace.registerWorkspace(wsRoot);
    sessions.set('sid-1', { workspaceId: reg.id });
    ctx.agents.register({ id: 'plain', model: 'm' });

    // 挂载会话：相对引用命中工作区（会话基准最优先——Agent 专用空间不存在同名文件）
    const r = ctx.workspace.readFile('src/app.ts', undefined, { agentId: 'plain', conversationId: 'sid-1' });
    expect(r.content).toBe('export {}');
    expect(r.path).toBe(path.join(wsRoot, 'src', 'app.ts'));

    // 数据根快路径优先：根内同名文件存在时数据根命中（displayPath = 原相对形）
    fs.mkdirSync(path.join(root, 'shared-pkg'), { recursive: true });
    fs.mkdirSync(path.join(wsRoot, 'shared-pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'shared-pkg', 'root-first.txt'), 'root');
    fs.writeFileSync(path.join(wsRoot, 'shared-pkg', 'root-first.txt'), 'ws');
    const r2 = ctx.workspace.readFile('shared-pkg/root-first.txt', undefined, { conversationId: 'sid-1' });
    expect(r2.content).toBe('root');
    expect(r2.path).toBe('shared-pkg/root-first.txt');

    // 未挂载会话 / 无 context：相对路径不在数据根 → 未命中（原行为）
    expect(() => ctx.workspace.readFile('src/app.ts', undefined, { agentId: 'plain' })).toThrow(/不存在|ENOENT/);
    expect(() => ctx.workspace.readFile('src/app.ts')).toThrow(/不存在|ENOENT/);
  });

  it('越界与敏感遮蔽在基准推导内照拦：../ 逃逸拒、.env/凭据名拒', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'neko', model: 'm' });
    fs.mkdirSync(path.join(root, 'files', 'neko'), { recursive: true });
    fs.writeFileSync(path.join(root, 'files', 'neko', 'secret.txt'), 'x');
    fs.writeFileSync(path.join(root, 'files', 'neko', '.env'), 'SECRET=1');
    // ../ 逃逸（基准外）：不命中（不抛越界——静默跳过候选）
    expect(() => ctx.workspace.readFile('../outside.txt', undefined, { agentId: 'neko' })).toThrow(/不存在/);
    // 敏感遮蔽已停用（2026-12 裁决）：.env 在基准内存在 → 直接可读
    expect(ctx.workspace.readFile('.env', undefined, { agentId: 'neko' }).content).toBe('SECRET=1');
    // 根外绝对路径（数据根外）：不落任何基准 → 404
    const alien = path.join(os.tmpdir(), `ac-ws-alien-${Date.now().toString(36)}.txt`);
    fs.writeFileSync(alien, 'x');
    tmps.push(alien);
    expect(() => ctx.workspace.readFile(alien, undefined, { agentId: 'neko' })).toThrow(/不存在/);
  });
});

describe('ac-workspace 初始化', () => {
  it('首启：目录布局 + browser 脚本分发 + user/admin 物化 + 首启消息入会话流', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, { admin: { model: 'glm-5.3' } });
    // 目录 + 脚本分发
    expect(fs.existsSync(path.join(root, 'files', 'shared', 'scripts'))).toBe(true);
    const daemon = path.join(root, 'files', 'shared', 'scripts', 'browser_daemon.py');
    expect(fs.existsSync(daemon)).toBe(true);
    expect(fs.statSync(daemon).size).toBeGreaterThan(0);
    // user = virtual 数据；admin = 配置数据
    expect(ctx.agents.get('user')).toMatchObject({ id: 'user', virtual: true });
    expect(ctx.agents.get('admin')).toMatchObject({ id: 'admin', model: 'glm-5.3' });
    expect(ctx.workspace.isFirstRun).toBe(true);
    // store 持久化（重启物化依据）
    expect(ctx.agentStore.getAgent('user')?.virtual).toBe(true);
    expect(ctx.agentStore.getAgent('admin')?.model).toBe('glm-5.3');
    // 首启消息经 session append API 落盘（admin⇄user 对桶，M19）
    const file = path.join(root, 'sessions', 'admin~user', 'messages.jsonl');
    for (let i = 0; i < 500; i++) {
      if (fs.existsSync(file)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    // 头行（D8）+ 首启消息各一行
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: 'session-header', version: 1 });
    expect(lines[1]).toMatchObject({ role: 'agent', agent_id: 'admin', content: expect.stringContaining('第一次启动') });
    // 首启标记
    expect(fs.existsSync(path.join(root, '.initialized'))).toBe(true);
  });

  it('二次启动：非首启、不重复注入；store 数据照常物化', async () => {
    const root = tmpRoot();
    await boot(root, { admin: { model: 'glm-5.3' } });
    const second = await boot(root, { admin: { model: 'glm-5.3' } });
    expect(second.ctx.workspace.isFirstRun).toBe(false);
    const file = path.join(root, 'sessions', 'admin~user', 'messages.jsonl');
    for (let i = 0; i < 500; i++) {
      if (fs.existsSync(file)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2); // 头行 + 只有一条首启消息
    // 已在 store 的 agent 配置不被覆盖（admin model 保持）
    expect(second.ctx.agents.get('admin')?.model).toBe('glm-5.3');
    expect(second.ctx.agents.get('user')?.virtual).toBe(true);
  });

  it('无 admin 配置：只建 user（virtual），不建 admin，intro 不注入', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    expect(ctx.agents.has('user')).toBe(true);
    expect(ctx.agents.has('admin')).toBe(false);
    expect(fs.existsSync(path.join(root, 'sessions', 'admin'))).toBe(false);
  });

  it('virtual Agent 投递短路：router 只记 message-received，不跑 loop 不回话', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, {}, true);
    const events: string[] = [];
    ctx.on('router/message-received', () => events.push('received'));
    ctx.on('router/reply-completed', () => events.push('reply'));
    const run = await ctx.router.send('user', '你好');
    expect(events).toEqual(['received']); // 只入站记账，无回复事件
    expect(run.finish).toBe('stop');
    expect(run.steps).toEqual([]);
    // 入站消息进了 user 自会话对桶（pairKey('user','user')，M19 对键缺省；
    // 中性行 agent_id=user，匿名视角投影为 user）
    const log = await ctx.session.history('user~user');
    expect(log).toEqual([{ role: 'user', content: '你好', name: 'user' }]);
  });
});

describe('ac-workspace 本机目录浏览（M18 白名单弹窗数据源）', () => {
  it('browseDirs("") → 快捷根（含数据根）；browseDirs(abs) → 只列子目录 + parent；相对路径/不存在 → error', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 快捷根：数据根在册；Windows 下至少有系统盘
    const base = ctx.workspace.browseDirs('');
    expect(base.roots?.some((r) => r.path === root)).toBe(true);
    expect(base.roots?.length).toBeGreaterThan(0);

    // 造目录：两个子目录 + 一个文件
    fs.mkdirSync(path.join(root, 'dir-a', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dir-b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'noise.txt'), 'x');

    const res = ctx.workspace.browseDirs(root);
    const names = res.dirs.map((d) => d.name);
    expect(names).toContain('dir-a');
    expect(names).toContain('dir-b');
    expect(names).not.toContain('noise.txt'); // 文件不列
    expect(names).toContain('files'); // 既有目录（初始化建的）照列
    expect(typeof res.parent).toBe('string');

    // 下钻 + 上翻
    const nested = ctx.workspace.browseDirs(path.join(root, 'dir-a'));
    expect(nested.dirs.map((d) => d.name)).toEqual(['nested']);
    expect(nested.parent).toBe(path.resolve(root));

    // 相对路径 → error 字段（不抛错）
    const rel = ctx.workspace.browseDirs('relative/x');
    expect(rel.error).toContain('绝对路径');

    // 不存在路径 → error 字段（不抛错，弹窗降级显示）
    const missing = ctx.workspace.browseDirs(path.join(root, 'no-such-dir'));
    expect(typeof missing.error).toBe('string');
  });
});

describe('ac-workspace Agent 专用空间（M18 #3）', () => {
  it('agentWorkdir：常规 = files/<id>；预设/未知 = 工作区根；ensure 懒建目录', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'neko', model: 'm' });
    ctx.agents.register({ id: '__standard__', model: 'm', preset: true });

    expect(ctx.workspace.agentWorkdir('neko')).toBe(path.join(root, 'files', 'neko'));
    expect(ctx.workspace.agentWorkdir('__standard__')).toBe(root);
    expect(ctx.workspace.agentWorkdir('ghost')).toBe(root);

    // ensure：懒建目录 + 幂等
    const dir = ctx.workspace.ensureAgentWorkdir('neko');
    expect(dir).toBe(path.join(root, 'files', 'neko'));
    expect(fs.existsSync(dir)).toBe(true);
    expect(ctx.workspace.ensureAgentWorkdir('neko')).toBe(dir);
  });

  it('sandboxWorkdir（无会话工作区时）：显式 settings.security.workdir 最优先 > 专用空间 > 预设=根 > 未知=undefined', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({
      id: 'neko',
      model: 'm',
      settings: { security: { workdir: path.join(root, 'mounted') } },
    });
    ctx.agents.register({ id: 'plain', model: 'm' });
    ctx.agents.register({ id: '__standard__', model: 'm', preset: true });

    expect(ctx.workspace.sandboxWorkdir('neko')).toBe(path.join(root, 'mounted'));
    expect(ctx.workspace.sandboxWorkdir('plain')).toBe(path.join(root, 'files', 'plain'));
    expect(ctx.workspace.sandboxWorkdir('__standard__')).toBe(root);
    expect(ctx.workspace.sandboxWorkdir('ghost')).toBeUndefined();
    expect(ctx.workspace.sandboxWorkdir(undefined)).toBeUndefined();
  });

  it('sandboxAllowedPaths：settingsOf 合成（差异层 allowedPaths）；无身份=空、非法条目剔除', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({
      id: 'neko',
      model: 'm',
      settings: { security: { allowedPaths: [path.join(root, 'mounted'), ' ', 42] } },
    });
    ctx.agents.register({ id: 'plain', model: 'm' });

    expect(ctx.workspace.sandboxAllowedPaths('neko')).toEqual([path.join(root, 'mounted')]);
    expect(ctx.workspace.sandboxAllowedPaths('plain')).toEqual([]);
    // 未知 id 回落全局层（未装 config 行 → 空）；无执行身份恒空
    expect(ctx.workspace.sandboxAllowedPaths('ghost')).toEqual([]);
    expect(ctx.workspace.sandboxAllowedPaths(undefined)).toEqual([]);
  });

  it('sandboxAllowedPaths：全局默认层授予 × 差异层形状（allowedPaths 端到端陷阱锁定）', async () => {
    const root = tmpRoot();
    const granted = path.join(root, 'repo-root');
    // 全局默认层授予（插件库·全局默认层写 config/set → settings.security）
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({ settings: { security: { allowedPaths: [granted] } } }),
    );
    const { ctx } = await boot(root);
    void new ConfigService(ctx, { root });

    // 差异层无该键 → 全局授予合成生效（bash/fs 工具行基线允许根包含授予）
    ctx.agents.register({ id: 'follower', model: 'm' });
    expect(ctx.workspace.sandboxAllowedPaths('follower')).toEqual([granted]);

    // 差异层非空数组 → 数组整体替换（差异层优先，合法覆盖语义）
    ctx.agents.register({
      id: 'narrowed',
      model: 'm',
      settings: { security: { allowedPaths: [path.join(root, 'own')] } },
    });
    expect(ctx.workspace.sandboxAllowedPaths('narrowed')).toEqual([path.join(root, 'own')]);

    // 差异层显式空数组 = 显式清除全局授予（陷阱形态：UI 物化未填列表为 []
    // 会静默顶掉全局层——保存面应省略空列表而非写 []；此语义为有意设计）
    ctx.agents.register({ id: 'cleared', model: 'm', settings: { security: { allowedPaths: [] } } });
    expect(ctx.workspace.sandboxAllowedPaths('cleared')).toEqual([]);
  });

  it('会话挂载工作区 = 会话级工作目录 + 授予根：sandboxWorkdir 基准指向工作区；conversationWorkspaceRoot 唯一事实源 + sandboxAllowedPaths 并入/去重', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // stub singles（workspace 只消费 get(sid) → workspaceId 结构面；
    // cordis Service 直构——与 ConfigService 直构同款测试姿势）
    const sessions = new Map<string, { workspaceId?: string }>();
    const { Service } = await import('@agentchat/cordis');
    class SinglesStub extends Service {
      constructor(c: any) {
        super(c, 'singles');
      }
      get(sid: string): { workspaceId?: string } | null {
        return sessions.get(sid) ?? null;
      }
    }
    void new SinglesStub(ctx as any);

    const wsRoot = path.join(root, 'project');
    fs.mkdirSync(wsRoot, { recursive: true });
    const reg = ctx.workspace.registerWorkspace(wsRoot);
    sessions.set('sid-attached', { workspaceId: reg.id });
    sessions.set('sid-bare', {});

    // conversationWorkspaceRoot：挂载 → 路径；未挂/非 singles/未知 id → null
    expect(ctx.workspace.conversationWorkspaceRoot('sid-attached')).toBe(wsRoot);
    expect(ctx.workspace.conversationWorkspaceRoot('sid-bare')).toBeNull();
    expect(ctx.workspace.conversationWorkspaceRoot('no-such')).toBeNull();
    expect(ctx.workspace.conversationWorkspaceRoot(undefined)).toBeNull();

    // sandboxWorkdir：挂载会话 → 基准 = 工作区根（会话级工作目录——
    // 最优先，显式 settings.workdir 也让位；会话资产语义，无执行身份也
    // 生效）；未挂会话/不带会话键 = Agent 级基准不变
    ctx.agents.register({ id: 'plain', model: 'm' });
    expect(ctx.workspace.sandboxWorkdir('plain', 'sid-attached')).toBe(wsRoot);
    expect(ctx.workspace.sandboxWorkdir(undefined, 'sid-attached')).toBe(wsRoot);
    ctx.agents.register({
      id: 'pinned',
      model: 'm',
      settings: { security: { workdir: path.join(root, 'pinned-dir') } },
    });
    expect(ctx.workspace.sandboxWorkdir('pinned', 'sid-attached')).toBe(wsRoot);
    expect(ctx.workspace.sandboxWorkdir('plain', 'sid-bare')).toBe(path.join(root, 'files', 'plain'));
    expect(ctx.workspace.sandboxWorkdir('plain')).toBe(path.join(root, 'files', 'plain'));

    // sandboxAllowedPaths：会话根并入（settings 授予 ∪ 会话根，去重）；
    // 无执行身份也会话根照常授予（会话资产语义）
    expect(ctx.workspace.sandboxAllowedPaths('plain', 'sid-attached')).toEqual([wsRoot]);
    expect(ctx.workspace.sandboxAllowedPaths(undefined, 'sid-attached')).toEqual([wsRoot]);
    // settings 授予与会话根同路径 → 去重
    ctx.agents.register({
      id: 'granted',
      model: 'm',
      settings: { security: { allowedPaths: [wsRoot, path.join(root, 'extra')] } },
    });
    expect(ctx.workspace.sandboxAllowedPaths('granted', 'sid-attached')).toEqual([wsRoot, path.join(root, 'extra')]);
    // 未挂工作区的会话 / 不带会话键 → 与既有行为一致
    expect(ctx.workspace.sandboxAllowedPaths('plain', 'sid-bare')).toEqual([]);
    expect(ctx.workspace.sandboxAllowedPaths('plain')).toEqual([]);
  });
});

describe('ac-workspace 目录树基准（M33 前端反馈 #1：树随会话上下文定位）', () => {
  /** stub singles（conversationWorkspaceRoot 消费 get(sid) → workspaceId 结构面） */
  async function bootWithSingles(root: string, sessions: Map<string, { workspaceId?: string }>) {
    const h = await boot(root);
    const { Service } = await import('@agentchat/cordis');
    class SinglesStub extends Service {
      constructor(c: any) {
        super(c, 'singles');
      }
      get(sid: string): { workspaceId?: string } | null {
        return sessions.get(sid) ?? null;
      }
    }
    void new SinglesStub(h.ctx as any);
    return h;
  }

  it('无 context = 数据根（原行为）+ root.label 空；dotfile 不入树照旧（敏感遮蔽已停用）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const t = ctx.workspace.tree('');
    expect(t.root.label).toBe('');
    expect(t.children.some((c) => c.name === 'files' && c.type === 'dir')).toBe(true);
    expect(t.children.some((c) => c.name === '.initialized')).toBe(false); // dotfile 不入树（数据根基准）
    // 相对 path 下钻 + 越界照拒
    expect(ctx.workspace.tree('files').children.length).toBeGreaterThanOrEqual(0);
    expect(() => ctx.workspace.tree('../outside')).toThrow(/路径越界/);
  });

  it('agentId context：常规 Agent 树基准 = 专用空间 files/<id>（label = Agent/<id>）；预设/未知 = 数据根', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'neko', model: 'm' });
    ctx.agents.register({ id: '__standard__', model: 'm', preset: true });
    fs.mkdirSync(path.join(root, 'files', 'neko', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'files', 'neko', 'a.md'), 'hi');
    fs.writeFileSync(path.join(root, 'files', 'neko', 'docs', 'b.txt'), 'yo');
    fs.writeFileSync(path.join(root, 'outside.txt'), 'root-level');

    // 常规 Agent：树根 = files/neko——只见专用空间内容
    const t = ctx.workspace.tree('', { agentId: 'neko' });
    expect(t.root.label).toBe('Agent/neko');
    expect(t.children.some((c) => c.name === 'a.md')).toBe(true);
    expect(t.children.some((c) => c.name === 'outside.txt')).toBe(false);
    expect(t.children.some((c) => c.name === 'files')).toBe(false);
    // Agent 专用空间 dotfile 如实入树（基准 = files/<id> 非数据根——
    // dotfile 过滤只作用于数据根控制面）
    fs.writeFileSync(path.join(root, 'files', 'neko', '.eslintrc.json'), '{}');
    expect(ctx.workspace.tree('', { agentId: 'neko' }).children.some((c) => c.name === '.eslintrc.json')).toBe(true);
    // 下钻相对基准
    const sub = ctx.workspace.tree('docs', { agentId: 'neko' });
    expect(sub.children.some((c) => c.name === 'b.txt')).toBe(true);
    // 越界（基准外 ../）照拒
    expect(() => ctx.workspace.tree('../..', { agentId: 'neko' })).toThrow(/路径越界/);

    // 预设/未知 Agent：数据根兜底（label 空）
    expect(ctx.workspace.tree('', { agentId: '__standard__' }).root.label).toBe('');
    expect(ctx.workspace.tree('', { agentId: 'ghost' }).root.label).toBe('');
    expect(ctx.workspace.tree('', { agentId: 'ghost' }).children.some((c) => c.name === 'files')).toBe(true);
  });

  it('conversationId context：挂载工作区 = 树基准（label = 登记名，最优先于 Agent 基准）；未挂会话回落 Agent/数据根', async () => {
    const root = tmpRoot();
    const sessions = new Map<string, { workspaceId?: string }>();
    const { ctx } = await bootWithSingles(root, sessions);
    ctx.agents.register({ id: 'plain', model: 'm' });

    const wsRoot = path.join(root, 'project-x');
    fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(wsRoot, '.dsh'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'src', 'app.ts'), 'export {}');
    fs.writeFileSync(path.join(wsRoot, 'readme.md'), '# x');
    fs.writeFileSync(path.join(wsRoot, '.dsh', 'skill.md'), 's');
    fs.writeFileSync(path.join(wsRoot, '.gitignore'), 'node_modules');
    const reg = ctx.workspace.registerWorkspace(wsRoot, '项目X');
    sessions.set('sid-1', { workspaceId: reg.id });

    // 挂载会话：树根 = 工作区目录（label = 登记名）；Agent 基准让位
    const t = ctx.workspace.tree('', { agentId: 'plain', conversationId: 'sid-1' });
    expect(t.root.label).toBe('项目X');
    expect(t.children.some((c) => c.name === 'readme.md')).toBe(true);
    expect(t.children.some((c) => c.name === 'files')).toBe(false); // 数据根内容不可见
    expect(t.children.some((c) => c.name === 'src' && c.type === 'dir')).toBe(true);
    // dotfile 如实入树（前端反馈 #3：外挂工作区是用户真实内容——
    // .dsh 项目目录 / .gitignore 项目文件，与数据根控制面噪音口径分流）
    expect(t.children.some((c) => c.name === '.dsh' && c.type === 'dir')).toBe(true);
    expect(t.children.some((c) => c.name === '.gitignore' && c.type === 'file')).toBe(true);
    const sub = ctx.workspace.tree('src', { conversationId: 'sid-1' });
    expect(sub.children.some((c) => c.name === 'app.ts')).toBe(true);
    const dsh = ctx.workspace.tree('.dsh', { conversationId: 'sid-1' });
    expect(dsh.children.some((c) => c.name === 'skill.md')).toBe(true);

    // 未挂会话（同 Agent）→ 回落 Agent 专用空间基准
    fs.mkdirSync(path.join(root, 'files', 'plain'), { recursive: true });
    fs.writeFileSync(path.join(root, 'files', 'plain', 'mine.txt'), 'm');
    const t2 = ctx.workspace.tree('', { agentId: 'plain', conversationId: 'sid-bare' });
    expect(t2.root.label).toBe('Agent/plain');
    expect(t2.children.some((c) => c.name === 'mine.txt')).toBe(true);

    // 显式 settings.workdir 也让位于会话工作区（同 sandboxWorkdir 优先序）
    ctx.agents.register({
      id: 'pinned', model: 'm',
      settings: { security: { workdir: path.join(root, 'pinned-dir') } },
    });
    const t3 = ctx.workspace.tree('', { agentId: 'pinned', conversationId: 'sid-1' });
    expect(t3.root.label).toBe('项目X');
  });
});

describe('ac-workspace 本地资源管理器目录解析（resolveOpenDir）', () => {
  /** stub singles（会话挂载工作区结构面——同树基准 describe） */
  async function bootWithSingles(root: string, sessions: Map<string, { workspaceId?: string }>) {
    const h = await boot(root);
    const { Service } = await import('@agentchat/cordis');
    class SinglesStub extends Service {
      constructor(c: any) {
        super(c, 'singles');
      }
      get(sid: string): { workspaceId?: string } | null {
        return sessions.get(sid) ?? null;
      }
    }
    void new SinglesStub(h.ctx as any);
    return h;
  }

  it('workspaceId 在场 = 登记工作区文件夹；未登记 id → error 点名', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const wsRoot = path.join(root, 'proj-a');
    fs.mkdirSync(wsRoot, { recursive: true });
    const reg = ctx.workspace.registerWorkspace(wsRoot, '项目A');
    expect(ctx.workspace.resolveOpenDir({ workspaceId: reg.id })).toEqual({ dir: wsRoot });
    expect('error' in ctx.workspace.resolveOpenDir({ workspaceId: 'ghost-ws' })).toBe(true);
    expect((ctx.workspace.resolveOpenDir({ workspaceId: 'ghost-ws' }) as { error: string }).error).toContain('ghost-ws');
  });

  it('缺席 workspaceId = 树基准推导：会话挂载工作区 > Agent 基准 > 数据根', async () => {
    const root = tmpRoot();
    const sessions = new Map<string, { workspaceId?: string }>();
    const { ctx } = await bootWithSingles(root, sessions);
    ctx.agents.register({ id: 'plain', model: 'm' });

    const wsRoot = path.join(root, 'project-x');
    fs.mkdirSync(wsRoot, { recursive: true });
    fs.mkdirSync(path.join(root, 'files', 'plain'), { recursive: true });
    const reg = ctx.workspace.registerWorkspace(wsRoot, '项目X');
    sessions.set('sid-1', { workspaceId: reg.id });

    // 会话挂载工作区（最优先）
    expect(ctx.workspace.resolveOpenDir({ conversationId: 'sid-1' })).toEqual({ dir: wsRoot });
    // Agent 基准（无会话工作区时）
    expect(ctx.workspace.resolveOpenDir({ agentId: 'plain' })).toEqual({ dir: path.join(root, 'files', 'plain') });
    // 全缺 = 数据根
    expect(ctx.workspace.resolveOpenDir({})).toEqual({ dir: root });
  });

  it('守卫：登记路径被删/换成文件 → error 不抛异常', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const wsRoot = path.join(root, 'gone');
    fs.mkdirSync(wsRoot, { recursive: true });
    const reg = ctx.workspace.registerWorkspace(wsRoot, '已删');
    fs.rmSync(wsRoot, { recursive: true });
    expect((ctx.workspace.resolveOpenDir({ workspaceId: reg.id }) as { error: string }).error).toContain('不存在');
    // 路径被替换为文件
    const fake = path.join(root, 'now-a-file');
    fs.writeFileSync(fake, 'x');
    ctx.workspace.registerWorkspace(fake, '伪目录');
    const reg2 = ctx.workspace.listWorkspaces().find((w) => w.path === fake)!;
    expect((ctx.workspace.resolveOpenDir({ workspaceId: reg2.id }) as { error: string }).error).toContain('不是文件夹');
  });
});
