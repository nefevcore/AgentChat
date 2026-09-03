// ============================================================
// ac-fs-tools / ac-fs-search / ac-str-replace-editor 工具行：
// 注册回收 + 沙箱 + read/write/edit + glob/grep + 四命令编辑器
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as fsToolsRow from 'ac-fs-tools';
import * as fsSearchRow from 'ac-fs-search';
import * as sreRow from 'ac-str-replace-editor';
type ExecRes = { ok: boolean; output: any; error?: string; interrupt?: any };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-fs-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [fsToolsRow, { workdir: root }],
    [fsSearchRow, { workdir: root }],
    [sreRow, { workdir: root }],
  ];
  for (const [plugin, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
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

describe('ac-fs-tools', () => {
  it('read：行号内容 + 目录列表；分页与 token 截断标注', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'a.txt'), 'l1\nl2\nl3\n');
    const { ctx } = await boot(root);
    const r = await exec(ctx, { name: 'read', args: { file_path: 'a.txt' } });
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({ total_lines: 4 });
    expect(r.output.content).toContain('1:l1');
    expect(r.output.content).toContain('4:'); // 尾空行也计数
    const p2 = await exec(ctx, { name: 'read', args: { file_path: 'a.txt', offset: 2, limit: 1 } });
    expect(p2.output.content).toBe('2:l2');
    const dir = await exec(ctx, { name: 'read', args: { file_path: '.' } });
    expect(dir.output).toMatchObject({ type: 'directory', count: 1 });
    // token 截断（大文件）
    fs.writeFileSync(path.join(root, 'big.txt'), `${'word '.repeat(60000)}\n`);
    const big = await exec(ctx, { name: 'read', args: { file_path: 'big.txt', limit: 5000 } });
    expect(big.output.note).toContain('token 预算');
  });

  it('write：建目录写文件；沙箱越界拒绝；.env 黑名单拒绝', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, {
      name: 'write',
      args: { file_path: 'nested/dir/f.txt', content: 'hello' },
    });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'nested/dir/f.txt'), 'utf-8')).toBe('hello');
    const out = await exec(ctx, {
      name: 'write',
      args: { file_path: '../escape.txt', content: 'x' },
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('沙箱');
    const denied = await exec(ctx, { name: 'write', args: { file_path: '.env', content: 'x' } });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('敏感文件黑名单');
  });

  it('edit：old/new 替换 + diff + 模糊匹配；旧形态迁移引导', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'e.txt'), 'alpha\n“quoted”\ngamma\n');
    const { ctx } = await boot(root);
    const r = await exec(ctx, {
      name: 'edit',
      args: { file_path: 'e.txt', old_string: '"quoted"', new_string: 'REPLACED' }, // ASCII 引号 → 模糊命中
    });
    expect(r.ok).toBe(true);
    expect(r.output.fuzzy_matches).toBe(1);
    expect(fs.readFileSync(path.join(root, 'e.txt'), 'utf-8')).toBe('alpha\nREPLACED\ngamma\n');
    const legacy = await exec(ctx, { name: 'edit', args: { file_path: 'e.txt', input: '[x#1]' } });
    expect(legacy.ok).toBe(false);
    expect(legacy.error).toContain('已移除');
  });

  it('注册随行卸载回收', async () => {
    const root = tmpRoot();
    const { ctx, fibers } = await boot(root);
    expect(ctx.tools.has('read')).toBe(true);
    await fibers[1].dispose();
    expect(ctx.tools.has('read')).toBe(false);
    expect(ctx.tools.has('glob')).toBe(true); // 其他行不受影响
  });
});

describe('ac-fs-search', () => {
  it('glob：无 / 模式匹配任意深度文件名；mtime 排序', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.ts'), 'x');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'x');
    fs.writeFileSync(path.join(root, 'src', 'c.js'), 'x');
    const { ctx } = await boot(root);
    const r = await exec(ctx, { name: 'glob', args: { pattern: '*.ts' } });
    expect(r.output.paths.sort()).toEqual(['a.ts', 'src/b.ts']);
    const r2 = await exec(ctx, { name: 'glob', args: { pattern: 'src/**' } });
    expect(r2.output.paths.sort()).toEqual(['src/b.ts', 'src/c.js']);
  });

  it('grep：正则 + include 过滤 + 二进制跳过', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'a.ts'), 'hello world\nsecond line\n');
    fs.writeFileSync(path.join(root, 'b.js'), 'hello again\n');
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x68, 0x69]));
    const { ctx } = await boot(root);
    const r = await exec(ctx, { name: 'grep', args: { pattern: 'hello' } });
    expect(r.output.total).toBe(2);
    expect(r.output.groups.map((g: { path: string }) => g.path).sort()).toEqual(['a.ts', 'b.js']);
    const r2 = await exec(ctx, { name: 'grep', args: { pattern: 'hello', include: '*.ts' } });
    expect(r2.output.groups).toHaveLength(1);
    // 单文件直搜
    const r3 = await exec(ctx, { name: 'grep', args: { pattern: 'second', path: 'a.ts' } });
    expect(r3.output.groups[0].matches[0]).toMatchObject({ line: 2 });
    // include 校验
    const bad = await exec(ctx, { name: 'grep', args: { pattern: 'x', include: '*.ts,*.js' } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('逗号列表');
  });

  it('敏感黑名单文件不进检索结果', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'ok.txt'), 'secret marker\n');
    fs.writeFileSync(path.join(root, '.env'), 'secret marker\n');
    const { ctx } = await boot(root);
    const r = await exec(ctx, { name: 'grep', args: { pattern: 'secret marker' } });
    expect(r.output.total).toBe(1);
    expect(r.output.groups[0].path).toBe('ok.txt');
  });
});

