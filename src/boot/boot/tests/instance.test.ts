// ============================================================
// P2 测试：实例注册表（instance.ts）—— 写/读/活性/残留清理
// ============================================================
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  clearOwnInstance, describeInstance, findInstance, instanceFilePath,
  isProcessAlive, readInstance, writeInstance, type InstanceRecord,
} from '../src/instance';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-instance-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sampleRecord(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    pid: process.pid,
    port: 4831,
    profile: 'web-app',
    workspaceDir: tmp,
    startedAt: new Date().toISOString(),
    nodeVersion: process.version,
    ...overrides,
  };
}

/** 拿一个确定已死的 pid（短命子进程） */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 });
  expect(child.status).toBe(0);
  return child.pid!;
}

describe('isProcessAlive', () => {
  it('本进程存活；已退出进程与非法 pid 不存活', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(deadPid())).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });
});

describe('readInstance / writeInstance', () => {
  it('roundtrip：原子写后可完整读回', () => {
    const rec = sampleRecord();
    writeInstance(tmp, rec);
    expect(readInstance(tmp)).toEqual(rec);
    // 原子写不留 tmp 残留
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('缺失/损坏/结构非法 → null', () => {
    expect(readInstance(tmp)).toBeNull();
    fs.writeFileSync(instanceFilePath(tmp), '{broken json');
    expect(readInstance(tmp)).toBeNull();
    fs.writeFileSync(instanceFilePath(tmp), JSON.stringify({ pid: 'x' }));
    expect(readInstance(tmp)).toBeNull();
    fs.writeFileSync(instanceFilePath(tmp), JSON.stringify({ pid: 1 })); // 缺 port
    expect(readInstance(tmp)).toBeNull();
  });

  it('字段退化有缺省（profile/workspaceDir 非法字符串时兜底）', () => {
    fs.writeFileSync(instanceFilePath(tmp), JSON.stringify({ pid: 123, port: 80 }));
    const rec = readInstance(tmp)!;
    expect(rec.pid).toBe(123);
    expect(rec.port).toBe(80);
    expect(rec.profile).toBe('unknown');
    expect(rec.workspaceDir).toBe(tmp);
  });
});

describe('findInstance', () => {
  it('无注册表 → null；活实例 → alive=true；残留 → alive=false 但带 record', () => {
    expect(findInstance(tmp)).toBeNull();

    const rec = sampleRecord();
    writeInstance(tmp, rec);
    expect(findInstance(tmp)).toEqual({ alive: true, record: rec });

    const dead = deadPid();
    writeInstance(tmp, sampleRecord({ pid: dead }));
    const found = findInstance(tmp)!;
    expect(found.alive).toBe(false);
    expect(found.record.pid).toBe(dead);
  });
});

describe('clearOwnInstance', () => {
  it('只清自己的记录；他人记录不动', () => {
    // 自己的 → 删除
    writeInstance(tmp, sampleRecord());
    clearOwnInstance(tmp);
    expect(fs.existsSync(instanceFilePath(tmp))).toBe(false);
    // 不存在 → 无害
    clearOwnInstance(tmp);

    // 他人（活/死）→ 保留（活性检查兜底语义）
    const dead = deadPid();
    writeInstance(tmp, sampleRecord({ pid: dead }));
    clearOwnInstance(tmp);
    expect(fs.existsSync(instanceFilePath(tmp))).toBe(true);
  });
});

describe('describeInstance', () => {
  it('含 pid/port/profile 的人类可读行', () => {
    const line = describeInstance(sampleRecord({ startedAt: '2026-08-19T00:00:00Z' }));
    expect(line).toContain(`pid=${process.pid}`);
    expect(line).toContain('port=4831');
    expect(line).toContain('profile=web-app');
    expect(line).toContain('started=2026-08-19T00:00:00Z');
  });
});

describe('owner 接线 e2e（boot → 注册表写入 → 清理）', () => {
  it('bootstrap 后 boot-finalize 写入 instance.json（pid/port 对齐）', async () => {
    const { bootstrap } = await import('../src/bootstrap');
    const prevWs = process.env.AGENTCHAT_WORKSPACE;
    const prevE2E = process.env.AGENTCHAT_INSTANCE_E2E;
    process.env.AGENTCHAT_WORKSPACE = tmp;
    process.env.AGENTCHAT_INSTANCE_E2E = '1';
    fs.writeFileSync(path.join(tmp, '.initialized'), new Date().toISOString(), 'utf8');
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address();
        const p = typeof address === 'object' && address ? address.port : 0;
        srv.close((err) => (err ? reject(err) : resolve(p)));
      });
      srv.on('error', reject);
    });
    try {
      const result = await bootstrap({ enableWebUI: true, webuiPort: port });
      await result.webui?.stop();
      const rec = readInstance(tmp);
      expect(rec).not.toBeNull();
      expect(rec!.pid).toBe(process.pid);
      expect(rec!.port).toBe(port);
      expect(rec!.profile).toBe('web-app');
      // 清理接线（gracefulShutdown 的注册表步骤同函数）
      clearOwnInstance(tmp);
      expect(fs.existsSync(instanceFilePath(tmp))).toBe(false);
    } finally {
      if (prevWs === undefined) delete process.env.AGENTCHAT_WORKSPACE;
      else process.env.AGENTCHAT_WORKSPACE = prevWs;
      if (prevE2E === undefined) delete process.env.AGENTCHAT_INSTANCE_E2E;
      else process.env.AGENTCHAT_INSTANCE_E2E = prevE2E;
    }
  }, 30_000);
});
