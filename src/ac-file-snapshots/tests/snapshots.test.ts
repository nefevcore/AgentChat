// ============================================================
// ac-file-snapshots/tests/snapshots.test.ts —— 快照纯库验收
//
// 核心不变量：ensure 幂等（首见后绝不二写）、新建标记（首见不
// 存在 = existed:false）、get/list/drop 往返、键编码安全（Windows
// 路径/含特殊字符会话键）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SnapshotStore } from '../src/store.ts';

let dir: string;
let store: SnapshotStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-snap-'));
  store = new SnapshotStore({ root: path.join(dir, 'snapshots') });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SnapshotStore —— ensure 幂等', () => {
  it('存量文件首见：内容入快照；此后文件被改，快照不变', () => {
    const target = path.join(dir, 'a.ts');
    fs.writeFileSync(target, 'original\n', 'utf-8');
    expect(store.ensure('conv~1', target)).toBe(true);
    // 磁盘变更后再次 ensure —— no-op
    fs.writeFileSync(target, 'changed\n', 'utf-8');
    expect(store.ensure('conv~1', target)).toBe(false);
    const snap = store.get('conv~1', target)!;
    expect(snap.content).toBe('original\n');
    expect(snap.content).not.toBe('changed\n');
  });

  it('新建文件首见（磁盘不存在）：existed=false，content=null', () => {
    const target = path.join(dir, 'new-file.md');
    expect(store.ensure('conv~1', target)).toBe(true);
    const snap = store.get('conv~1', target)!;
    expect(snap.content).toBe(null);
  });

  it('同文件不同会话：各自独立快照', () => {
    const target = path.join(dir, 'shared.ts');
    fs.writeFileSync(target, 'v1\n', 'utf-8');
    store.ensure('conv~a', target);
    fs.writeFileSync(target, 'v2\n', 'utf-8');
    store.ensure('conv~b', target);
    expect(store.get('conv~a', target)!.content).toBe('v1\n');
    expect(store.get('conv~b', target)!.content).toBe('v2\n');
  });

  it('无快照 = get undefined', () => {
    const target = path.join(dir, 'never-seen.ts');
    fs.writeFileSync(target, 'x', 'utf-8');
    expect(store.get('conv~1', target)).toBeUndefined();
  });
});

describe('SnapshotStore —— list / drop', () => {
  it('list 返回会话全部快照（按路径排序）；drop 清空', () => {
    const a = path.join(dir, 'a.ts');
    const b = path.join(dir, 'sub', 'b.md');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(a, 'a', 'utf-8');
    fs.writeFileSync(b, 'b', 'utf-8');
    store.ensure('conv~1', a);
    store.ensure('conv~1', b);
    store.ensure('conv~2', a); // 其他会话不混入
    const list = store.list('conv~1');
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.absPath)).toEqual([a, b].sort((x, y) => x.localeCompare(y)));
    expect(store.dropConversation('conv~1')).toBe(1);
    expect(store.list('conv~1')).toHaveLength(0);
    expect(store.list('conv~2')).toHaveLength(1); // 其他会话不受影响
  });
});

describe('SnapshotStore —— 键编码安全', () => {
  it('Windows 绝对路径（盘符冒号 + 反斜杠）与会话键（| ~ :）安全往返', () => {
    const target = path.join(dir, 'deep', 'file name with spaces.ts');
    fs.mkdirSync(path.join(dir, 'deep'), { recursive: true });
    fs.writeFileSync(target, 'content\n', 'utf-8');
    const convId = 'pair:agent~1|user'; // 现实会话键形态（group:sid / pair:a|b）
    expect(store.ensure(convId, target)).toBe(true);
    const snap = store.get(convId, target)!;
    expect(snap.content).toBe('content\n');
    expect(snap.absPath).toBe(path.resolve(target));
  });

  it('中文文件名安全往返', () => {
    const target = path.join(dir, '文档.md');
    fs.writeFileSync(target, '中文内容\n', 'utf-8');
    store.ensure('会话一', target);
    const snap = store.get('会话一', target)!;
    expect(snap.content).toBe('中文内容\n');
  });
});
