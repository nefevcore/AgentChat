// ============================================================
// ac-str-replace-editor：精准编辑器行生命周期冒烟（view/str_replace/create→dispose 回收）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as agentStoreRow from 'ac-agent-store';
import * as sessionRow from 'ac-session';
import * as workspaceRow from 'ac-workspace';
import * as editorRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

/** boot：工具注册中心 + 编辑器行（沙箱基准 = 临时目录，行选项名以实现为准：workdir） */
async function boot(workdir: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const f1 = ctx.plugin(toolsRow as any);
  await f1;
  fibers.push(f1);
  const f2 = ctx.plugin(editorRow as any, { workdir });
  await f2;
  fibers.push(f2);
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

const FILE = 'file.txt';
// 不带尾换行：split('\n') 的行数即正文行数（尾换行会计入空末行——实现语义）
const BEFORE = '第一行 alpha\nSECOND unique line\n第三行 gamma';
const OLD_STR = 'SECOND unique line';
const NEW_STR = '替换后的第二行';

describe('ac-str-replace-editor', () => {
  it('注册面：行挂载后 str_replace_editor 进入注册表', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sre-'));
    const { ctx } = await boot(root);
    expect(ctx.tools.has('str_replace_editor')).toBe(true);
    expect(ctx.tools.get('str_replace_editor')?.requiredTags).toEqual(['fs_minimal']);
  });

  it('view：带行号输出（cat -n 风格，6 宽右对齐 + 两空格）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sre-'));
    writeFileSync(join(root, FILE), BEFORE, 'utf8');
    const { ctx } = await boot(root);

    const r = await ctx.tools.execute({ name: 'str_replace_editor', args: { command: 'view', path: FILE } });
    expect(r.ok).toBe(true);
    const out = r.output as { type: string; total_lines: number; content: string };
    expect(out.type).toBe('file');
    expect(out.total_lines).toBe(3);
    expect(out.content).toContain('     1  第一行 alpha');
    expect(out.content).toContain(`     2  ${OLD_STR}`);
    expect(out.content).toContain('     3  第三行 gamma');
  });

  it('str_replace：old_str 唯一时替换成功且盘上内容真的变了', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sre-'));
    writeFileSync(join(root, FILE), BEFORE, 'utf8');
    const { ctx } = await boot(root);

    const r = await ctx.tools.execute({
      name: 'str_replace_editor',
      args: { command: 'str_replace', path: FILE, old_str: OLD_STR, new_str: NEW_STR },
    });
    expect(r.ok).toBe(true);
    expect((r.output as { replacements: number }).replacements).toBe(1);
    // 盘上事实：读临时目录里的真实文件
    expect(readFileSync(join(root, FILE), 'utf8')).toBe(`第一行 alpha\n${NEW_STR}\n第三行 gamma`);
  });

  it('str_replace：new_str 与 old_str 相同 → 拒绝且文件保持原状', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sre-'));
    writeFileSync(join(root, FILE), BEFORE, 'utf8');
    const { ctx } = await boot(root);

    const r = await ctx.tools.execute({
      name: 'str_replace_editor',
      args: { command: 'str_replace', path: FILE, old_str: OLD_STR, new_str: OLD_STR },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('完全相同');
    expect(readFileSync(join(root, FILE), 'utf8')).toBe(BEFORE); // 未写盘
  });

  it('create：新文件写入成功；已存在文件拒绝（不可覆盖）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sre-'));
    writeFileSync(join(root, FILE), BEFORE, 'utf8');
    const { ctx } = await boot(root);

    const fresh = await ctx.tools.execute({
      name: 'str_replace_editor',
      args: { command: 'create', path: 'new.txt', file_text: '全新内容\n' },
    });
    expect(fresh.ok).toBe(true);
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('全新内容\n');

    const clash = await ctx.tools.execute({
      name: 'str_replace_editor',
      args: { command: 'create', path: FILE, file_text: '覆盖尝试\n' },
    });
    expect(clash.ok).toBe(false);
    expect(clash.error).toContain('已存在');
    expect(readFileSync(join(root, FILE), 'utf8')).toBe(BEFORE); // 原文件未被破坏
  });

  it('dispose：编辑器 fiber 卸载后工具回收', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sre-'));
    writeFileSync(join(root, FILE), BEFORE, 'utf8');
    const { ctx, fibers } = await boot(root);
    await fibers[1]!.dispose();
    expect(ctx.tools.has('str_replace_editor')).toBe(false);
    const r = await ctx.tools.execute({ name: 'str_replace_editor', args: { command: 'view', path: FILE } });
    expect(r).toEqual({ ok: false, error: 'unknown tool: str_replace_editor' });
  });
});

