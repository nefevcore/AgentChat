// ============================================================
// src/services/backup 单元测试 —— 数据备份（L4）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBackup, listBackups, backupDue, backupRootDir,
  BACKUP_KEEP, BACKUP_INTERVAL_MS, BACKUP_DIR,
} from '../src/services/backup';

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  prevCwd = process.cwd();
  process.chdir(tmp);                       // backupRootDir() → tmp/backups
  process.env.AGENTCHAT_WORKSPACE = tmp;    // workspaceRoot() → tmp
});
afterEach(() => {
  process.chdir(prevCwd);
  delete process.env.AGENTCHAT_WORKSPACE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('services/backup', () => {
  it('常量与目录解析', () => {
    expect(BACKUP_DIR).toBe('backups');
    expect(BACKUP_KEEP).toBe(4);
    expect(BACKUP_INTERVAL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(backupRootDir()).toBe(path.join(tmp, 'backups'));
  });

  it('listBackups 无备份返回空数组', () => {
    expect(listBackups()).toEqual([]);
    expect(backupDue()).toBe(true); // 无备份 → 到期
  });

  it('createBackup 打包工作区文件并列出', () => {
    // 准备工作区数据
    const sessionDir = path.join(tmp, 'sessions', 'user__agentA');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'messages.jsonl'), '{"role":"agent"}\n', 'utf-8');

    const result = createBackup({ force: true });
    expect(result.skipped).toBeUndefined();
    expect(result.file).toMatch(/^backup-.*\.zip$/);
    expect(result.size).toBeGreaterThan(0);

    const backups = listBackups();
    expect(backups.length).toBe(1);
    expect(backups[0].file).toBe(result.file);

    // 校验 zip 内容包含会话数据
    const zip = new AdmZip(path.join(tmp, 'backups', result.file));
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names.some((n) => n.includes('sessions/user__agentA/messages.jsonl'))).toBe(true);
  });

  it('备份排除 node_modules/.git/dist 等非数据目录', () => {
    fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'node_modules', 'x.js'), 'x', 'utf-8');
    fs.writeFileSync(path.join(tmp, 'data.txt'), 'data', 'utf-8');

    const result = createBackup({ force: true });
    const zip = new AdmZip(path.join(tmp, 'backups', result.file));
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names.some((n) => n.includes('data.txt'))).toBe(true);
    expect(names.some((n) => n.includes('node_modules'))).toBe(false);
    expect(names.some((n) => n.includes('.git'))).toBe(false);
    expect(names.some((n) => n.includes('dist'))).toBe(false);
  });

  it('间隔内非强制跳过（skipped=true）；force 强制执行', () => {
    // 模拟近期已有备份（mtime=now → 间隔未到）
    const dir = path.join(tmp, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'backup-recent.zip'), 'old', 'utf-8');

    expect(backupDue()).toBe(false);

    const skipped = createBackup(); // 非强制
    expect(skipped.skipped).toBe(true);
    expect(skipped.file).toBe('');

    const forced = createBackup({ force: true });
    expect(forced.skipped).toBeUndefined();
    expect(forced.file).toMatch(/^backup-.*\.zip$/);
  });

  it('保留最近 BACKUP_KEEP 份，循环覆盖', () => {
    // 预置 6 个旧备份（文件名倒序即最新在前）
    const dir = path.join(tmp, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 6; i++) {
      const name = `backup-2026-01-0${i}T00-00-00.zip`;
      fs.writeFileSync(path.join(dir, name), 'x', 'utf-8');
    }
    // 修改时间使其按名字倒序排列正确（旧→新）
    const names = fs.readdirSync(dir).sort();
    names.forEach((n, idx) => {
      const t = new Date(Date.UTC(2026, 0, idx + 1)).getTime();
      fs.utimesSync(path.join(dir, n), t / 1000, t / 1000);
    });

    createBackup({ force: true });
    const backups = listBackups();
    expect(backups.length).toBeLessThanOrEqual(BACKUP_KEEP + 1); // 新备份 + 保留 4
  });

  it('工作区不存在时抛错', () => {
    process.env.AGENTCHAT_WORKSPACE = path.join(tmp, 'nope-ws');
    expect(() => createBackup({ force: true })).toThrow(/工作区不存在/);
  });
});
