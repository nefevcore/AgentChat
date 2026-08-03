// ============================================================
// edit 裸行号定位（snapshotLine）单元测试
//
// 背景（2026-08-03）：read v2 只输出 [PATH#TAG] 文件头 + 行号:内容，
// 不提供每行哈希，导致 JSON edits 路径的 pos/end（行号#哈希）无从填起，
// Agent 只能瞎猜/抄错哈希（editor 实测：抄了别的文件的哈希 → 哈希不匹配）。
// 修复：pos/end 支持裸行号，执行时用 read 快照解析期望哈希，交由行号+哈希路径验证。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { recordSnapshot, clearSnapshot } from '@global/agent-core/tools/edit/hashline-snapshot';
import { resolveSnapshotHash } from '@global/agent-core/tools/edit/edit-diff';
import { tool as editTool } from '@global/agent-core/tools/edit/tool';

describe('resolveSnapshotHash（裸行号 → read 快照解析期望哈希）', () => {
  const file = path.join(tmpdir(), `agentchat-edit-snap-${Date.now()}.md`);
  const content = 'line1\nline2\nline3\nline4\n';

  beforeEach(() => {
    fs.writeFileSync(file, content);
    recordSnapshot(file, content);
  });

  afterEach(() => {
    clearSnapshot(file);
    fs.rmSync(file, { force: true });
  });

  it('裸行号解析出该行的哈希（十六进制）', () => {
    const h = resolveSnapshotHash(file, 2);
    expect(h).toMatch(/^[0-9a-f]+$/);
    // 稳定：同一行重复解析结果一致
    expect(resolveSnapshotHash(file, 2)).toBe(h);
  });

  it('不同行哈希不同', () => {
    expect(resolveSnapshotHash(file, 1)).not.toBe(resolveSnapshotHash(file, 2));
  });

  it('未 read（无快照）→ 报错引导先 read', () => {
    clearSnapshot(file);
    expect(() => resolveSnapshotHash(file, 2)).toThrow(/read 快照/);
  });

  it('行号越界 → 报错', () => {
    expect(() => resolveSnapshotHash(file, 99)).toThrow(/超出 read 时文件范围/);
  });
});

// ============================================================
// 端到端：通过 edit 工具真实执行裸行号编辑（read 快照 → 行号+哈希验证）
// ============================================================

describe('edit JSON 裸行号端到端', () => {
  const dir = path.resolve('workspace/default');
  const rel = '__snap_edit_test.md';
  const file = path.join(dir, rel);
  const original = 'alpha\nbeta\ngamma\ndelta\n';

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, original);
    recordSnapshot(file, original); // 模拟 read 后的快照
  });

  afterEach(() => {
    clearSnapshot(file);
    fs.rmSync(file, { force: true });
  });

  it('pos 用裸行号替换第 2 行', async () => {
    const res = await editTool.execute(
      { edits: [{ filePath: rel, pos: '2', newText: 'BETA!' }] },
      undefined as any,
    );
    const parsed = JSON.parse(res);
    expect(parsed.status).toBe('success');
    expect(fs.readFileSync(file, 'utf-8')).toBe('alpha\nBETA!\ngamma\ndelta\n');
  });

  it('pos/end 都用裸行号做范围替换', async () => {
    const res = await editTool.execute(
      { edits: [{ filePath: rel, op: 'replace', pos: '1', end: '2', newText: 'X\nY' }] },
      undefined as any,
    );
    const parsed = JSON.parse(res);
    expect(parsed.status).toBe('success');
    expect(fs.readFileSync(file, 'utf-8')).toBe('X\nY\ngamma\ndelta\n');
  });

  it('append 用裸行号在第 2 行后插入', async () => {
    const res = await editTool.execute(
      { edits: [{ filePath: rel, op: 'append', pos: '2', newText: 'B2' }] },
      undefined as any,
    );
    const parsed = JSON.parse(res);
    expect(parsed.status).toBe('success');
    expect(fs.readFileSync(file, 'utf-8')).toBe('alpha\nbeta\nB2\ngamma\ndelta\n');
  });

  it('文件自 read 后被修改 → 裸行号哈希不匹配报错（不静默覆盖）', async () => {
    // 快照里第 2 行是 'beta'；修改文件第 2 行后，快照哈希与实际不符
    fs.writeFileSync(file, 'alpha\nCHANGED\ngamma\ndelta\n');
    const res = await editTool.execute(
      { edits: [{ filePath: rel, pos: '2', newText: 'BETA!' }] },
      undefined as any,
    );
    const parsed = JSON.parse(res);
    expect(parsed.status).toBe('error');
    expect(fs.readFileSync(file, 'utf-8')).toBe('alpha\nCHANGED\ngamma\ndelta\n'); // 文件未被改动
  });
});
