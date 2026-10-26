// ============================================================
// ac-workspace/native-dialog：本机系统原生文件夹选择（纯模块）
// —— 脚本要素（win32 C# interop / 回退门控 / 取消协议）、平台命令
// 矩阵、输出分类、spawn 编排（真进程注入，不弹真对话框）。
// 服务方法 pickFolder / RPC workspace/pick-folder 均为单行薄委托，
// 行为面由本测试全量锁定。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  pickFolderCommands,
  classifyPickOutcome,
  runNativePickFolder,
  type PickCommand,
} from '../src/native-dialog.ts';

/** 解码 win32 -EncodedCommand（base64(UTF-16LE) → 脚本文本） */
function decodeWinScript(): { script: string; command: PickCommand } {
  const [command] = pickFolderCommands('win32', '选择工作区文件夹');
  if (!command) throw new Error('win32 应产出候选命令');
  const b64 = command.args[command.args.indexOf('-EncodedCommand') + 1];
  return { script: Buffer.from(b64, 'base64').toString('utf16le'), command };
}

describe('win32 PowerShell 脚本要素（C# interop 现代选择器）', () => {
  it('IFileDialog CLSID/IID + FOS_PICKFOLDERS|FOS_FORCEFILESYSTEM + 标题经环境变量', () => {
    const { script, command } = decodeWinScript();
    // COM 身份（FileOpenDialog CLSID / IFileDialog IID）
    expect(script).toContain('DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7');
    expect(script).toContain('42f85136-db7e-439c-85f1-e4075d135fc8');
    // 文件夹选择标志（0x20 = FOS_PICKFOLDERS，0x1000 = FOS_FORCEFILESYSTEM）
    expect(script).toContain('0x20u | 0x1000u');
    // 标题经环境变量（Unicode 直达，不经 argv/脚本文本转码）
    expect(script).toContain('$env:AGENTCHAT_PICK_TITLE');
    expect(command.env?.AGENTCHAT_PICK_TITLE).toBe('选择工作区文件夹');
    // 前台窗口作 owner + STA（IFileDialog 需 STA 线程）+ 无 profile
    expect(script).toContain('GetForegroundWindow()');
    expect(command.args).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', expect.any(String)]);
  });

  it('here-string 闭标记行首（缩进即 PS 语法错误）+ 输出 UTF-8 + 取消协议', () => {
    const { script } = decodeWinScript();
    // 闭标记 '@ 必须独占行首
    expect(script).toMatch(/^'@$/m);
    // stdout 强制 UTF-8（非 ASCII 选中路径回传不乱码）
    expect(script).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8');
    // 单行输出协议：路径 或 __CANCELLED__
    expect(script).toContain("'__CANCELLED__'");
    // C# 源（here-string 段）恒 ASCII——Add-Type 落临时 .cs 文件不吃编码差异；
    // PS 包裹段的中文只存在于内存脚本（EncodedCommand = UTF-16LE base64，无损）
    const m = script.match(/@'\r?\n([\s\S]*?)\r?\n'@/);
    expect(m).not.toBeNull();
    expect(/^[\x00-\x7F]*$/.test(m![1])).toBe(true);
  });

  it('vtable 槽位序回归钉（按 SDK ShObjIdl_core.h 真实序声明）', () => {
    const { script } = decodeWinScript();
    // 曾错写成 SetClientSite 在前 / GetOptions 在 SetOptions 前：GetOptions 落到
    // Unadvise 槽返回 E_INVALIDARG（本机探针实测：错序 OPTS=0 + HRG=0x80070057，
    // 正确序 OPTS=0x1808 + SetOptions 往返 0x1828 + SetFileName/GetFileName 回读一致）
    const idx = (marker: string) => script.indexOf(marker);
    expect(idx('int Show(')).toBeGreaterThan(-1);
    expect(idx('int SetFileTypes(')).toBeGreaterThan(idx('int Show('));
    expect(idx('int GetFileTypeIndex(')).toBeGreaterThan(idx('int SetFileTypeIndex('));
    expect(idx('int Advise(')).toBeGreaterThan(idx('int GetFileTypeIndex('));
    expect(idx('int Unadvise(')).toBeGreaterThan(idx('int Advise('));
    expect(idx('int SetOptions(')).toBeGreaterThan(idx('int Unadvise('));
    expect(idx('int GetOptions(')).toBeGreaterThan(idx('int SetOptions('));
    expect(idx('int SetFileName(')).toBeGreaterThan(idx('int GetCurrentSelection('));
    expect(idx('int GetFileName(')).toBeGreaterThan(idx('int SetFileName('));
    expect(idx('int SetTitle(')).toBeGreaterThan(idx('int GetFileName('));
    // GetResult 链（路径回写修复）：IShellItem（IID 43826d1e…）+ SIGDN_FILESYSPATH
    expect(idx('int SetOkButtonLabel(')).toBeGreaterThan(idx('int SetTitle('));
    expect(idx('int SetFileNameLabel(')).toBeGreaterThan(idx('int SetOkButtonLabel('));
    expect(idx('int GetResult(out IShellItem')).toBeGreaterThan(idx('int SetFileNameLabel('));
    expect(script).toContain('43826d1e-e718-42ee-bc55-a1e261c37bfe'); // IID_IShellItem
    expect(idx('int GetDisplayName(')).toBeGreaterThan(idx('int GetParent(')); // IShellItem 槽 5
    // IFileDialog 无 SetClientSite（文档词条易误导；头文件即事实源——曾致整段错位）
    expect(script).not.toContain('SetClientSite');
  });

  it('路径回写回归钉：Pick() 取值走 GetResult→GetDisplayName(SIGDN_FILESYSPATH)，不用 GetFileName', () => {
    const { script } = decodeWinScript();
    // 实缺陷：GetFileName 读的是"文件名"编辑框文本，文件夹模式下不带完整路径
    // （DSH worker 同款走 GetResult 槽 20 + GetDisplayName 槽 5 + SIGDN_FILESYSPATH=0x80058000）
    const pickBody = script.slice(script.indexOf('public static string Pick(string title)'));
    expect(pickBody).toContain('dlg.GetResult(out item)');
    expect(pickBody).toContain('item.GetDisplayName(0x80058000u, out path)');
    expect(pickBody).not.toMatch(/dlg\.GetFileName\(/);
  });

  it('前台激活（DSH 同款 Alt 点击）：Show 前合成 Alt 按下/释放', () => {
    const { script } = decodeWinScript();
    // 后台宿主 spawn 的对话框会被 Windows 拒绝前台（藏在浏览器后面）——
    // keybd_event 合成一次 Alt 点击解除前台锁，对话框可靠置前
    expect(script).toContain('keybd_event');
    expect(script).toContain('0x12'); // VK_MENU（Alt）
    expect(script).toMatch(/ForegroundTap\(\);\s*\r?\n\s*if \(dlg\.Show\(/); // 恰在 Show 之前
  });

  it('线程 DPI 感知级联（DSH 同款）：Pick 首位、-4 → -3 → -2 逐级回退', () => {
    const { script } = decodeWinScript();
    // 无 DPI 感知时对话框按 96 DPI 渲染再位图拉伸（150% 缩放屏字体发虚）
    expect(script).toContain('SetThreadDpiAwarenessContext');
    const order = [
      script.indexOf('new IntPtr(-4)'),
      script.indexOf('new IntPtr(-3)'),
      script.indexOf('new IntPtr(-2)'),
    ];
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    // Pick() 内最先调用（先于任何窗口创建）
    const pickStart = script.indexOf('public static string Pick(string title)');
    const dpiCall = script.indexOf('EnableThreadDpiAwareness();');
    const comCreate = script.indexOf('new FileOpenDialogCom()');
    expect(dpiCall).toBeGreaterThan(pickStart);
    expect(dpiCall).toBeLessThan(comCreate);
  });

  it('回退 FolderBrowserDialog 仅在失败（$failed）时触发——用户取消不双弹', () => {
    const { script } = decodeWinScript();
    // 现代路径异常（Add-Type 编译失败 / Pick 抛错）→ $failed = true → 回退保功能
    expect(script).toContain('FolderBrowserDialog');
    expect(script).toMatch(/\$failed = \$true/);
    // 取消 = Show 返回非 0 → null（非异常）：$failed 保持 false，不进回退分支
    expect(script).toMatch(/if \(dlg\.Show\(GetForegroundWindow\(\)\) != 0\) return null/);
    // 回退块由 $failed 门控（而非 $picked 判空——判空会把取消也拽进回退）
    expect(script).toMatch(/if \(\$failed\) \{[\s\S]*FolderBrowserDialog/);
  });
});

describe('平台命令矩阵 pickFolderCommands', () => {
  it('darwin：osascript choose folder，标题进 prompt 且 AppleScript 转义', () => {
    const cmds = pickFolderCommands('darwin', '选"文件夹"\\路径');
    expect(cmds).toHaveLength(1);
    expect(cmds[0].cmd).toBe('osascript');
    expect(cmds[0].args[0]).toBe('-e');
    // 双引号与反斜杠转义后进 prompt
    expect(cmds[0].args[1]).toBe('POSIX path of (choose folder with prompt "选\\"文件夹\\"\\\\路径")');
    // 无标题 → 无 prompt 子句
    const bare = pickFolderCommands('darwin', undefined);
    expect(bare[0].args[1]).toBe('POSIX path of (choose folder)');
  });

  it('linux：zenity → kdialog 候选链（前者 ENOENT 才试后者）', () => {
    const cmds = pickFolderCommands('linux', '标题');
    expect(cmds.map((c) => c.cmd)).toEqual(['zenity', 'kdialog']);
    expect(cmds[0].args).toEqual(['--file-selection', '--directory', '--title', '标题']);
    expect(cmds[1].args.slice(0, 2)).toEqual(['--getexistingdirectory', '.']);
  });

  it('不支持平台 → 空候选（runNativePickFolder 报不可用）', () => {
    expect(pickFolderCommands('freebsd', 'x')).toEqual([]);
  });
});

describe('输出分类 classifyPickOutcome', () => {
  it('line（win32）：路径 / __CANCELLED__ / 空输出=取消 / 非 0 = error', () => {
    expect(classifyPickOutcome('line', 0, 'C:\\proj\\demo\r\n', '')).toEqual({ path: 'C:\\proj\\demo' });
    expect(classifyPickOutcome('line', 0, '__CANCELLED__', '')).toEqual({ cancelled: true });
    expect(classifyPickOutcome('line', 0, '', '')).toEqual({ cancelled: true });
    expect(classifyPickOutcome('line', 1, '', 'boom')).toEqual({ error: 'boom' });
    expect(classifyPickOutcome('line', 1, '', '')).toEqual({ error: '选择器进程退出码 1' });
  });

  it('osascript：0 = 路径；取消（stderr 取消词，含本地化防御）；其他非 0 = error', () => {
    expect(classifyPickOutcome('osascript', 0, '/Users/x/proj\n', '')).toEqual({ path: '/Users/x/proj' });
    expect(classifyPickOutcome('osascript', 1, '', 'User canceled.')).toEqual({ cancelled: true });
    expect(classifyPickOutcome('osascript', 1, '', 'execution error: -1708')).toEqual({ error: 'execution error: -1708' });
  });

  it('zenity/kdialog：1 = 取消（zenity/kdialog 取消码）；其他非 0 = error', () => {
    expect(classifyPickOutcome('zenity', 0, '/home/x/p\n', '')).toEqual({ path: '/home/x/p' });
    expect(classifyPickOutcome('zenity', 1, '', '')).toEqual({ cancelled: true });
    expect(classifyPickOutcome('kdialog', 1, '', '')).toEqual({ cancelled: true });
    expect(classifyPickOutcome('zenity', 2, '', 'bad option')).toEqual({ error: 'bad option' });
  });
});

describe('spawn 编排 runNativePickFolder（注入真进程替代对话框命令）', () => {
  // node 单行输出器：family 'line' 协议与 win32 powershell 输出同构
  const nodeLine = (code: string): PickCommand => ({
    cmd: process.execPath,
    args: ['-e', code],
    family: 'line',
  });

  it('选定路径 → path；__CANCELLED__ → cancelled；非 0 退出 → error', async () => {
    const path = await runNativePickFolder({
      commands: [nodeLine('process.stdout.write("C:\\\\proj\\\\demo")')],
    });
    expect(path).toEqual({ path: 'C:\\proj\\demo' });

    const cancel = await runNativePickFolder({ commands: [nodeLine('process.stdout.write("__CANCELLED__")')] });
    expect(cancel).toEqual({ cancelled: true });

    const fail = await runNativePickFolder({
      commands: [nodeLine('process.stderr.write("boom"); process.exit(1)')],
    });
    expect(fail.error).toBe('boom');
  });

  it('ENOENT → 候选链下一跳；全链缺失 → error 点名候选命令', async () => {
    const fallback = await runNativePickFolder({
      commands: [
        { cmd: 'definitely-missing-xyz-001', args: [], family: 'line' },
        nodeLine('process.stdout.write("D:\\\\ok")'),
      ],
    });
    expect(fallback).toEqual({ path: 'D:\\ok' });

    const none = await runNativePickFolder({
      commands: [
        { cmd: 'definitely-missing-xyz-001', args: [], family: 'line' },
        { cmd: 'definitely-missing-xyz-002', args: [], family: 'line' },
      ],
    });
    expect(none.error).toContain('definitely-missing-xyz-001 / definitely-missing-xyz-002');
  });

  it('超时兜底：杀进程并回 error（不等满默认 10 分钟）', async () => {
    const t0 = Date.now();
    const r = await runNativePickFolder({
      timeoutMs: 120,
      commands: [nodeLine('setTimeout(() => {}, 3000)')],
    });
    expect(r.error).toContain('超时');
    expect(Date.now() - t0).toBeLessThan(2500); // 确为超时杀进程返回，非自然结束
  });

  it('空候选（不支持平台）→ error 不抛异常', async () => {
    const r = await runNativePickFolder({ platform: 'freebsd', title: 'x' });
    expect(r.error).toContain('无原生文件夹选择器');
  });
});
