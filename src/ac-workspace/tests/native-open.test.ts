// ============================================================
// ac-workspace/native-open：本地打开（纯模块）—— 平台命令矩阵、
// spawn 编排（真进程注入）、超时兜底、spawn error 分类。服务方法
// openLocal 的路径定位/守卫复用 resolveFile（workspace.test.ts
// 已锁），此处锁打开编排行为面。RPC workspace/open-local 为薄
// 委托不单测。
// ============================================================
import { describe, it, expect } from 'vitest';
import { openCommands, parentDirOf, runNativeOpen, type OpenCommand } from '../src/native-open.ts';

describe('平台命令矩阵 openCommands', () => {
  it('win32：explorer.exe 直开；select → /select, 形态（资源管理器选中）', () => {
    const open = openCommands('win32', 'C:\\proj\\demo.md')!;
    expect(open.command).toEqual({ cmd: 'explorer.exe', args: ['C:\\proj\\demo.md'] } satisfies OpenCommand);
    expect(open.family).toBe('always'); // explorer 退出码不可靠——只认 spawn error
    const sel = openCommands('win32', 'C:\\proj\\demo.md', { select: true })!;
    expect(sel.command.args).toEqual(['/select,', 'C:\\proj\\demo.md']);
  });

  it('darwin：open 直开；select → -R（Finder reveal）', () => {
    const open = openCommands('darwin', '/Users/x/a.md')!;
    expect(open.command).toEqual({ cmd: 'open', args: ['/Users/x/a.md'] });
    expect(open.family).toBe('strict');
    const sel = openCommands('darwin', '/Users/x/a.md', { select: true })!;
    expect(sel.command.args).toEqual(['-R', '/Users/x/a.md']);
  });

  it('linux：xdg-open 直开；select 无通用选中协议 → 退化为父目录', () => {
    const open = openCommands('linux', '/home/x/a.md')!;
    expect(open.command).toEqual({ cmd: 'xdg-open', args: ['/home/x/a.md'] });
    const sel = openCommands('linux', '/home/x/a.md', { select: true })!;
    expect(sel.command.args).toEqual(['/home/x']); // 父目录
  });

  it('不支持平台 → null（runNativeOpen 报不支持）', () => {
    expect(openCommands('freebsd', '/x')).toBeNull();
  });

  it('parentDirOf：win/posix 分隔符；根级文件原样（定位守卫在调用方）', () => {
    expect(parentDirOf('C:\\a\\b\\c.md')).toBe('C:\\a\\b');
    expect(parentDirOf('/a/b/c.md')).toBe('/a/b');
    expect(parentDirOf('/root.md')).toBe('/root.md');
  });
});

describe('spawn 编排 runNativeOpen（注入真进程）', () => {
  // node 单行进程替代系统命令：strict 族 = open/xdg-open 的退出码协议
  const nodeStrict = (code: string): { command: OpenCommand; family: 'strict' } => ({
    command: { cmd: process.execPath, args: ['-e', code] },
    family: 'strict',
  });

  it('strict 族：退出 0 → opened；非 0 → error 点名退出码', async () => {
    const ok = await runNativeOpen('/tmp/x.md', { command: nodeStrict('process.exit(0)') });
    expect(ok).toEqual({ opened: true });
    const fail = await runNativeOpen('/tmp/x.md', {
      command: nodeStrict('process.stderr.write("boom"); process.exit(2)'),
    });
    expect(fail.error).toContain('退出码 2');
  });

  it('strict 族：ENOENT → error 点名命令', async () => {
    const r = await runNativeOpen('/tmp/x.md', {
      command: { command: { cmd: 'definitely-missing-xyz-003', args: [] }, family: 'strict' },
    });
    expect(r.error).toContain('definitely-missing-xyz-003');
  });

  it('strict 族：超时按打开计（慢速文件管理器不误报失败）', async () => {
    const t0 = Date.now();
    const r = await runNativeOpen('/tmp/x.md', {
      timeoutMs: 120,
      command: nodeStrict('setTimeout(() => {}, 3000)'),
    });
    expect(r).toEqual({ opened: true });
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('always 族（explorer 协议）：常驻不退出 → 确认窗后 opened', async () => {
    const r = await runNativeOpen('C:\\x.md', {
      command: { command: { cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 3000)'] }, family: 'always' },
    });
    expect(r).toEqual({ opened: true });
  });

  it('always 族：spawn error（ENOENT）优先于确认窗', async () => {
    const r = await runNativeOpen('C:\\x.md', {
      command: { command: { cmd: 'definitely-missing-xyz-004', args: [] }, family: 'always' },
    });
    expect(r.error).toContain('definitely-missing-xyz-004');
  });

  it('不支持平台 → error 不抛异常', async () => {
    const r = await runNativeOpen('/tmp/x.md', { platform: 'freebsd' });
    expect(r.error).toContain('不支持本地打开');
  });
});
