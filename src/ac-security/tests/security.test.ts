// ============================================================
// ac-security：能力门禁（M23 E1/B4 owner 合成） / per-Agent 沙箱 /
// 控制面黑名单（G3 fail-closed）/ bash 扫描 / 输出脱敏
// ============================================================
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from 'ac-agents';
import * as agentStoreRow from 'ac-agent-store';
import * as credentialsRow from 'ac-credentials';
import * as sessionRow from 'ac-session';
import * as sreRow from 'ac-str-replace-editor';
import * as toolsRow from 'ac-tools';
import * as workspaceRow from 'ac-workspace';
import * as securityRow from '../src/index.ts';
type ExecRes = { ok: boolean; output: any; error?: string; interrupt?: any };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sec-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string, options: Record<string, unknown> = {}, withWorkspace = true) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [agentsRow, undefined],
    [agentStoreRow, { root }],
    [sessionRow, { root }],
    [credentialsRow, { root }],
    ...(withWorkspace ? ([[workspaceRow, { root }]] as Array<[unknown, unknown]>) : []),
    [securityRow, { workdir: root, ...options }],
  ];
  for (const [plugin, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).tools && (ctx as any).agents && (ctx as any).credentials) break;
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
  vi.restoreAllMocks();
});

describe('ac-security 能力门禁', () => {
  it('requiredTags AND 语义：缺标签 veto，错误可读；capabilities 放行', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.tools.register({
      name: 'admin-thing',
      requiredTags: ['admin'],
      execute: () => ({ ok: true }),
    });
    ctx.tools.register({
      name: 'dev-admin-thing',
      requiredTags: ['dev', 'admin'],
      execute: () => ({ ok: true }),
    });
    ctx.agents.register({ id: 'plain', model: 'm' });
    ctx.agents.register({ id: 'dev', model: 'm', settings: { security: { capabilities: ['base', 'dev'] } } });
    ctx.agents.register({ id: 'boss', model: 'm', settings: { security: { capabilities: ['base', 'dev', 'admin'] } } });

    const deny = await exec(ctx, { name: 'admin-thing', agentId: 'plain' });
    expect(deny.ok).toBe(false);
    expect(deny.error).toContain('admin');

    const half = await exec(ctx, { name: 'dev-admin-thing', agentId: 'dev' });
    expect(half.ok).toBe(false);
    expect(half.error).toContain('需要能力标签');

    const pass = await exec(ctx, { name: 'dev-admin-thing', agentId: 'boss' });
    expect(pass.ok).toBe(true);

    // 无身份（宿主直调）：门禁不适用（缺省能力集 base，requiredTags admin 仍拦截）
    const anon = await exec(ctx, { name: 'admin-thing' });
    expect(anon.ok).toBe(false);
    const anonBase = await exec(ctx, { name: 'admin-thing', agentId: undefined });
    expect(anonBase.ok).toBe(false);
  });

  it('shell 标签拆分：dev 不再覆盖命令执行门禁；tags 单源授权放行', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // dev→shell 拆分后的 bash 形态：命令执行专用标签
    ctx.tools.register({
      name: 'bash',
      requiredTags: ['shell'],
      execute: () => ({ ok: true, output: 'ran' }),
    });
    ctx.agents.register({ id: 'devonly', model: 'm', tags: ['dev'] });
    ctx.agents.register({ id: 'shelluser', model: 'm', tags: ['shell'] });

    const dev = await exec(ctx, { name: 'bash', args: { command: 'echo hi' }, agentId: 'devonly' });
    expect(dev.ok).toBe(false);
    expect(dev.error).toContain('shell');

    const pass = await exec(ctx, { name: 'bash', args: { command: 'echo hi' }, agentId: 'shelluser' });
    expect(pass.ok).toBe(true);
  });

  it('str_replace_editor：fs_minimal 门禁（移出默认工具面；显式标签放行——__dsh_minimal__ 形态）', async () => {
    const root = tmpRoot();
    const { ctx, fibers } = await boot(root);
    // 真实 str-replace-editor 行（注册面 requiredTags ['fs_minimal']）
    const sreFiber = ctx.plugin(sreRow as any, { workdir: root });
    await sreFiber;
    fibers.push(sreFiber);
    expect(ctx.tools.get('str_replace_editor')?.requiredTags).toEqual(['fs_minimal']);

    ctx.agents.register({ id: 'plain', model: 'm' });
    ctx.agents.register({ id: 'minimal', model: 'm', tags: ['fs_minimal'] });
    // minimal 的沙箱 = files/minimal（workspace 基准）——目标文件落在其中
    const workdir = path.join(root, 'files', 'minimal');
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(workdir, 't.txt'), 'hello', 'utf-8');

    // 无标签：能力门禁先于沙箱 veto（错误指明 fs_minimal）
    const deny = await exec(ctx, {
      name: 'str_replace_editor',
      args: { command: 'view', path: 't.txt' },
      agentId: 'plain',
    });
    expect(deny.ok).toBe(false);
    expect(deny.error).toContain('fs_minimal');

    // 显式 fs_minimal：放行（view 正常出结果）
    const pass = await exec(ctx, {
      name: 'str_replace_editor',
      args: { command: 'view', path: 't.txt' },
      agentId: 'minimal',
    });
    expect(pass.ok).toBe(true);
    expect(String(pass.output?.content ?? '')).toContain('hello');
  });

  it('M23 E1：capabilities = 显式 ∪ {base, agent:<id>}；显式空数组也含 base', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // owner 私有工具：requiredTags agent:owner
    ctx.tools.register({
      name: 'owner-tool',
      requiredTags: ['agent:owner1'],
      execute: () => ({ ok: true, output: 'private' }),
    });
    ctx.agents.register({ id: 'owner1', model: 'm' }); // 未声明 capabilities
    ctx.agents.register({ id: 'stranger', model: 'm', settings: { security: { capabilities: ['base'] } } });
    // 显式排除 base（空数组）——E1 显式语义放宽：base 恒在
    ctx.agents.register({ id: 'minimal', model: 'm', settings: { security: { capabilities: [] } } });

    // owner 可执行（合成 agent:owner1）
    const self = await exec(ctx, { name: 'owner-tool', agentId: 'owner1' });
    expect(self.ok).toBe(true);
    // 他人默认被拦
    const other = await exec(ctx, { name: 'owner-tool', agentId: 'stranger' });
    expect(other.ok).toBe(false);
    expect(other.error).toContain('agent:owner1');
    // 显式共享（他人 capabilities 加 agent:owner1）→ 放行（三态之第三态）
    ctx.agents.register({ id: 'friend', model: 'm', settings: { security: { capabilities: ['base', 'agent:owner1'] } } });
    const shared = await exec(ctx, { name: 'owner-tool', agentId: 'friend' });
    expect(shared.ok).toBe(true);
    // capabilities: [] 的 Agent 仍具备 base（显式排除无效——收窄走 tools include/exclude）
    ctx.tools.register({ name: 'base-thing', execute: () => ({ ok: true }) });
    const minimal = await exec(ctx, { name: 'base-thing', agentId: 'minimal' });
    expect(minimal.ok).toBe(true);
  });

  it('M23 L2：无身份调用不合成 owner 段（不产生 agent:undefined）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.tools.register({ name: 'probe', execute: () => ({ ok: true }) });
    const r = await exec(ctx, { name: 'probe' });
    expect(r.ok).toBe(true);
    // requiredTags agent:undefined 形态的工具对无身份调用恒拦（合成不存在）
    ctx.tools.register({ name: 'undef-trap', requiredTags: ['agent:undefined'], execute: () => ({ ok: true }) });
    const trap = await exec(ctx, { name: 'undef-trap' });
    expect(trap.ok).toBe(false);
    expect(trap.error).not.toContain('agent:undefined，'); // 能力集不含合成段
  });

  it('M24 X4：tags 单源（只写 tags 即放行）；覆盖层有值降级一次性 info 提示（对账 warn 退役）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.tools.register({ name: 'shared-tool', requiredTags: ['agent:owner1'], execute: () => ({ ok: true }) });
    // 只写 tags（M24 X4 单源）——运行时门禁直接生效
    ctx.agents.register({ id: 'buyer', model: 'm', tags: ['agent:owner1'] });
    const allowed = await exec(ctx, { name: 'shared-tool', agentId: 'buyer' });
    expect(allowed.ok).toBe(true);

    // 存量覆盖层继续生效（追加语义）+ 有值时降级一次性提示（info 非 warn）
    const logCalls: string[] = [];
    const logger = (ctx as unknown as { logger: { warn(...args: unknown[]): void; info(...args: unknown[]): void } }).logger;
    const origInfo = logger.info.bind(logger);
    logger.info = (...args: unknown[]) => {
      logCalls.push(args.map(String).join(' '));
      origInfo(...args);
    };
    ctx.agents.register({ id: 'split', model: 'm', tags: ['dev'], settings: { security: { capabilities: ['admin'] } } });
    const viaOverlay = await exec(ctx, { name: 'shared-tool', agentId: 'split' });
    expect(viaOverlay.ok).toBe(false); // 覆盖层只有 admin——agent:owner1 缺失照拦
    await exec(ctx, { name: 'shared-tool', agentId: 'split' }); // 第二次不再提示
    const notices = logCalls.filter((w) => w.includes('覆盖层生效中') && w.includes('split'));
    expect(notices).toHaveLength(1);
    // 对账 warn 已退役（互有独占项不再告警）
    const warnCalls: string[] = [];
    const origWarn = logger.warn.bind(logger);
    logger.warn = (...args: unknown[]) => {
      warnCalls.push(args.map(String).join(' '));
      origWarn(...args);
    };
    await exec(ctx, { name: 'shared-tool', agentId: 'split' });
    expect(warnCalls.filter((w) => w.includes('双轨不一致'))).toHaveLength(0);
  });

  it('M23 L3 锁定（后端侧）：存量 capabilities 含裸 agent 值不与 agent:<id> 前缀撞名', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.tools.register({ name: 'legacy-tool', requiredTags: ['agent'], execute: () => ({ ok: true }) });
    // 存量：capabilities: ['agent']（裸值）→ 放行 requiredTags:['agent']
    ctx.agents.register({ id: 'legacy', model: 'm', settings: { security: { capabilities: ['agent'] } } });
    const pass = await exec(ctx, { name: 'legacy-tool', agentId: 'legacy' });
    expect(pass.ok).toBe(true);
    // 裸 'agent' 值不合成 agent:<id>（他人 owner 工具仍拦——前缀不撞名）
    ctx.tools.register({ name: 'owner-tool', requiredTags: ['agent:other'], execute: () => ({ ok: true }) });
    const no = await exec(ctx, { name: 'owner-tool', agentId: 'legacy' });
    expect(no.ok).toBe(false);
  });

  it('settings[security].enabled=false 软停用：门禁与脱敏都不生效', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, { extraSecrets: ['topsecretvalue'] });
    ctx.tools.register({ name: 'admin-thing', requiredTags: ['admin'], execute: () => ({ ok: true, output: 'sk-abcdefghij0123456789abcd' }) });
    ctx.agents.register({ id: 'off', model: 'm', settings: { security: { enabled: false } } });
    const r = await exec(ctx, { name: 'admin-thing', agentId: 'off' });
    expect(r.ok).toBe(true); // 门禁被软停用
    expect(r.output).toBe('sk-abcdefghij0123456789abcd'); // 脱敏也被软停用
  });
});

