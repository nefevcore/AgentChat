// ============================================================
// ac-workspace/open-targets：「打开方式」纯模块——目录表解析
//（平台矩阵 / locator 命中序 / ${VAR} 展开 / 缓存 / 自愈 / 启动
// 编排看护窗协议）。probe seam 全注入假桩，离线锁定行为面；
// spawn 经 spawnImpl 注入 node 单行进程（真 spawn 协议）。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  OPEN_TARGET_CATALOG,
  expandCandidate,
  resolveTarget,
  resolveOpenTargets,
  resetOpenTargetCache,
  refreshTarget,
  scrubbedEnv,
  whichInPath,
  runOpenWith,
  type TargetProbe,
  type ResolvedTarget,
} from '../src/open-targets.ts';

/** 假桩 probe：可控的文件/目录/PATH/注册表事实 */
function fakeProbe(facts: Partial<TargetProbe> = {}): TargetProbe {
  return {
    platform: 'win32',
    env: {},
    isFile: async () => false,
    isDir: async () => false,
    which: async () => null,
    appPathOf: async () => null,
    applicationRoots: [],
    ...facts,
  };
}

const SPEC = (id: string): ReturnType<typeof OPEN_TARGET_CATALOG.find> => OPEN_TARGET_CATALOG.find((s) => s.id === id);

describe('目录表平台矩阵 resolveTarget', () => {
  it('win32 vscode：App Paths 命中即止（不试固定路径）', async () => {
    const probe = fakeProbe({ appPathOf: async (exe) => (exe === 'Code.exe' ? 'C:/opt/Code.exe' : null), isFile: async () => true });
    const r = await resolveTarget(SPEC('vscode')!, probe);
    expect(r?.launch).toEqual({ command: 'C:/opt/Code.exe', args: [] });
  });

  it('win32 vscode：App Paths 证不出 → LOCALAPPDATA 固定路径（${VAR} 展开 + 磁盘验证）', async () => {
    const probe = fakeProbe({
      env: { LOCALAPPDATA: 'C:/Users/x/AppData/Local' },
      isFile: async (p) => p === 'C:/Users/x/AppData/Local/Programs/Microsoft VS Code/Code.exe',
    });
    const r = await resolveTarget(SPEC('vscode')!, probe);
    expect(r?.launch.command).toBe('C:/Users/x/AppData/Local/Programs/Microsoft VS Code/Code.exe');
  });

  it('win32 vscode：两道都证不出 → null（缺席）', async () => {
    const r = await resolveTarget(SPEC('vscode')!, fakeProbe());
    expect(r).toBeNull();
  });

  it('darwin cursor：/Applications bundle 目录命中 → open -a', async () => {
    const probe = fakeProbe({
      platform: 'darwin',
      isDir: async (p) => p === '/Applications/Cursor.app',
      applicationRoots: ['/Applications'],
    });
    const r = await resolveTarget(SPEC('cursor')!, probe);
    expect(r?.launch).toEqual({ command: 'open', args: ['-a', '/Applications/Cursor.app'] });
  });

  it('linux vscode：PATH 上的 code CLI', async () => {
    const probe = fakeProbe({ platform: 'linux', which: async (n) => (n === 'code' ? '/usr/bin/code' : null) });
    const r = await resolveTarget(SPEC('vscode')!, probe);
    expect(r?.launch).toEqual({ command: '/usr/bin/code', args: [] });
  });

  it('linux 无 code CLI → null；notepad 在非 win32 平台 → null（未声明）', async () => {
    expect(await resolveTarget(SPEC('vscode')!, fakeProbe({ platform: 'linux' }))).toBeNull();
    expect(await resolveTarget(SPEC('notepad')!, fakeProbe({ platform: 'linux' }))).toBeNull();
  });

  it('explorer（cr-831）：win file 定位器（SystemRoot 展开）携 fileArgs（文件=定位选中）', async () => {
    const r = await resolveTarget(SPEC('explorer')!, fakeProbe({
      env: { SystemRoot: 'C:/Windows' },
      isFile: async (p) => p === 'C:/Windows/explorer.exe',
    }));
    expect(r?.launch.command).toBe('C:/Windows/explorer.exe');
    expect(r?.kind).toBe('both');
    expect(r?.launch.fileArgs?.('C:/x/a.md')).toEqual(['/select,', 'C:/x/a.md']);
  });

  it('explorer mac：open -R 选中形态；linux：xdg-open 父目录退化', async () => {
    const mac = await resolveTarget(SPEC('explorer')!, fakeProbe({ platform: 'darwin' }));
    expect(mac?.launch.fileArgs?.('/Users/x/a.md')).toEqual(['-R', '/Users/x/a.md']);
    const linux = await resolveTarget(SPEC('explorer')!, fakeProbe({ platform: 'linux' }));
    expect(linux?.launch.fileArgs?.('/home/x/sub/a.md')).toEqual(['/home/x/sub']);
  });

  it('runOpenWith：文件目标走 fileArgs（定位选中）；目录目标走 args+路径', async () => {
    let seen: { cmd: string; args: string[] } | null = null;
    const target: ResolvedTarget = {
      id: 'explorer',
      label: '文件资源管理器',
      kind: 'both',
      launch: { command: process.execPath, args: [], fileArgs: (f) => ['/select,', f] },
    };
    const impl = (cmd: string, args: string[]): any => {
      seen = { cmd, args };
      return spawn(process.execPath, ['-e', 'process.exit(0)']);
    };
    await runOpenWith(target, 'C:/x/a.md', { spawnImpl: impl, watchMs: 3000 });
    expect(seen!.args).toEqual(['/select,', 'C:/x/a.md']);
    await runOpenWith(target, 'C:/x', { isDir: true, spawnImpl: impl, watchMs: 3000 });
    expect(seen!.args).toEqual(['C:/x']);
  });

  it('windowsterminal：wt.exe PATH 命中 → args 携 -d（目录参语义）', async () => {
    const probe = fakeProbe({ which: async (n) => (n === 'wt.exe' ? 'C:/bin/wt.exe' : null) });
    const r = await resolveTarget(SPEC('windowsterminal')!, probe);
    expect(r?.launch).toEqual({ command: 'C:/bin/wt.exe', args: ['-d'] });
    expect(r?.kind).toBe('dir');
  });

  it('terminal（mac fixed）：open -a Terminal 恒可用', async () => {
    const r = await resolveTarget(SPEC('terminal')!, fakeProbe({ platform: 'darwin' }));
    expect(r?.launch).toEqual({ command: 'open', args: ['-a', 'Terminal'] });
  });
});

