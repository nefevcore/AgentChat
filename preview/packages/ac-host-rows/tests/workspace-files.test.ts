// ============================================================
// workspace-files.test.ts —— 工作区文件面纯函数（cr-676）
// 主线 ac-workspace 同语义：树基准三级优先序 / 读面两段定位 / 上传内容寻址。
// 数据根自指 preview/sandbox/（数据根隔离红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  agentWorkdirOf,
  conversationWorkspaceRoot,
  guessContentType,
  readWorkspaceFile,
  resolveWorkspaceFile,
  saveWorkspaceUpload,
  workspaceTree,
  workspaceTreeBase,
} from '../src/workspace-files.ts';

const ROOT = path.join('preview', 'sandbox', 'test-ws-files-' + process.pid);
const WS = path.join('preview', 'sandbox', 'test-ws-files-ext-' + process.pid);

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'files', 'neko'), { recursive: true });
  fs.mkdirSync(path.join(WS, 'src'), { recursive: true });
  writeJson(path.join(ROOT, 'agents', 'neko', 'config.json'), { id: 'neko', name: 'neko' });
  writeJson(path.join(ROOT, 'agents', '__standard__', 'config.json'), { id: '__standard__', preset: true });
  writeJson(path.join(ROOT, 'workspaces.json'), [
    { id: 'ws-1', name: '演示', path: path.resolve(WS), createdAt: '', updatedAt: '' },
  ]);
  writeJson(path.join(ROOT, 'viewer', 'sessions', 'conv-a', 'session.json'), { agentId: 'neko', workspaceId: 'ws-1' });
  fs.writeFileSync(path.join(WS, 'src', 'app.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(ROOT, 'note.md'), '# hi\n');
  fs.writeFileSync(path.join(ROOT, '.secret'), 'x');
  fs.writeFileSync(path.join(ROOT, 'files', 'neko', '.dsh-visible'), 'x');
  fs.writeFileSync(path.join(ROOT, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(WS, { recursive: true, force: true });
});

describe('树基准（会话挂载工作区 > Agent 级基准 > 数据根）', () => {
  it('三级优先序 + label 回显', () => {
    expect(workspaceTreeBase(ROOT, { conversationId: 'conv-a' })).toEqual({ dir: path.resolve(WS), label: '演示' });
    expect(workspaceTreeBase(ROOT, { agentId: 'neko' })).toEqual({ dir: path.resolve(ROOT, 'files', 'neko'), label: 'Agent/neko' });
    expect(conversationWorkspaceRoot(ROOT, 'conv-a')).toBe(path.resolve(WS));
    // 预设 Agent 无专用空间 → 数据根兜底（主线 treeBase 的 !preset && !virtual 门）
    expect(workspaceTreeBase(ROOT, { agentId: '__standard__' })).toEqual({ dir: path.resolve(ROOT), label: '' });
    expect(agentWorkdirOf(ROOT, '__standard__')).toBeUndefined();
    expect(workspaceTreeBase(ROOT)).toEqual({ dir: path.resolve(ROOT), label: '' });
  });

  it('显式 settings[security].workdir 最优先；损坏/缺席登记表按未挂载降级', () => {
    writeJson(path.join(ROOT, 'agents', 'tester', 'config.json'), {
      id: 'tester',
      settings: { security: { workdir: path.resolve(WS) } },
    });
    expect(workspaceTreeBase(ROOT, { agentId: 'tester' })).toEqual({ dir: path.resolve(WS), label: 'Agent/tester' });
    expect(conversationWorkspaceRoot(ROOT, 'conv-ghost')).toBeNull();
    expect(conversationWorkspaceRoot(ROOT, '../escape')).toBeNull();
  });
});

describe('目录树', () => {
  it('数据根过滤 dotfile / 目录优先排序 / 外挂工作区如实列 / 不可读 = 空层', () => {
    const root = workspaceTree(ROOT);
    expect(root.children.some((n) => n.name === '.secret')).toBe(false);
    expect(root.children[0].type).toBe('dir');
    expect(root.children).toEqual([...root.children].sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    expect(workspaceTree(ROOT, '', { agentId: 'neko' }).children.map((n) => n.name)).toContain('.dsh-visible');
    const ws = workspaceTree(ROOT, '', { conversationId: 'conv-a' });
    expect(ws.root.label).toBe('演示');
    expect(ws.children).toEqual([{ name: 'src', type: 'dir' }]);
    expect(workspaceTree(ROOT, 'no-such-dir').children).toEqual([]);
    expect(() => workspaceTree(ROOT, '../..')).toThrow('路径越界');
  });
});

describe('读面', () => {
  it('数据根快路径 / 工作区相对推导 / 二进制 base64 / 越界与缺失', () => {
    expect(readWorkspaceFile(ROOT, 'note.md')).toMatchObject({
      path: 'note.md', base64: false, contentType: 'text/markdown; charset=utf-8', content: '# hi\n',
    });
    // 相对引用：数据根未命中 → 工作区基准（displayPath = 绝对路径，raw 直链可追溯）
    const rel = readWorkspaceFile(ROOT, 'src/app.ts', { conversationId: 'conv-a' });
    expect(rel.path).toBe(path.resolve(WS, 'src', 'app.ts'));
    expect(rel.base64).toBe(false);
    expect(resolveWorkspaceFile(ROOT, 'note.md')).toBe(path.resolve(ROOT, 'note.md'));
    const bin = readWorkspaceFile(ROOT, 'bin.dat');
    expect(bin.base64).toBe(true);
    expect(Buffer.from(bin.content, 'base64')).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(() => readWorkspaceFile(ROOT, '../outside.txt')).toThrow('路径越界');
    // 无 context = 原语义（存在性错误照抛）；带 context = 基准推导耗尽后统一文案
    expect(() => resolveWorkspaceFile(ROOT, 'missing.txt')).toThrow(/ENOENT|不存在/);
    expect(() => readWorkspaceFile(ROOT, 'missing.txt', { conversationId: 'conv-a' }))
      .toThrow('文件不存在或不可读');
    // 基准外逃逸照拒（工作区相对引用同样禁 ../）
    expect(() => readWorkspaceFile(ROOT, '../../outside.txt', { conversationId: 'conv-a' }))
      .toThrow('文件不存在或不可读');
  });

  it('预览上限与 MIME 猜测', () => {
    expect(() => readWorkspaceFile(ROOT, 'note.md', undefined, 2)).toThrow('预览上限');
    expect(guessContentType('a.PNG')).toBe('image/png');
    expect(guessContentType('a.unknown')).toBe('application/octet-stream');
  });
});

describe('上传（内容寻址 + 桶推导）', () => {
  it('Agent 桶落 files/<id>/_tmp；同内容幂等；相对形 + 绝对形双形态', () => {
    const up = saveWorkspaceUpload(ROOT, 'neko', '报告 1.TXT', Buffer.from('hello'));
    expect(up.path).toMatch(/^files\/neko\/_tmp\/[0-9a-f]{12}\.TXT$/);
    expect(up.absPath).toBe(path.join(path.resolve(ROOT), 'files', 'neko', '_tmp', up.storedName));
    expect(fs.readFileSync(up.absPath, 'utf-8')).toBe('hello');
    const again = saveWorkspaceUpload(ROOT, 'neko', 'renamed.TXT', Buffer.from('hello'));
    expect(again.storedName).toBe(up.storedName);
  });

  it('agentId 缺席经会话推导承载 Agent；未推导 = shared 桶', () => {
    expect(saveWorkspaceUpload(ROOT, undefined, 'a.txt', Buffer.from('a'), 'conv-a').path)
      .toMatch(/^files\/neko\/_tmp\//);
    expect(saveWorkspaceUpload(ROOT, undefined, 'a.txt', Buffer.from('a')).path)
      .toMatch(/^files\/shared\/_tmp\//);
    expect(saveWorkspaceUpload(ROOT, '__standard__', 'a.txt', Buffer.from('a')).path)
      .toMatch(/^files\/__standard__\/_tmp\//);
  });
});
