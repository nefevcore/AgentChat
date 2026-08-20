// ============================================================
// 沙箱工作目录（security.workdir）回归：
//   · sandboxWorkdir：缺省工作区根；绝对直用；相对按工作区根解析
//   · resolveSafePath：相对路径以 workdir 为基准（挂载场景不再落到工作区根）
//   · 越界防护不放松：workdir 本身必须在允许根（工作区/allowedPaths）内，
//     目标落在允许根之外仍拒绝
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentConfig } from '@agentchat/agent-config';
import { resolveSafePath, sandboxWorkdir, workspaceRoot } from '../src/shared';

let wsRoot = '';
let mounted = '';

beforeAll(() => {
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-wd-ws-'));
  mounted = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-wd-mount-'));
  process.env.AGENTCHAT_WORKSPACE = wsRoot;
});

afterAll(() => {
  delete process.env.AGENTCHAT_WORKSPACE;
  fs.rmSync(wsRoot, { recursive: true, force: true });
  fs.rmSync(mounted, { recursive: true, force: true });
});

/** 挂载场景配置（惰性：mounted 在 beforeAll 才创建，顶层求值会捕获空串） */
function mountedConfigOf(): AgentConfig {
  return {
    agent_id: '__minimal__',
    name: '极简模式',
    security: { allowedPaths: [mounted], workdir: mounted },
  } as unknown as AgentConfig;
}

describe('sandboxWorkdir', () => {
  it('缺省（无 security.workdir）= 工作区根', () => {
    expect(sandboxWorkdir({ agent_id: 'a', name: 'A' } as AgentConfig)).toBe(workspaceRoot());
  });

  it('绝对 workdir 直用；相对 workdir 按工作区根解析', () => {
    expect(sandboxWorkdir(mountedConfigOf())).toBe(mounted);
    const rel = {
      agent_id: 'a', name: 'A',
      security: { workdir: 'sub/dir' },
    } as unknown as AgentConfig;
    expect(sandboxWorkdir(rel)).toBe(path.join(wsRoot, 'sub', 'dir'));
  });
});

describe('resolveSafePath 相对基准', () => {
  it('挂载场景：相对路径落到挂载目录而非工作区根（回归：黑洞会话文件误写 workspace/default）', () => {
    const resolved = resolveSafePath(mountedConfigOf(), 'gargantua/index.html');
    expect(resolved).toBe(path.join(mounted, 'gargantua', 'index.html'));
    expect(resolved.startsWith(wsRoot)).toBe(false);
  });

  it('绝对路径不受基准影响；无 workdir 时相对路径仍按工作区根（既有行为）', () => {
    expect(resolveSafePath(mountedConfigOf(), path.join(mounted, 'x.txt'))).toBe(path.join(mounted, 'x.txt'));
    const plain = { agent_id: 'a', name: 'A' } as AgentConfig;
    expect(resolveSafePath(plain, 'files/a/x.md')).toBe(path.join(wsRoot, 'files', 'a', 'x.md'));
  });

  it('越界防护不放松：workdir 未列入 allowedPaths 时相对路径拒绝', () => {
    const rogue = {
      agent_id: 'a', name: 'A',
      security: { workdir: mounted }, // mounted 不在 allowedPaths
    } as unknown as AgentConfig;
    expect(() => resolveSafePath(rogue, 'x.txt')).toThrow(/越界|黑名单/);
  });
});