describe('ac-str-replace-editor 双黑名单（cr-363：deny 装配并源 + view 读面口径对齐）', () => {
  /** boot：agents + agentStore + session + workspace（黑名单锚定数据根）+ 编辑器行 */
  async function bootWs(root: string) {
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const rows: Array<[unknown, unknown]> = [
      [toolsRow, undefined],
      [agentsRow, undefined],
      [agentStoreRow, { root }],
      [sessionRow, { root }],
      [workspaceRow, { root }],
      [editorRow, { workdir: root }],
    ];
    for (const pair of rows) {
      const row = pair[0];
      const config = pair[1];
      const fiber = config === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, config);
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });
    return { ctx, fibers };
  }

  it('view：.env 拒绝（沙箱内置 deny 先拦）；持久化域树（agents/，访问黑名单）拒绝', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sre-deny-'));
    writeFileSync(join(root, '.env'), 'SECRET=1', 'utf8');
    mkdirSync(join(root, 'agents', 'a'), { recursive: true });
    writeFileSync(join(root, 'agents', 'a', 'config.json'), '{}', 'utf8');
    writeFileSync(join(root, 'note.txt'), 'normal', 'utf8');
    const { ctx } = await bootWs(root);

    // 非 full 档：.env 命中沙箱内置 BUILTIN_DENY_PATTERNS，resolve 即拦（readDeny 层之前）
    const env = await ctx.tools.execute({ name: 'str_replace_editor', args: { command: 'view', path: '.env' } });
    expect(env.ok).toBe(false);
    expect(env.error).toContain('敏感文件黑名单');

    const tree = await ctx.tools.execute({ name: 'str_replace_editor', args: { command: 'view', path: 'agents' } });
    expect(tree.ok).toBe(false);
    expect(tree.error).toContain('访问黑名单');

    const plain = await ctx.tools.execute({ name: 'str_replace_editor', args: { command: 'view', path: 'note.txt' } });
    expect(plain.ok).toBe(true);
  });

  it('view readDeny 层（read 工具同款口径，cr-363 补齐）：**/*.key 在 DEFAULT_READ_DENY 而不在沙箱内置表——readDeny 是唯一防线', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-sre-deny-'));
    writeFileSync(join(root, 'secret.key'), 'KEY=1', 'utf8');
    mkdirSync(join(root, 'agents', 'a'), { recursive: true });
    writeFileSync(join(root, 'agents', 'a', 'config.json'), '{}', 'utf8');
    const { ctx } = await bootWs(root);

    // 非 full 档：沙箱 resolve 放行（*.key 非内置表）→ 新增 readDeny 检查命中
    const key = await ctx.tools.execute({ name: 'str_replace_editor', args: { command: 'view', path: 'secret.key' } });
    expect(key.ok).toBe(false);
    expect(key.error).toContain('读黑名单');

    // full 档（绝对路径直达）：readDeny 跳过 → 可见（fs-search full 档 .env 同款语义）
    ctx.agents.register({ id: 'boss', model: 'm', tags: ['full-access'] });
    const keyFull = await ctx.tools.execute({ name: 'str_replace_editor', args: { command: 'view', path: join(root, 'secret.key') }, agentId: 'boss' });
    expect(keyFull.ok).toBe(true);

    // accessDeny 全档：agents/ 树 full 档绝对路径仍拦
    const tree = await ctx.tools.execute({ name: 'str_replace_editor', args: { command: 'view', path: join(root, 'agents') }, agentId: 'boss' });
    expect(tree.ok).toBe(false);
    expect(tree.error).toContain('访问黑名单');
  });
});