describe('ac-security per-Agent 沙箱', () => {
  it('路径越界 veto（per-Agent workdir 收窄）；行级缺省照常', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    const { ctx } = await boot(root);
    ctx.agents.register({
      id: 'confined',
      model: 'm',
      settings: { security: { workdir: path.join(root, 'sub') } },
    });
    // 普通工具（无路径语义）不受影响
    ctx.tools.register({
      name: 'file-op',
      execute: (args) => ({ ok: true, output: args }),
    });
    // 路径类工具按工具名识别（注册同名 read 模拟）
    ctx.tools.register({ name: 'read', execute: () => ({ ok: true }) });

    const outside = await exec(ctx, {
      name: 'read',
      args: { file_path: '../escape.txt' },
      agentId: 'confined',
    });
    expect(outside.ok).toBe(false);
    expect(outside.error).toContain('per-Agent 沙箱');

    const inside = await exec(ctx, {
      name: 'read',
      args: { file_path: 'ok.txt' },
      agentId: 'confined',
    });
    expect(inside.ok).toBe(true);

    // 无 settings 的 Agent：行级缺省 workdir=root → ../escape 越界
    ctx.agents.register({ id: 'normal', model: 'm' });
    const outsideDefault = await exec(ctx, {
      name: 'read',
      args: { file_path: '../escape.txt' },
      agentId: 'normal',
    });
    expect(outsideDefault.ok).toBe(false);
  });

  it('denyPaths per-Agent 追加（内置不可覆盖）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.tools.register({ name: 'write', execute: () => ({ ok: true }) });
    ctx.agents.register({
      id: 'picky',
      model: 'm',
      // 显式 workdir 优先于 Agent 专用空间（sandboxWorkdir 优先级）——
      // 让相对路径 vault/key.txt 落在 root 下，deny 命中才可预期
      settings: { security: { workdir: root, denyPaths: [path.join(root, 'vault')] } },
    });
    const denied = await exec(ctx, {
      name: 'write',
      args: { file_path: 'vault/key.txt', content: 'x' },
      agentId: 'picky',
    });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('黑名单');
  });

  it('写侧对齐读侧：显式 workdir 的 Agent 经绝对路径可达专用空间 files/<id>（复检沙箱同源并根）', async () => {
    const root = tmpRoot();
    const mounted = path.join(root, 'sub');
    fs.mkdirSync(mounted, { recursive: true });
    const { ctx } = await boot(root);
    ctx.tools.register({ name: 'write', execute: () => ({ ok: true }) });
    ctx.agents.register({
      id: 'scoped',
      model: 'm',
      settings: { security: { workdir: mounted } },
    });
    // 专用空间 files/scoped 自动并入允许根：绝对路径写记忆文件放行
    // （修复前：复检 resolver 只认 workdir+allowedPaths → 路径越界，
    //  Agent 的记忆/概要维护无路可走）
    const memoryFile = path.join(root, 'files', 'scoped', 'memory', 'scoped~user.md');
    const w = await exec(ctx, {
      name: 'write',
      args: { file_path: memoryFile, content: '记忆' },
      agentId: 'scoped',
    });
    expect(w.ok).toBe(true);
    // 相对路径仍锚显式 workdir；专用空间外越界照拦
    const rel = await exec(ctx, {
      name: 'write',
      args: { file_path: 'note.txt', content: 'x' },
      agentId: 'scoped',
    });
    expect(rel.ok).toBe(true);
    const outside = await exec(ctx, {
      name: 'write',
      args: { file_path: path.join(root, 'elsewhere', 'x.txt'), content: 'x' },
      agentId: 'scoped',
    });
    expect(outside.ok).toBe(false);
    // 他人专用空间不在允许根（files/<id> 只对本 Agent 并根）
    const other = await exec(ctx, {
      name: 'write',
      args: { file_path: path.join(root, 'files', 'other', 'memory', 'x.md'), content: 'x' },
      agentId: 'scoped',
    });
    expect(other.ok).toBe(false);
  });
});