describe('${VAR} 展开 expandCandidate', () => {
  it('已设变量展开；未设变量 = null 整体放弃', async () => {
    expect(expandCandidate('${LOCALAPPDATA}/x', { LOCALAPPDATA: 'C:/la' })).toBe('C:/la/x');
    expect(expandCandidate('${MISSING}/x', {})).toBeNull();
  });
});

describe('PATH 解析 whichInPath', () => {
  it('win：PATHEXT 逐扩展试探；posix：直接名', async () => {
    const win = await whichInPath('wt', { PATH: 'C:/bin;C:/a', PATHEXT: '.EXE;.COM' }, async (p) => p === 'C:/bin/wt.EXE');
    expect(win).toBe('C:/bin/wt.EXE');
    const posix = await whichInPath('code', { PATH: '/usr/bin:/bin' }, async (p) => p === '/usr/bin/code');
    expect(posix).toBe('/usr/bin/code');
  });
});

describe('解析 map 与自愈', () => {
  beforeEach(() => resetOpenTargetCache());

  it('map：命中条目进 map、证不出缺席；kind 投影随行', async () => {
    const probe = fakeProbe({
      env: { SystemRoot: 'C:/Windows' },
      isFile: async (p) => p === 'C:/Windows/System32/notepad.exe',
    });
    const map = await resolveOpenTargets(probe);
    expect(map.has('notepad')).toBe(true);
    expect(map.has('vscode')).toBe(false);
    expect(map.get('notepad')?.kind).toBe('file');
  });

  it('自愈：重解析命中换新 launch；证不出移除', async () => {
    let fileAt = 'C:/old/Code.exe';
    const probe = fakeProbe({ appPathOf: async () => fileAt, isFile: async () => true });
    const map = await resolveOpenTargets(probe);
    expect(map.get('vscode')?.launch.command).toBe('C:/old/Code.exe');
    fileAt = 'C:/new/Code.exe';
    const fresh = await refreshTarget('vscode', probe);
    expect(fresh?.launch.command).toBe('C:/new/Code.exe');
    expect(map.get('vscode')?.launch.command).toBe('C:/new/Code.exe');
    // 证不出：从 map 移除
    fileAt = '';
    const probe2 = fakeProbe({ appPathOf: async () => (fileAt === '' ? null : fileAt), isFile: async () => true });
    const gone = await refreshTarget('vscode', probe2);
    expect(gone).toBeNull();
  });

  it('未知 id 自愈 → null', async () => {
    expect(await refreshTarget('nope', fakeProbe())).toBeNull();
  });
});

