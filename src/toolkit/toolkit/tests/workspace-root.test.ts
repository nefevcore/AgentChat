// ============================================================
// toolkit 测试：workspaceRoot 解析链（多表面 CLI 缺省语义）
//
//   1. AGENTCHAT_WORKSPACE（绝对直用 / 相对按 cwd）
//   2. <cwd>/workspace/default 已初始化（.initialized 或 agents/）→ 沿用
//   3. 缺省 <AGENTCHAT_HOME|~/.agentchat>/workspace/default
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentchatHomeDir, workspaceRoot } from '../src/shared';

let tmp: string;
let prevCwd: string;
let prevWs: string | undefined;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-wsroot-'));
  prevCwd = process.cwd();
  prevWs = process.env.AGENTCHAT_WORKSPACE;
  prevHome = process.env.AGENTCHAT_HOME;
  process.env.AGENTCHAT_HOME = path.join(tmp, 'home'); // 不依赖真实 ~/.agentchat
  delete process.env.AGENTCHAT_WORKSPACE;
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevWs === undefined) delete process.env.AGENTCHAT_WORKSPACE;
  else process.env.AGENTCHAT_WORKSPACE = prevWs;
  if (prevHome === undefined) delete process.env.AGENTCHAT_HOME;
  else process.env.AGENTCHAT_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('agentchatHomeDir', () => {
  it('AGENTCHAT_HOME 覆盖；缺省 ~/.agentchat', () => {
    expect(agentchatHomeDir()).toBe(path.join(tmp, 'home'));
    delete process.env.AGENTCHAT_HOME;
    expect(agentchatHomeDir()).toBe(path.join(os.homedir(), '.agentchat'));
  });
});

describe('workspaceRoot 解析链', () => {
  it('① env 绝对路径直用；相对路径按 cwd 解析', () => {
    const abs = path.join(tmp, 'abs-ws');
    process.env.AGENTCHAT_WORKSPACE = abs;
    expect(workspaceRoot()).toBe(abs);

    process.chdir(tmp);
    process.env.AGENTCHAT_WORKSPACE = 'rel-ws';
    expect(workspaceRoot()).toBe(path.join(tmp, 'rel-ws'));
  });

  it('② cwd 下已有 workspace/default（.initialized）→ 沿用（repo/存量用户零迁移）', () => {
    process.chdir(tmp);
    const cwdWs = path.join(tmp, 'workspace', 'default');
    fs.mkdirSync(cwdWs, { recursive: true });
    fs.writeFileSync(path.join(cwdWs, '.initialized'), new Date().toISOString());
    expect(workspaceRoot()).toBe(cwdWs);
  });

  it('② cwd 下已有 workspace/default/agents（无 .initialized）→ 同样沿用', () => {
    process.chdir(tmp);
    const cwdWs = path.join(tmp, 'workspace', 'default');
    fs.mkdirSync(path.join(cwdWs, 'agents'), { recursive: true });
    expect(workspaceRoot()).toBe(cwdWs);
  });

  it('③ 全新目录裸跑 → 机器 home 缺省（数据不再散落随机 cwd）', () => {
    const fresh = path.join(tmp, 'fresh-dir');
    fs.mkdirSync(fresh, { recursive: true });
    process.chdir(fresh);
    // 注意：fresh-dir 内无 workspace/ → 落机器 home
    expect(workspaceRoot()).toBe(path.join(tmp, 'home', 'workspace', 'default'));
  });

  it('env 优先于 cwd 已有工作区（显式指定零歧义）', () => {
    process.chdir(tmp);
    const cwdWs = path.join(tmp, 'workspace', 'default');
    fs.mkdirSync(path.join(cwdWs, 'agents'), { recursive: true });
    const explicit = path.join(tmp, 'explicit-ws');
    process.env.AGENTCHAT_WORKSPACE = explicit;
    expect(workspaceRoot()).toBe(explicit);
  });
});