describe('ac-security 控制面黑名单（M23 G3/E4/F1 + A3 凭据链）', () => {
  it('真实数据根路径拦截：registry/audit/patch/health/safe-mode + credentials/config（A3）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.tools.register({ name: 'write', execute: () => ({ ok: true }) });
    ctx.tools.register({ name: 'read', execute: () => ({ ok: true }) });
    ctx.agents.register({ id: 'preset', model: 'm', preset: true }); // preset 沙箱根 = 数据根
    // preset Agent 的沙箱根 = 整个数据根 → 控制面文件是"允许根内"的敏感文件，
    // 只有黑名单能拦（E4 场景）
    for (const rel of [
      path.join('plugins', 'registry.json'),
      path.join('plugins', 'audit.jsonl'),
      path.join('plugins', '.load-health.json'),
      'cordis.patch.yml',
      '.safe-mode',
      // A3（2026-08-31）：凭据库与宿主配置——此前预设 Agent 可用 read 直读
      'credentials.json',
      'config.json',
    ]) {
      const w = await exec(ctx, { name: 'write', args: { file_path: path.join(root, rel), content: 'x' }, agentId: 'preset' });
      expect(w.ok).toBe(false);
      expect(w.error).toContain('黑名单');
      const r = await exec(ctx, { name: 'read', args: { file_path: path.join(root, rel) }, agentId: 'preset' });
      expect(r.ok).toBe(false);
    }
    // 普通文件不受影响
    const ok = await exec(ctx, { name: 'write', args: { file_path: path.join(root, 'notes.md'), content: 'x' }, agentId: 'preset' });
    expect(ok.ok).toBe(true);
  });

  it('workspace 不可用 → fail-closed：路径类工具拒绝 + 显式告警（G3 ②）', async () => {
    const root = tmpRoot();
    // 不挂 workspace 行 → 控制面黑名单无法锚定数据根
    const { ctx } = await boot(root, {}, false);
    const warnCalls: string[] = [];
    const logger = (ctx as unknown as { logger: { warn(...args: unknown[]): void } }).logger;
    const origWarn = logger.warn.bind(logger);
    logger.warn = (...args: unknown[]) => {
      warnCalls.push(args.map(String).join(' '));
      origWarn(...args);
    };
    ctx.tools.register({ name: 'read', execute: () => ({ ok: true }) });
    ctx.tools.register({ name: 'bash', execute: () => ({ ok: true, output: 'ran' }) });
    ctx.agents.register({ id: 'a', model: 'm' });

    const blocked = await exec(ctx, { name: 'read', args: { file_path: 'ok.txt' }, agentId: 'a' });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/workspace.*不可用|fail-closed/);
    // 显式告警只发一次
    await exec(ctx, { name: 'read', args: { file_path: 'other.txt' }, agentId: 'a' });
    expect(warnCalls.filter((w) => w.includes('workspace 服务不可用'))).toHaveLength(1);
    // 非路径工具不受影响（bash 走原解析器——deny 面本就不进 bash 扫描）
    const bash = await exec(ctx, { name: 'bash', args: { command: 'echo hi' }, agentId: 'a' });
    expect(bash.ok).toBe(true);
  });
});

