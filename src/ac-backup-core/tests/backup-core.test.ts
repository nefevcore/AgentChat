// ============================================================
// ac-backup-core：打包 / 间隔检查 / 轮转保留 / 显式路径
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { backupDue, createBackup, listBackups } from '../src/index.ts';

const tmps: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-backup-core', () => {
  it('打包全量数据（含归档目录）+ 备份目录自身防递归', () => {
    const source = tmpDir('bk-src-');
    const backupDir = path.join(source, 'backups');
    fs.mkdirSync(path.join(source, 'sessions', 'a'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sessions', 'a', 'messages.jsonl'), '{"role":"user"}\n', 'utf-8');
    fs.mkdirSync(path.join(source, 'archive', 'a'), { recursive: true });
    fs.writeFileSync(path.join(source, 'archive', 'a', 'history_1.jsonl'), '归档也是记忆\n', 'utf-8');
    fs.mkdirSync(path.join(source, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(source, 'node_modules', 'x', 'junk.txt'), '排除我', 'utf-8');

    const result = createBackup({ sourceDir: source, backupDir, force: true });
    expect(result.skipped).toBeUndefined();
    expect(result.size).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(backupDir, result.file))).toBe(true);

    const zip = new AdmZip(path.join(backupDir, result.file));
    const entries = zip.getEntries().map((e) => e.entryName);
    expect(entries.some((n) => n.includes('sessions/a/messages.jsonl'))).toBe(true);
    expect(entries.some((n) => n.includes('archive/a/history_1.jsonl'))).toBe(true); // 全量含归档
    expect(entries.some((n) => n.includes('node_modules'))).toBe(false); // 排除目录
    expect(entries.some((n) => n.endsWith('.zip'))).toBe(false); // 备份目录防递归
  });

  it('间隔检查：无备份 = 到期；新备份未到期则 skipped', () => {
    const source = tmpDir('bk-src-');
    const backupDir = tmpDir('bk-out-');
    fs.writeFileSync(path.join(source, 'config.json'), '{}', 'utf-8');
    expect(backupDue(backupDir, 1000)).toBe(true); // 无备份
    const first = createBackup({ sourceDir: source, backupDir, force: true });
    // 改名模拟"更早的备份"（时间戳秒级会同名碰撞）
    fs.renameSync(
      path.join(backupDir, first.file),
      path.join(backupDir, 'backup-2020-01-01T00-00-00.zip'),
    );
    expect(backupDue(backupDir, 60_000_000)).toBe(false); // 刚备完（旧文件 mtime 未变？——改名保留 mtime）
    const second = createBackup({ sourceDir: source, backupDir }); // 非 force
    expect(second.skipped).toBe(true);
    expect(second.file).toBe('');
    expect(listBackups(backupDir)).toHaveLength(1);
    // force 跳过间隔检查
    const third = createBackup({ sourceDir: source, backupDir, force: true });
    expect(third.skipped).toBeUndefined();
    expect(listBackups(backupDir)).toHaveLength(2);
  });

  it('轮转保留：超出 keep 份的旧备份被清理', () => {
    const source = tmpDir('bk-src-');
    const backupDir = tmpDir('bk-out-');
    fs.writeFileSync(path.join(source, 'data.txt'), 'x', 'utf-8');
    for (let i = 0; i < 4; i++) {
      createBackup({ sourceDir: source, backupDir, force: true });
      // 文件名含时间戳（秒级）——强制错开命名
      const files = listBackups(backupDir);
      if (files.length > 1 && files[0].file === files[1].file) break;
    }
    // 时间戳秒级可能同名：手工制造 5 份不同名文件验证轮转语义
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(backupDir, `backup-2026-01-0${i + 1}T00-00-00.zip`), `v${i}`, 'utf-8');
    }
    createBackup({ sourceDir: source, backupDir, force: true, keep: 4 });
    const files = listBackups(backupDir);
    expect(files.length).toBeLessThanOrEqual(5); // 新备份 + 保留 4 份
  });

  it('备份源不存在 → 抛错（显式路径，不静默）', () => {
    expect(() =>
      createBackup({ sourceDir: path.join(tmpDir('bk-none-'), 'missing'), backupDir: tmpDir('bk-out-'), force: true }),
    ).toThrow(/备份源不存在/);
  });
});
