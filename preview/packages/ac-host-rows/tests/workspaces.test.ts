// ============================================================
// workspaces.test.ts —— 工作区登记表纯函数面（cr-583）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listWorkspaces, registerWorkspace, updateWorkspace, removeWorkspace, workspacePathOf } from '../src/workspaces.ts';

const ROOT = path.join('preview', 'sandbox', 'test-workspaces-' + process.pid);
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
