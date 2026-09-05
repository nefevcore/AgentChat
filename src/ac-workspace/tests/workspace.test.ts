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

  it('resolveFile/readFile 兼容 saveUpload 返回的 files/ 前缀路径（此前双重前缀必 404）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const up = ctx.workspace.saveUpload('admin', 'dot.png', PNG);
    // files/ 前缀（上传返回形——raw 直链/物化/预览的通用引用）
    expect(ctx.workspace.resolveFile(up.path)).toBe(path.resolve(root, 'files', 'admin', '_tmp', up.storedName));
    // 裸路径（相对 <root>/files 的树形态）不受影响
    expect(ctx.workspace.resolveFile(up.path.slice('files/'.length))).toBe(path.resolve(root, 'files', 'admin', '_tmp', up.storedName));
    // readFile 同款双形态（预览端点）
    expect(ctx.workspace.readFile(up.path).base64).toBe(true);
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

  it('sandboxWorkdir：显式 settings.security.workdir 最优先 > 专用空间 > 预设=根 > 未知=undefined', async () => {
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

  it('会话挂载工作区 = 会话级授予根：conversationWorkspaceRoot 唯一事实源 + sandboxAllowedPaths 并入/去重', async () => {
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

    // sandboxAllowedPaths：会话根并入（settings 授予 ∪ 会话根，去重）；
    // 无执行身份也会话根照常授予（会话资产语义）
    ctx.agents.register({ id: 'plain', model: 'm' });
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