describe('ac-str-replace-editor', () => {
  it('view：行号视图 + view_range；目录两层列表', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'v.txt'), 'one\ntwo\nthree\n');
    const { ctx } = await boot(root);
    const r = await exec(ctx, { name: 'str_replace_editor', args: { command: 'view', path: 'v.txt' } });
    expect(r.output.content).toContain('     1  one');
    const r2 = await exec(ctx, {
      name: 'str_replace_editor',
      args: { command: 'view', path: 'v.txt', view_range: [2, -1] },
    });
    expect(r2.output.content).toContain('     2  two');
    expect(r2.output.content).not.toContain('one\n');
    const d = await exec(ctx, { name: 'str_replace_editor', args: { command: 'view', path: '.' } });
    expect(d.output.content).toContain('d\t');
  });

  it('create / str_replace（唯一性）/ insert（行边界）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const c = await exec(ctx, {
      name: 'str_replace_editor',
      args: { command: 'create', path: 'n.txt', file_text: 'aa\nbb\ncc\n' },
    });
    expect(c.ok).toBe(true);
    const dup = await exec(ctx, {
      name: 'str_replace_editor',
      args: { command: 'create', path: 'n.txt', file_text: 'x' },
    });
    expect(dup.ok).toBe(false);
    const s = await exec(ctx, {
      name: 'str_replace_editor',
      args: { command: 'str_replace', path: 'n.txt', old_str: 'bb', new_str: 'BB' },
    });
    expect(s.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'n.txt'), 'utf-8')).toBe('aa\nBB\ncc\n');
    const multi = await exec(ctx, {
      name: 'str_replace_editor',
      args: { command: 'str_replace', path: 'n.txt', old_str: 'a', new_str: 'z' },
    });
    expect(multi.ok).toBe(false);
    expect(multi.error).toContain('2 次');
    const i = await exec(ctx, {
      name: 'str_replace_editor',
      args: { command: 'insert', path: 'n.txt', insert_line: 0, new_str: 'HEAD' },
    });
    expect(i.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'n.txt'), 'utf-8')).toBe('HEAD\naa\nBB\ncc\n');
  });
});

// ============================================================
// settings.security.allowedPaths 端到端（经 workspace 沙箱面进基线 resolver）
// ============================================================

/** 最小 workspace 沙箱面（SandboxWorkdirSource 全形态）：按表出基准与授予根 */
class FakeWorkspaceService extends Service {
  private table: Record<string, { base?: string; grants?: string[] }>;

  constructor(ctx: Context, options: { agents?: Record<string, { base?: string; grants?: string[] }> } = {}) {
    super(ctx, 'workspace');
    this.table = options.agents ?? {};
  }

  sandboxWorkdir(id?: string): string | undefined {
    return id !== undefined ? this.table[id]?.base : undefined;
  }

  sandboxAllowedPaths(id?: string): string[] {
    return (id !== undefined ? this.table[id]?.grants : undefined) ?? [];
  }
}

describe('ac-fs-tools × workspace 沙箱面（allowedPaths 端到端）', () => {
  async function bootWs(root: string, agents: Record<string, { base?: string; grants?: string[] }>) {
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const rows: Array<[unknown, unknown]> = [
      [toolsRow, undefined],
      [FakeWorkspaceService, { agents }],
      [fsToolsRow, { workdir: root }],
    ];
    for (const [plugin, config] of rows) {
      const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });
    return { ctx, fibers };
  }

  it('授予根内绝对路径放行；授予外仍越界；相对路径仍锚专用空间；黑名单优先于授予', async () => {
    const root = tmpRoot();
    const granted = path.join(root, 'granted');
    const base = path.join(root, 'files', 'neko');
    fs.mkdirSync(granted, { recursive: true });
    fs.writeFileSync(path.join(granted, 'g.txt'), 'granted-content');
    const { ctx } = await bootWs(root, { neko: { base, grants: [granted] } });

    // 授予根内：绝对路径 write/read 放行（修复前此处被基线 resolver 拦）
    const w = await exec(ctx, {
      name: 'write',
      agentId: 'neko',
      args: { file_path: path.join(granted, 'w.txt'), content: 'x' },
    });
    expect(w.ok).toBe(true);
    expect(fs.readFileSync(path.join(granted, 'w.txt'), 'utf-8')).toBe('x');
    const r = await exec(ctx, { name: 'read', agentId: 'neko', args: { file_path: path.join(granted, 'g.txt') } });
    expect(r.ok).toBe(true);
    expect(r.output.content).toContain('granted-content');

    // 授予外：仍被基线沙箱拦
    const out = await exec(ctx, {
      name: 'read',
      agentId: 'neko',
      args: { file_path: path.join(root, 'outside', 'x.txt') },
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('沙箱');

    // 相对路径仍锚 Agent 专用空间（基准不被授予影响）
    const rel = await exec(ctx, { name: 'write', agentId: 'neko', args: { file_path: 'rel.txt', content: 'y' } });
    expect(rel.ok).toBe(true);
    expect(fs.readFileSync(path.join(base, 'rel.txt'), 'utf-8')).toBe('y');

    // 内置敏感黑名单优先于授予：授予根内的 .env 照拦
    const denied = await exec(ctx, {
      name: 'read',
      agentId: 'neko',
      args: { file_path: path.join(granted, '.env') },
    });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('敏感文件黑名单');
  });
});
