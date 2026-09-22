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
import { SnapshotStore, SNAPSHOT_MAX_BYTES, looksLikeText } from '../src/store.ts';

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

describe('SnapshotStore —— 准入双闸（文本判定 + 大小上限）', () => {
  it('二进制文件（NUL/控制符打头）不复制内容：skipped=not-text，幂等', () => {
    const target = path.join(dir, 'blob.bin');
    fs.writeFileSync(target, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x41]));
    expect(store.ensure('conv~1', target)).toBe(true);
    const snap = store.get('conv~1', target)!;
    expect(snap.skipped).toBe('not-text');
    expect(snap.content).toBe(null);
    expect(fs.existsSync(snap.snapshotFile)).toBe(false); // 零内容文件落盘
    // 二进制文件改写后再 ensure——no-op（首见已发生）
    fs.writeFileSync(target, Buffer.from([0x09, 0x09]));
    expect(store.ensure('conv~1', target)).toBe(false);
    expect(store.get('conv~1', target)!.skipped).toBe('not-text');
  });

  it('utf-8 替换符残留（解码失败）判非文本', () => {
    const target = path.join(dir, 'bad-utf8.dat');
    fs.writeFileSync(target, Buffer.from([0xff, 0xfe, 0xfd, 0x41, 0x42]));
    store.ensure('conv~1', target);
    expect(store.get('conv~1', target)!.skipped).toBe('not-text');
  });

  it('文本文件前 8 KiB 内无控制符 → 正常快照（控制符在尾部不影响）', () => {
    const target = path.join(dir, 'text-with-tail.bin');
    // 前段纯文本 + 远超嗅探窗的控制符
    const content = 'x'.repeat(8192 * 2) + String.fromCharCode(0x01);
    fs.writeFileSync(target, content, 'utf-8');
    store.ensure('conv~1', target);
    const snap = store.get('conv~1', target)!;
    expect(snap.skipped).toBeUndefined();
    expect(snap.content).toBe(content);
  });

  it('超上限文件：skipped=too-large，零全文读（statSync 预检）', () => {
    const small = new SnapshotStore({ root: path.join(dir, 'snaps-small'), maxBytes: 16 });
    const target = path.join(dir, 'big.json');
    fs.writeFileSync(target, 'x'.repeat(64), 'utf-8');
    expect(small.ensure('conv~1', target)).toBe(true);
    const snap = small.get('conv~1', target)!;
    expect(snap.skipped).toBe('too-large');
    expect(snap.content).toBe(null);
    expect(fs.existsSync(snap.snapshotFile)).toBe(false);
  });

  it('maxBytes=0 关闭上限：大文件照常全量快照', () => {
    const unbounded = new SnapshotStore({ root: path.join(dir, 'snaps-unbounded'), maxBytes: 0 });
    const target = path.join(dir, 'huge.log');
    const content = 'y'.repeat(4096);
    fs.writeFileSync(target, content, 'utf-8');
    unbounded.ensure('conv~1', target);
    expect(unbounded.get('conv~1', target)!.content).toBe(content);
  });

  it('list 含跳过快照（可观测）；缺省上限 = 2 MiB', () => {
    expect(SNAPSHOT_MAX_BYTES).toBe(2 * 1024 * 1024);
    const dir2 = path.join(dir, 'sub2');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'a.bin'), Buffer.from([0x00]));
    fs.writeFileSync(path.join(dir2, 'b.md'), 'ok\n', 'utf-8');
    store.ensure('conv~l', path.join(dir2, 'a.bin'));
    store.ensure('conv~l', path.join(dir2, 'b.md'));
    const list = store.list('conv~l');
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.absPath.endsWith('a.bin'))!.skipped).toBe('not-text');
    expect(list.find((s) => s.absPath.endsWith('b.md'))!.content).toBe('ok\n');
  });

  it('looksLikeText 单元：空串/多行文本/制表符 = 文本；NUL·替换符 = 非文本', () => {
    expect(looksLikeText('')).toBe(true);
    expect(looksLikeText('line1\nline2\r\n\ttab')).toBe(true);
    expect(looksLikeText('a\u0000b')).toBe(false);
    expect(looksLikeText('a\uFFFDb')).toBe(false);
  });

  it('新建文件（首见不存在）无 skipped 字段——与跳过语义可区分', () => {
    const target = path.join(dir, 'fresh-new.ts');
    store.ensure('conv~1', target);
    const snap = store.get('conv~1', target)!;
    expect(snap.skipped).toBeUndefined();
    expect(snap.content).toBe(null);
  });
});
