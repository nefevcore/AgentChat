// ============================================================
// @agentchat/fs-search —— glob/grep 工具语义测试
//
// 临时工作区（AGENTCHAT_WORKSPACE）隔离：验证 DSH 语义移植——
//   glob：无斜杠模式任意深度基名匹配 / 含斜杠锚定 / 只返回文件 /
//         跳过 VCS+node_modules / mtime 排序 / 上限提示
//   grep：分组行号 / include 过滤（花括号交替、拒绝列表与否定）/
//         无效正则报错 / 二进制跳过 / 单文件目标 / 长行截断
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentConfig } from '@agentchat/agent-config';
import { makeFsSearchTools } from '@agentchat/fs-search';

const config = { agent_id: 'fs-search-test', name: 'FS Search Test' } as AgentConfig;
let wsRoot = '';

function wf(rel: string, content: string, mtime?: Date): void {
  const abs = path.join(wsRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  if (mtime) fs.utimesSync(abs, mtime, mtime);
}

function parse(out: string | { content: string }): any {
  return JSON.parse(typeof out === 'string' ? out : out.content);
}

beforeAll(() => {
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-fs-search-'));
  process.env.AGENTCHAT_WORKSPACE = wsRoot;
});

afterAll(() => {
  delete process.env.AGENTCHAT_WORKSPACE;
  fs.rmSync(wsRoot, { recursive: true, force: true });
});

describe('glob 工具', () => {
  const [glob] = makeFsSearchTools(config);

  beforeAll(() => {
    const old = new Date(Date.now() - 100_000);
    const mid = new Date(Date.now() - 50_000);
    const now = new Date();
    wf('a/b.ts', 'b', old);
    wf('a/deep/c.ts', 'c', mid);
    wf('a/plain.txt', 't');
    wf('.hidden/h.ts', 'h', now);
    wf('node_modules/skip.js', 'skip');
    wf('.git/config', 'gitcfg');
    fs.mkdirSync(path.join(wsRoot, 'a', 'dirlike.ts'), { recursive: true }); // 名为 *.ts 的目录：不应命中
  });

  it('无斜杠模式匹配任意深度的基名（含隐藏目录，跳过 node_modules/.git，只返回文件）', async () => {
    const out = parse(await glob.execute!({ pattern: '*.ts' } as any));
    expect(out.status).toBe('ok');
    expect(out.data.paths).toEqual(['.hidden/h.ts', 'a/deep/c.ts', 'a/b.ts']); // mtime 新→旧
    expect(out.data.total).toBe(3);
  });

  it('含斜杠模式锚定相对路径（** 跨层级）', async () => {
    const out = parse(await glob.execute!({ pattern: 'a/**/*.ts' } as any));
    expect(out.data.paths).toEqual(['a/deep/c.ts', 'a/b.ts']);
  });

  it('含斜杠模式不匹配任意深度（仅按锚定路径）', async () => {
    const out = parse(await glob.execute!({ pattern: 'b.ts' } as any)); // 无斜杠 → 基名任意深度
    expect(out.data.paths).toEqual(['a/b.ts']);
    const anchored = parse(await glob.execute!({ pattern: 'a/b.ts' } as any));
    expect(anchored.data.paths).toEqual(['a/b.ts']);
  });

  it('path 收窄搜索根', async () => {
    const out = parse(await glob.execute!({ pattern: '*.ts', path: 'a/deep' } as any));
    expect(out.data.paths).toEqual(['a/deep/c.ts']);
  });

  it('花括号交替（单 * 不跨目录层级）', async () => {
    const out = parse(await glob.execute!({ pattern: 'a/*.{ts,txt}' } as any));
    expect(new Set(out.data.paths)).toEqual(new Set(['a/b.ts', 'a/plain.txt']));
  });

  it('无匹配给出提示', async () => {
    const out = parse(await glob.execute!({ pattern: '*.nomatch' } as any));
    expect(out.status).toBe('ok');
    expect(out.data.total).toBe(0);
    expect(out.data.note).toContain('No files found');
  });

  it('空 pattern 报错；越界路径报错', async () => {
    expect(parse(await glob.execute!({ pattern: '  ' } as any)).status).toBe('error');
    expect(parse(await glob.execute!({ pattern: '*.ts', path: '../outside' } as any)).status).toBe('error');
  });

  it('超过上限保留最新部分并提示（120 个文件 → 展示 100）', async () => {
    for (let i = 0; i < 120; i++) {
      wf(`bulk/f${String(i).padStart(3, '0')}.log`, String(i), new Date(Date.now() - 200_000 + i));
    }
    const out = parse(await glob.execute!({ pattern: 'bulk/*.log' } as any));
    expect(out.data.total).toBe(120);
    expect(out.data.shown).toBe(100);
    expect(out.data.note).toContain('120');
    expect(out.data.paths[0]).toBe('bulk/f119.log'); // 最新在前
  });
});

describe('grep 工具', () => {
  const tools = makeFsSearchTools(config);
  const grep = tools[1];

  beforeAll(() => {
    wf('g/one.ts', ['const alpha = 1;', 'const beta = alpha + 1;', 'plain line'].join('\n'));
    wf('g/two.tsx', ['alpha appears', 'again alpha'].join('\n'));
    wf('g/three.txt', 'alpha in txt');
    wf('g/bin.dat', 'alpha\x00binary');
    wf('g/long.txt', 'X'.repeat(3000) + ' alpha');
  });

  it('按文件分组返回行号与预览', async () => {
    const out = parse(await grep.execute!({ pattern: 'alpha' } as any));
    expect(out.status).toBe('ok');
    const groups = out.data.groups as Array<{ path: string; matches: Array<{ line: number }> }>;
    const byPath = new Map(groups.map((g) => [g.path, g.matches.map((m) => m.line)]));
    expect(byPath.get('g/bin.dat')).toBeUndefined(); // 二进制跳过
    expect(byPath.get('g/one.ts')).toEqual([1, 2]);
    expect(byPath.get('g/two.tsx')).toEqual([1, 2]);
    expect(byPath.get('g/three.txt')).toEqual([1]);
    expect(byPath.get('g/long.txt')).toEqual([1]);
    expect(out.data.total).toBe(6);
  });

  it('include 过滤（花括号交替；txt 被排除）', async () => {
    const out = parse(await grep.execute!({ pattern: 'alpha', include: '*.{ts,tsx}' } as any));
    const paths = (out.data.groups as Array<{ path: string }>).map((g) => g.path);
    expect(paths).toEqual(['g/one.ts', 'g/two.tsx']);
  });

  it('include 拒绝逗号列表与否定值', async () => {
    expect(parse(await grep.execute!({ pattern: 'alpha', include: '*.ts,*.tsx' } as any)).status).toBe('error');
    expect(parse(await grep.execute!({ pattern: 'alpha', include: '!*.ts' } as any)).status).toBe('error');
  });

  it('正则语义 + 无效正则报错', async () => {
    const out = parse(await grep.execute!({ pattern: 'al\\w+a' } as any));
    expect(out.data.total).toBeGreaterThan(0);
    expect(parse(await grep.execute!({ pattern: '[' } as any)).status).toBe('error');
  });

  it('单文件目标直搜（include 不适用）', async () => {
    const out = parse(await grep.execute!({ pattern: 'again', path: 'g/two.tsx', include: '*.ts' } as any));
    expect(out.data.total).toBe(1);
    expect(out.data.groups[0].path).toBe('g/two.tsx');
  });

  it('长行预览截断带标记', async () => {
    const out = parse(await grep.execute!({ pattern: 'alpha', path: 'g/long.txt' } as any));
    const preview = out.data.groups[0].matches[0].preview as string;
    expect(preview.length).toBeLessThanOrEqual(2020);
    expect(preview).toContain('(line truncated)');
  });

  it('无匹配给出提示；越界路径报错', async () => {
    const out = parse(await grep.execute!({ pattern: 'zzz-nothing' } as any));
    expect(out.status).toBe('ok');
    expect(out.data.note).toContain('No matches found');
    expect(parse(await grep.execute!({ pattern: 'x', path: '../outside' } as any)).status).toBe('error');
  });
});