describe('ac-security bash 命令扫描', () => {
  it('越界命令 veto；heredoc 载荷不误判', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.tools.register({ name: 'bash', execute: () => ({ ok: true, output: 'ran' }) });
    const bad = await exec(ctx, {
      name: 'bash',
      args: { command: 'cat /etc/passwd' },
      agentId: 'a',
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/沙箱/);
    const okCmd = await exec(ctx, {
      name: 'bash',
      args: { command: "cat > s.txt <<'EOF'\nregex /const\\s+/ sample\nEOF\ntype s.txt" },
      agentId: 'a',
    });
    expect(okCmd.ok).toBe(true);
  });
});

describe('ac-security 输出脱敏（transform-result）', () => {
  it('凭据库明文 + sk- 模式；递归 output 对象；error 字段也脱敏', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 凭据库存入明文（AES-GCM 落盘）
    ctx.credentials.setGlobal('tavily', 'tvly-real-secret-key-123456');
    ctx.tools.register({
      name: 'leaky',
      execute: () => ({
        ok: true,
        output: {
          text: 'key=tvly-real-secret-key-123456 and sk-abcdefghij0123456789abcd',
          nested: { token: 'password = hunter2hunter2xy' },
        },
      }),
    });
    ctx.tools.register({
      name: 'leaky-error',
      execute: () => ({ ok: false, error: 'failed with tvly-real-secret-key-123456' }),
    });
    const r = await exec(ctx, { name: 'leaky', agentId: 'a' });
    expect(r.output.text).not.toContain('tvly-real-secret-key-123456');
    expect(r.output.text).toContain('***');
    expect(r.output.text).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/); // sk- 模式被掩码
    expect(r.output.nested.token).toBe('password =***');
    const e = await exec(ctx, { name: 'leaky-error', agentId: 'a' });
    expect(e.error).not.toContain('tvly-real-secret-key-123456');
  });

  it('行级 extraSecrets 注入脱敏', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root, { extraSecrets: ['rowlevelsecret99'] });
    ctx.tools.register({
      name: 'echoer',
      execute: (args) => ({ ok: true, output: String(args.t) }),
    });
    const r = await exec(ctx, { name: 'echoer', args: { t: 'has rowlevelsecret99 inside' }, agentId: 'a' });
    expect(r.output).toBe('has *** inside');
  });
});
