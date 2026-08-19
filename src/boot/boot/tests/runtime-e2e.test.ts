// ============================================================
// P2 e2e：workspace 运行时标识 .runtime（owner 接线全链路）
//
//   bootstrap → 入口原子获取（embedded）→ boot-finalize 补写 port/profile
//   → 读回校验 → releaseRuntime 清理
//   + timer reloadAll 与 boot 共享同一标识（单写者判定）
// ============================================================
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRuntime, releaseRuntime, runtimeFilePath } from '@agentchat/toolkit';
import { bootstrap } from '../src/bootstrap';

let tmp: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-runtime-e2e-'));
  prevWs = process.env.AGENTCHAT_WORKSPACE;
  process.env.AGENTCHAT_WORKSPACE = tmp;
  fs.writeFileSync(path.join(tmp, '.initialized'), new Date().toISOString(), 'utf8');
});

afterEach(() => {
  releaseRuntime(tmp);
  if (prevWs === undefined) delete process.env.AGENTCHAT_WORKSPACE;
  else process.env.AGENTCHAT_WORKSPACE = prevWs;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

describe('owner 接线 e2e（boot → .runtime 获取/补写 → 清理）', () => {
  it('bootstrap 后 .runtime 存在：入口获取 pid + finalize 补写 port/profile', async () => {
    const port = await freePort();
    const result = await bootstrap({ enableWebUI: true, webuiPort: port });
    await result.webui?.stop();

    const rec = readRuntime(tmp);
    expect(rec).not.toBeNull();
    expect(rec!.pid).toBe(process.pid);
    expect(rec!.port).toBe(port);
    expect(rec!.workspaceDir).toBe(tmp);
    // 文件确实在 workspace 内
    expect(fs.existsSync(runtimeFilePath(tmp))).toBe(true);

    // 清理接线（gracefulShutdown 的同一函数）
    releaseRuntime(tmp);
    expect(fs.existsSync(runtimeFilePath(tmp))).toBe(false);
  }, 30_000);
});
