// ============================================================
// 文件夹选择器 PS 脚本构建测试（buildFolderPickerScript）
//
// /api/browse/folder 的对话框选型：IFileDialog + FOS_PICKFOLDERS（Vista+
// 现代文件对话框壳）替代 WinForms FolderBrowserDialog（上古树形对话框）。
// COM interop 槽位已在 Win 沙箱实测（GetOptions=0x1808 / SetFileName 回读 /
// Show 模态冒烟），这里钉住脚本的结构性要素防回退：
//   · here-string 边界（'@ 必须行首——缩进即语法错误）
//   · 标题 PS 单引号转义（' → ''）
//   · 现代/回退双路径与 __CANCELLED__ 协议
// ============================================================
import { describe, expect, it } from 'vitest';
import { buildFolderPickerScript } from '../src/api/browse';

describe('buildFolderPickerScript（IFileDialog 现代文件夹选择器）', () => {
  const script = buildFolderPickerScript('选择工作区文件夹');

  it('C# interop 源内嵌：IFileOpenDialog GUID、FOS_PICKFOLDERS、命名空间入口', () => {
    expect(script).toContain("Guid(\"d57c7288-d4ad-4768-be02-9d969532d960\")");
    expect(script).toContain('FOS_PICKFOLDERS = 0x20');
    expect(script).toContain('FOS_FORCEFILESYSTEM = 0x40');
    expect(script).toContain('[AgentChat.Browse.FolderPicker]::Pick($title)');
  });

  it('vtable 槽位 = ShObjIdl_core.h 真实声明序（非 MSDN 字母序）', () => {
    // 历史事故：按文档字母序声明 → GetResult 落在 AddPlace 槽 → AV 崩溃；
    // SetTitle 落在 SetFileNameLabel 槽 → 标题错设为编辑框标签。
    // 钉住真实顺序的关键差异点（IFileDialog 没有 GetTitle/GetFileNameLabel；
    // 有 SetFolder/GetFolder/GetCurrentSelection/SetOkButtonLabel/AddPlace/Close）：
    const m = script.match(/\[PreserveSig\] uint (\w+)\(/g) ?? [];
    const names = m.map(s => s.replace('[PreserveSig] uint ', '').replace('(', ''));
    const idx = (n: string) => names.indexOf(n);
    // GetResult 必须在这些方法之后（真实头文件序）
    expect(idx('SetFolder')).toBeGreaterThan(idx('GetOptions'));
    expect(idx('GetCurrentSelection')).toBeGreaterThan(idx('SetFolder'));
    expect(idx('SetOkButtonLabel')).toBeGreaterThan(idx('SetTitle'));
    expect(idx('GetResult')).toBeGreaterThan(idx('SetFileNameLabel'));
    expect(idx('AddPlace')).toBeGreaterThan(idx('GetResult'));
    expect(idx('Close')).toBeGreaterThan(idx('AddPlace'));
    expect(idx('SetClientGuid')).toBeGreaterThan(idx('Close'));
    // 臆造的方法名禁止出现（IFileDialog 无此二者）
    expect(script).not.toContain('uint GetTitle(');
    expect(script).not.toContain('uint GetFileNameLabel(');
  });

  it('取结果走规范链路 GetResult → SIGDN_FILESYSPATH（GetFileName 只作兜底）', () => {
    // 历史 bug：用 GetFileName（文件名编辑框文本）取结果，FOS_PICKFOLDERS 下
    // 选中文件夹后常为空 → "对话框内部错误（未取到所选路径）"
    expect(script).toContain('uint GetResult(out IShellItem ppsi)');
    expect(script).toContain('SIGDN_FILESYSPATH = 0x80058000');
    expect(script).toContain('item.GetDisplayName(SIGDN_FILESYSPATH, out p)');
  });

  it('here-string 边界：开标记行尾、闭标记行首（缩进即 PS 语法错误）', () => {
    expect(script).toMatch(/\$src = @'\r?\n/);
    expect(script).toMatch(/^'@$/m);
  });

  it('标题单引号转义（PS 单引号字符串内 \' → \'\'）', () => {
    expect(buildFolderPickerScript("a'b'c")).toContain("$title = 'a''b''c'");
  });

  it('输出协议与双路径：现代优先、Add-Type 失败回退 FolderBrowserDialog、__CANCELLED__ 标记', () => {
    expect(script).toContain('Add-Type -TypeDefinition $src');
    expect(script).toContain('try {');
    expect(script).toContain('FolderBrowserDialog'); // 回退路径保留
    expect(script.match(/__CANCELLED__/g)?.length).toBeGreaterThanOrEqual(2); // 现代取消 + 回退取消
  });

  it('单次运行最多弹一个对话框：Pick 在 Show 后不再 throw（__PICK_EMPTY__ 标记 + exit 3）', () => {
    // 防"选完又弹第二个（回退）框"：Show 之后 GetFileName 为空 → 标记回传，
    // 由后端 exit 3 分支转错误响应；throw 只允许发生在对话框显示之前
    expect(script).toContain('return "__PICK_EMPTY__"');
    expect(script).toContain("if ($p -eq '__PICK_EMPTY__') { exit 3 }");
    expect(script).not.toContain('throw new InvalidOperationException'); // throw 会落入 catch 弹第二个框
  });

  it('控制台 UTF-8 输出（非 ASCII 选中路径回传不乱码）', () => {
    expect(script).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8');
  });
});
