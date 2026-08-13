import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeBashTool, bashCommandViolation } from '../src/plugins/builtin/tools/files';
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

  it('前台执行返回结构化 JSON（status+data.output，供 WebUI 终端卡片渲染）', async () => {
    setup();
    try {
      const tool = makeBashTool(cfg);
      const r = await tool.execute({ command: 'echo json_ok; pwd', timeout: 5000 });
      const parsed = JSON.parse(String(r));
      expect(parsed.status).toBe('success');
      expect(typeof parsed.data).toBe('object');
      expect(parsed.data.output).toContain('json_ok');
      expect(parsed.data.command).toBe('echo json_ok; pwd');
      expect(parsed.data.exit_code).toBe(0);
      expect(parsed.data.success).toBe(true);
      expect(parsed.data.timed_out).toBe(false);
      expect(typeof parsed.data.total_bytes).toBe('number');
    } finally { teardown(); }
  });

  it('命令失败：返回 status=error + 非零 exit_code', async () => {
    setup();
    try {
      const tool = makeBashTool(cfg);
      const r = await tool.execute({ command: 'exit 3', timeout: 5000 });
      const parsed = JSON.parse(String(r));
      expect(parsed.status).toBe('error');
      expect(parsed.data.exit_code).toBe(3);
      expect(parsed.data.success).toBe(false);
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

describe('bashCommandViolation —— 白名单感知（与 allowedPaths 对齐）', () => {
  beforeEach(() => { setup(); });
  afterEach(() => { teardown(); });
  // ws = <base>/ws（一级），项目根 = dirname(ws) = <base>
  const projectRoot = () => path.dirname(ws);

  it('无白名单（默认）：cd .. / ../ 引用 / 盘符越界仍拦截', () => {
    expect(bashCommandViolation('cd .. ; git status')).toBeTruthy();
    expect(bashCommandViolation('git diff --stat -- ..\\src\\x.ts')).toBeTruthy();
    expect(bashCommandViolation('Get-Content C:\\Windows\\win.ini')).toBeTruthy();
  });

  it('白名单含项目根：cd .. 与 ../ 引用放行（超出项目根仍拦）', () => {
    const roots = [ws, projectRoot()];
    expect(bashCommandViolation('cd .. ; git status', roots)).toBeNull();
    expect(bashCommandViolation('git diff --stat -- ..\\src\\x.ts', roots)).toBeNull();
    expect(bashCommandViolation('Test-Path ..\\.git; git status', roots)).toBeNull();
    // 超出项目根仍拦
    expect(bashCommandViolation('cd ..\\.. ; pwd', roots)).toBeTruthy();
    expect(bashCommandViolation('git diff --stat -- ..\\..\\outside', roots)).toBeTruthy();
  });

  it('白名单内的盘符放行，白名单外仍拦', () => {
    const roots = [ws, projectRoot()];
    const inRoot = path.join(projectRoot(), 'a.txt');
    expect(bashCommandViolation(`Get-Content ${inRoot}`, roots)).toBeNull();
    expect(bashCommandViolation('Get-Content C:\\Windows\\win.ini', roots)).toBeTruthy();
  });
});
