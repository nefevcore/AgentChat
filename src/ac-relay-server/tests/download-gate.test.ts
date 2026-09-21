import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

// download-gate 集成测试：真起子进程（esbuild 产物不存在则直接 tsx 跑源码）

let gate: ChildProcess;
let dir: { root: string; state: string };
let srv: Server;
// 每轮随机端口：防上一轮未杀净的 stale gate 串扰（孤儿监听旧端口应答
// 旧 root 的 404，quota 却读旧 env——诡异现象的根源）
const GATE_PORT = 18000 + Math.floor(Math.random() * 2000);

async function get(path: string): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const res = await fetch(`http://127.0.0.1:${GATE_PORT}${path}`);
  const body = await res.json().catch(() => null);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, body, headers };
}

describe('download-gate 配额门', () => {
  beforeAll(async () => {
    const base = mkdtempSync(join(tmpdir(), 'dlg-'));
    dir = { root: join(base, 'root'), state: join(base, 'state') };
    mkdirSync(join(dir.root, 'v0.8.5'), { recursive: true });
    writeFileSync(join(dir.root, 'v0.8.5', 'AgentChat-Setup-0.8.5.exe'), 'x'.repeat(1000));
    writeFileSync(join(dir.root, 'manifest.json'), '{"releases":[]}');
    gate = spawn('npx', ['tsx', join(import.meta.dirname, '../src/download-gate.ts')], {
      env: { ...process.env, DL_GATE_PORT: String(GATE_PORT), DL_GATE_ROOT: dir.root, DL_GATE_STATE: dir.state, DL_GATE_QUOTA: '3' },
      stdio: 'ignore',
      shell: process.platform === 'win32',
      // cwd 隔离：vitest setup 会 chdir 到 workspace/test——子进程若继承该
      // cwd 会握住目录句柄，全局 setup 的 rmSync(workspace/test) 即 EPERM
      cwd: tmpdir(),
    });
    // 等就绪：子进程是 npx + tsx 冷启动（首次转换源码），全量并行下实测
    // 可被拖过 10s——原 40×250ms 窗口在重载下偶发耗尽，表现为后续用例
    // 集体 ECONNREFUSED（单独跑恒绿，属就绪预算不足而非被测行为错误）。
    // 放宽到 30s，并在耗尽时显式报错（不再让下游用例以连接拒绝的形态
    // 掩盖真因）。
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { await get('/healthz'); ready = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    if (!ready) throw new Error('download-gate 子进程 30s 内未就绪（npx tsx 冷启动失败或端口被占）');
  }, 30_000);

  afterAll(async () => {
    // Windows 下 shell:true 的 kill 只杀 npx 壳——树杀真子进程并等待退出，
    // 防孤儿（cwd 句柄锁 + stale 监听串扰下轮）
    if (gate?.pid) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          const t = spawn('taskkill', ['/PID', String(gate.pid), '/T', '/F'], { stdio: 'ignore' });
          t.on('exit', () => resolve());
          setTimeout(resolve, 3000); // 兜底
        });
      } else {
        gate.kill();
      }
    }
    rmSync(dir.root, { recursive: true, force: true });
    rmSync(dir.state, { recursive: true, force: true });
  });

  it('manifest 不计配额', async () => {
    const r = await get('/manifest.json');
    expect(r.status).toBe(404); // 未在 COUNTED 集内且非白名单路由 → 404（manifest 由 Nginx 直接静态服务，不经 gate）
  });

  it('配额内：X-Accel-Redirect + 计数递增', async () => {
    const q0 = await get('/api/quota');
    expect(q0.body).toMatchObject({ ok: true, quota: 3, remaining: 3 });
    const r = await get('/v0.8.5/AgentChat-Setup-0.8.5.exe');
    expect(r.status).toBe(200);
    expect(r.headers['x-accel-redirect']).toBe('/_internal/v0.8.5/AgentChat-Setup-0.8.5.exe');
    const q1 = await get('/api/quota');
    expect(q1.body.remaining).toBe(2);
  });

  it('路径穿越拒绝', async () => {
    const r = await get('/..%2F..%2Fetc%2Fpasswd.exe');
    expect(r.status).toBe(400);
  });

  it('超限：403 + 中文提示', async () => {
    await get('/v0.8.5/AgentChat-Setup-0.8.5.exe');
    await get('/v0.8.5/AgentChat-Setup-0.8.5.exe');
    const r = await get('/v0.8.5/AgentChat-Setup-0.8.5.exe');
    expect(r.status).toBe(403);
    expect(r.body.error).toContain('配额');
    const q = await get('/api/quota');
    expect(q.body.remaining).toBe(0);
  });

  it('不存在文件 404（不耗配额）', async () => {
    const before = (await get('/api/quota')).body.used;
    const r = await get('/v0.9.9/nope.exe');
    expect(r.status).toBe(404);
    const after = (await get('/api/quota')).body.used;
    expect(after).toBe(before);
  });
});
