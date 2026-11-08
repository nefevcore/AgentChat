// ============================================================
// workspaces.test.ts —— 工作区登记表纯函数面（cr-583）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listWorkspaces, registerWorkspace, updateWorkspace, removeWorkspace, workspacePathOf } from '../src/workspaces.ts';

const ROOT = path.join('sandbox', 'test-workspaces-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('工作区登记表（cr-583：主线 ac-workspace 四方法语义）', () => {
  it('空根 = 空登记（文件缺席不抛）；register 生成 id + 缺省名 = 目录名', () => {
    expect(listWorkspaces(ROOT)).toEqual([]);
    const ws = registerWorkspace(ROOT, 'C:\\proj\\my-app');
    expect(ws.name).toBe('my-app');
    expect(ws.id).toMatch(/^ws-/);
    expect(listWorkspaces(ROOT)).toEqual([ws]);
    // 显式名优先；空白名回落目录名（主线 trim 语义）
    expect(registerWorkspace(ROOT, 'C:\\x', '  ').name).toBe('x');
    expect(registerWorkspace(ROOT, 'C:\\y', '自定义').name).toBe('自定义');
  });

  it('update / remove / workspacePathOf：未命中 undefined/false；命中改写并回读', () => {
    const ws = registerWorkspace(ROOT, 'C:\\proj', '项目');
    expect(updateWorkspace(ROOT, 'ws-ghost', { name: 'x' })).toBeUndefined();
    expect(removeWorkspace(ROOT, 'ws-ghost')).toBe(false);
    expect(workspacePathOf(ROOT, ws.id)).toBe('C:\\proj');
    expect(workspacePathOf(ROOT, 'ws-unknown')).toBeNull();
    const updated = updateWorkspace(ROOT, ws.id, { name: '新名' })!;
    expect(updated.name).toBe('新名');
    expect(listWorkspaces(ROOT)[0]!.name).toBe('新名');
    expect(removeWorkspace(ROOT, ws.id)).toBe(true);
    expect(listWorkspaces(ROOT)).toEqual([]);
  });

  it('坏文件（非数组）= 空登记不炸（会话全部落未分组而非 500）', () => {
    fs.writeFileSync(path.join(ROOT, 'workspaces.json'), '{"oops":true}', 'utf-8');
    expect(listWorkspaces(ROOT)).toEqual([]);
  });
});

describe('数据分层第二批（meta/workspaces.json 读旧写新——单源 ac-core-utils）', () => {
  it('写侧恒新位置 meta/；旧位置文件不动', () => {
    const legacy = path.join(ROOT, 'workspaces.json');
    fs.writeFileSync(legacy, JSON.stringify([{ id: 'ws-old', name: '旧', path: 'C:\\old', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]), 'utf-8');
    const ws = registerWorkspace(ROOT, 'C:\\proj\\new');
    // 新登记落新位置
    expect(fs.existsSync(path.join(ROOT, 'meta', 'workspaces.json'))).toBe(true);
    expect(fs.readFileSync(legacy, 'utf-8')).toContain('ws-old'); // 旧文件不迁移不改写
    // 读侧经兼容窗先见旧登记，首写把旧档合并进新位置（不迁移不丢数据）
    const ids = listWorkspaces(ROOT).map((w) => w.id);
    expect(ids).toContain(ws.id);
    expect(ids).toContain('ws-old');
  });

  it('新位置缺席 → 回落旧位置读（寄居期文件不迁移）', () => {
    const legacy = path.join(ROOT, 'workspaces.json');
    fs.writeFileSync(legacy, JSON.stringify([{ id: 'ws-legacy', name: '旧档', path: 'C:\\legacy', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]), 'utf-8');
    expect(listWorkspaces(ROOT).map((w) => w.id)).toEqual(['ws-legacy']);
    expect(workspacePathOf(ROOT, 'ws-legacy')).toBe('C:\\legacy');
  });

  it('旧位置坏文件 = 留档 .corrupt 后空登记（防写口以空表覆写唯一副本）', () => {
    const legacy = path.join(ROOT, 'workspaces.json');
    fs.writeFileSync(legacy, '{"oops":true}', 'utf-8');
    expect(listWorkspaces(ROOT)).toEqual([]);
    expect(fs.existsSync(legacy + '.corrupt')).toBe(true);
  });
});

