import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeBashTool } from '../src/plugins/builtin/tools/files';
import type { AgentConfig } from '../src/agents/config';

let ws = '';
let shared = '';

function setup() {
  const base = path.join(os.tmpdir(), `agentchat-bash-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  ws = path.join(base, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  process.env.AGENTCHAT_WORKSPACE = ws;
}

function teardown() {
  delete process.env.AGENTCHAT_WORKSPACE;
  // 后台进程可能仍持有 cwd 句柄，同步阻塞重试删除（最多 ~1s）
  const base = path.dirname(ws);
  for (let i = 0; i < 10; i++) {
    try {
      if (fs.existsSync(base)) fs.rmSync(base, { recursive: true, force: true });
      return;
    } catch {
      const sab = new SharedArrayBuffer(4);
      const arr = new Int32Array(sab);
      Atomics.wait(arr, 0, 0, 100); // 同步阻塞 100ms
    }
  }
}

const cfg: AgentConfig = { agent_id: 'a', name: 'A' };

describe('bash background/timeout', () => {
  it('timeout 参数可调：短命令正常完成', async () => {
    setup();
    try {
      const tool = makeBashTool(cfg);
      const r = await tool.execute({ command: 'echo hello', timeout: 5000 });
      expect(String(r)).toContain('hello');
    } finally { teardown(); }
  });

  it('background：后台启动返回 PID + 日志文件，不阻塞', async () => {
    setup();
    try {
      const tool = makeBashTool(cfg);
      const r = await tool.execute({
        command: 'Start-Sleep -Seconds 3; Write-Output "done"',
        background: true,
      });
      const parsed = JSON.parse(String(r));
      expect(parsed.status).toBe('success');
      expect(parsed.data.background).toBe(true);
      expect(typeof parsed.data.pid).toBe('number');
      expect(parsed.data.log_file).toBeTruthy();
      expect(fs.existsSync(parsed.data.log_file)).toBe(true);
    } finally { teardown(); }
  });

  it('stdin：通过管道传给命令', async () => {
    setup();
    try {
      const tool = makeBashTool(cfg);
      // PowerShell 读 stdin
      const r = await tool.execute({ command: '[Console]::In.ReadToEnd()', stdin: 'via-stdin' });
      expect(String(r)).toContain('via-stdin');
    } finally { teardown(); }
  });
});
