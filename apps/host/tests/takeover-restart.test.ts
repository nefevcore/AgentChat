// ============================================================
// takeover.ts（cr-994）：接管壳锁观察器的 restart 意图识别——
// marker 在场 → emitExit(42)（warden 快路 respawn）+ marker 消费；
// 缺席 → emitExit(0)（done 不重拉）。真实 fs 锁面（sandbox 临时目录）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { adoptSocketShell } from '../takeover.ts';

const tmpDirs: string[] = [];

function mkDeps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-test-'));
  tmpDirs.push(dir);
  return {
    dir,
    marker: path.join(dir, 'restart-marker.json'),
    lockFile: path.join(dir, 'activation.lock'),
  };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 真实锁面：activation.lock 形如 {pid, bootId, acquiredAt, transportHint}（readActivationLock 消费） */
function writeLock(dir: string, pid: number, bootId: string): void {
  fs.writeFileSync(path.join(dir, 'activation.lock'), JSON.stringify({ pid, bootId, acquiredAt: new Date().toISOString(), transportHint: 'pipe-x' }), 'utf-8');
}

function depsOf(dir: string, marker: string) {
  return {
    agentDir: dir,
    restartMarkerFile: marker,
    manageCall: async () => ({}),
    manageProbeMs: 50,
    manageFrameMs: 50,
  };
}

describe('takeover 锁观察器 restart 意图（cr-994 / cr-1034 领取语义）', () => {
  it('锁消失 + marker 在场 → exit 42 + marker 领取成 .claimed（原文交接 cr-658 会话键——快路 respawn 责任链）', async () => {
    const { dir, marker, lockFile } = mkDeps();
    // 活锁状态（本壳 pid，假想常驻）
    const markerBody = JSON.stringify({ agentId: 'a1', conversationId: 'u1~a1', at: new Date().toISOString() });
    writeLock(dir, process.pid, 'boot-1');
    fs.writeFileSync(marker, markerBody, 'utf-8');
    const shell = adoptSocketShell({ agentId: 'a1', bootId: 'boot-1', pid: process.pid, hint: 'pipe-x' }, depsOf(dir, marker));
    const exits: Array<[number | null, string | null]> = [];
    shell.onExit((code, signal) => exits.push([code, signal]));
    // 壳退出：锁释放 + marker 在场（restart_shell 语义）
    fs.rmSync(lockFile);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(exits).toEqual([[42, null]]);
    expect(fs.existsSync(marker)).toBe(false); // .json 已领取——不留滞留
    // 领取形态承载原文：换代壳 boot 自清读取 conversationId 注入「已重启」
    const claimed = marker.replace(/\.json$/, '.claimed');
    expect(fs.existsSync(claimed)).toBe(true);
    expect(fs.readFileSync(claimed, 'utf-8')).toBe(markerBody);
  });

  it('锁消失 + marker 缺席 → exit 0（idle 自杀/正常退出——不重拉）', async () => {
    const { dir, lockFile } = mkDeps();
    writeLock(dir, process.pid, 'boot-1');
    const shell = adoptSocketShell({ agentId: 'a1', bootId: 'boot-1', pid: process.pid, hint: 'pipe-x' }, depsOf(dir, path.join(dir, 'restart-marker.json')));
    const exits: Array<[number | null, string | null]> = [];
    shell.onExit((code, signal) => exits.push([code, signal]));
    fs.rmSync(lockFile);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(exits).toEqual([[0, null]]);
  });

  it('锁仍持（壳活着）→ 不发退出；持锁者死 → exit 1（崩溃链，回归锁定）', async () => {
    const { dir } = mkDeps();
    // 用一个确定不存在的 pid（1 通常非本进程可探：Windows 上 pid 0/1 探活恒假）
    writeLock(dir, 999999999, 'boot-1');
    const shell = adoptSocketShell({ agentId: 'a1', bootId: 'boot-1', pid: 999999999, hint: 'pipe-x' }, depsOf(dir, path.join(dir, 'restart-marker.json')));
    const exits: Array<[number | null, string | null]> = [];
    shell.onExit((code, signal) => exits.push([code, signal]));
    await new Promise((r) => setTimeout(r, 2_500));
    expect(exits).toEqual([[1, null]]);
  });
});
