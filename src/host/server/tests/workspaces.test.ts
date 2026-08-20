// ============================================================
// WorkspacesService（用户工作区）测试 —— CRUD/路径校验/重名拒绝
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { WorkspacesService } from '../src/workspaces';

let tmp: string;
let folderA: string;
let folderB: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-workspaces-'));
  // 两个真实存在的候选文件夹（模拟用户登记的目录）
  folderA = path.join(tmp, 'proj-alpha');
  folderB = path.join(tmp, 'proj-beta');
  fs.mkdirSync(folderA, { recursive: true });
  fs.mkdirSync(folderB, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('WorkspacesService CRUD', () => {
  it('create：写 workspace.json；name 缺省 = 文件夹名；list 按名称排序', () => {
    const svc = new WorkspacesService({ wsRoot: tmp });
    const b = svc.create({ path: folderB });          // 名缺省 = proj-beta
    const a = svc.create({ path: folderA, name: '甲项目' });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.name).toBe('甲项目');
    expect(a.path).toBe(path.resolve(folderA));
    expect(fs.existsSync(path.join(tmp, 'workspaces', a.id, 'workspace.json'))).toBe(true);
    // 排序：按 localeCompare(numeric) 升序（不硬编码拉丁/CKL 相对序，随 ICU 环境）
    const names = svc.list().map(w => w.name);
    expect(new Set(names)).toEqual(new Set(['proj-beta', '甲项目']));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    expect(svc.get(a.id)?.name).toBe('甲项目');
  });

  it('create 校验：空路径 / 不存在 / 非目录 / 重复登记 → 拒绝', () => {
    const svc = new WorkspacesService({ wsRoot: tmp });
    expect(() => svc.create({ path: ' ' })).toThrow(/不能为空/);
    expect(() => svc.create({ path: path.join(tmp, 'ghost') })).toThrow(/不存在/);
    const filePath = path.join(tmp, 'afile.txt');
    fs.writeFileSync(filePath, 'x', 'utf8');
    expect(() => svc.create({ path: filePath })).toThrow(/不是文件夹/);
    svc.create({ path: folderA });
    expect(() => svc.create({ path: folderA })).toThrow(/已是工作区/);
  });

  it('update：改名 / 换文件夹；同路径唯一（自身除外）', () => {
    const svc = new WorkspacesService({ wsRoot: tmp });
    const w = svc.create({ path: folderA });
    expect(svc.update(w.id, { name: '改名' }).name).toBe('改名');
    expect(svc.update(w.id, { path: folderB }).path).toBe(path.resolve(folderB));
    // 换回 folderA 不冲突（自身除外）
    expect(svc.update(w.id, { path: folderA }).path).toBe(path.resolve(folderA));
    // 另一个工作区占了 folderB → 再换过去拒绝
    const w2 = svc.create({ path: folderB });
    void w2;
    expect(() => svc.update(w.id, { path: folderB })).toThrow(/已是工作区/);
    expect(() => svc.update('ghost', { name: 'x' })).toThrow(/不存在/);
  });

  it('delete：只删登记目录；重复删除拒绝', () => {
    const svc = new WorkspacesService({ wsRoot: tmp });
    const w = svc.create({ path: folderA });
    svc.delete(w.id);
    expect(svc.get(w.id)).toBeNull();
    // 登记目录删除，但用户文件夹不受影响
    expect(fs.existsSync(folderA)).toBe(true);
    expect(() => svc.delete(w.id)).toThrow(/不存在/);
    // 删除后路径可重新登记
    expect(svc.create({ path: folderA }).path).toBe(path.resolve(folderA));
  });

  it('损坏/缺失 workspace.json → get 返回 null；list 跳过', () => {
    const svc = new WorkspacesService({ wsRoot: tmp });
    expect(svc.get('ghost')).toBeNull();
    fs.mkdirSync(path.join(tmp, 'workspaces', 'broken'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'workspaces', 'broken', 'workspace.json'), '{broken');
    expect(svc.get('broken')).toBeNull();
    expect(svc.list()).toHaveLength(0);
  });
});