describe('启动编排 runOpenWith（spawnImpl 注入真 node 进程）', () => {
  // node 单行进程：作为 argv 目标——exit 0 / exit 2 / 常驻三形态
  const target = (code: string, args: string[] = []): ResolvedTarget => ({
    id: 'test',
    label: 'test',
    kind: 'both',
    launch: { command: process.execPath, args: [...args, '-e', code] },
  });

  it('always 族（explorer 委托桌面进程）：非零退出码 = opened（成功语义）', async () => {
    const r = await runOpenWith(
      { id: 'explorer', label: '文件资源管理器', kind: 'both', launch: { command: process.execPath, args: [], fileArgs: () => ['-e', 'process.exit(1)'] } },
      'C:/x/a.md',
      { watchMs: 3000 },
    );
    expect(r).toEqual({ opened: true });
  });

  it('退出 0 → opened；非 0 → error 点名退出码', async () => {
    const ok = await runOpenWith(target('process.exit(0)'), '/tmp/x.md', { watchMs: 3000 });
    expect(ok).toEqual({ opened: true });
    const fail = await runOpenWith(target('process.exit(2)'), '/tmp/x.md', { watchMs: 3000 });
    expect(String(fail.error)).toContain('退出码 2');
  });

  it('看护窗：常驻进程窗关仍活 = opened（不等退出）', async () => {
    const r = await runOpenWith(target('setTimeout(() => {}, 5000)'), '/tmp/x.md', { watchMs: 250 });
    expect(r).toEqual({ opened: true });
  });

  it('ENOENT：spawn error → error（自愈编排归 RPC）', async () => {
    const r = await runOpenWith({ id: 'x', label: 'x', kind: 'both', launch: { command: 'Z:/no/such.exe', args: [] } }, '/tmp/x', { watchMs: 2000 });
    expect(r.error).toBeTruthy();
  });

  it('目标路径追加在 args 尾部；env 为白名单投影', async () => {
    let seen: { cmd: string; args: string[]; env: Record<string, string> } | null = null;
    const fakeChild = () => spawn(process.execPath, ['-e', 'process.exit(0)']);
    const r = await runOpenWith(
      { id: 't', label: 't', kind: 'dir', launch: { command: 'C:/bin/wt.exe', args: ['-d'] } },
      'C:/proj',
      {
        watchMs: 3000,
        spawnImpl: (cmd, args, env) => {
          seen = { cmd, args, env };
          return fakeChild();
        },
      },
    );
    expect(r.opened).toBe(true);
    expect(seen!.cmd).toBe('C:/bin/wt.exe');
    expect(seen!.args).toEqual(['-d', 'C:/proj']);
    expect(Object.keys(seen!.env).length).toBeLessThanOrEqual(20); // 白名单投影——无 SECRET 透传
  });
});

describe('env 白名单 scrubbedEnv', () => {
  it('只透传白名单键；凭据键不透传', async () => {
    const env = scrubbedEnv({
      PATH: 'C:/bin',
      OPENAI_API_KEY: 'sk-xxx',
      DEEPSEEK_SECRET: 'hush',
      TEMP: 'C:/tmp',
    });
    expect(env.PATH).toBe('C:/bin');
    expect(env.TEMP).toBe('C:/tmp');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_SECRET).toBeUndefined();
  });
});