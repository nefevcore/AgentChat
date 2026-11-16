// ============================================================
// boot-progress.test.ts —— boot 进度文件读写（cr-1125 批 1：
// shell-protocol-off-stdio-plan §2.1 落盘承接形态）
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readBootProgress, writeBootProgress, BOOT_PROGRESS_FILE } from '../src/index.ts';

describe('boot-progress 读写纯库（cr-1125）', () => {
  it('写入后可回读全量字段', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-bp-'));
    writeBootProgress(dir, {
      bootId: 'b1', writtenAt: new Date().toISOString(), rows: 31,
      fingerprintRoot: 'sha-x',
      pluginLoadFailures: [{ plugin: 'ac-demo', error: 'boom' }],
    });
    expect(readBootProgress(dir)).toEqual({
      bootId: 'b1', writtenAt: expect.any(String), rows: 31,
      fingerprintRoot: 'sha-x',
      pluginLoadFailures: [{ plugin: 'ac-demo', error: 'boom' }],
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('缺席 = null；损坏 JSON = null；bootId 缺失 = null（不采信半形态）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-bp-'));
    expect(readBootProgress(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, BOOT_PROGRESS_FILE), '{broken', 'utf-8');
    expect(readBootProgress(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, BOOT_PROGRESS_FILE), JSON.stringify({ rows: 3 }), 'utf-8');
    expect(readBootProgress(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('覆写 = 单文件最新态（temp+rename 原子——目录内无残留 tmp）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-bp-'));
    writeBootProgress(dir, { bootId: 'b1', writtenAt: 't1', rows: 1 });
    writeBootProgress(dir, { bootId: 'b1', writtenAt: 't2', rows: 2 });
    expect(readBootProgress(dir)).toMatchObject({ rows: 2 });
    expect(fs.readdirSync(dir)).toEqual([BOOT_PROGRESS_FILE]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
