// ============================================================
// 文件浏览 API —— 打开原生文件/文件夹选择对话框，返回选中路径
//
// 用途：前端 file 类型配置字段的"选择文件"功能（POST /file）；
// 用户工作区登记的"选择文件夹"功能（POST /folder）。
// 通过 PowerShell 的原生对话框获取完整绝对路径，
// 绕过浏览器安全限制（浏览器无法直接获取文件完整路径）。
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@agentchat/util';
const logger = createLogger('[server:browse]');

/**
 * 原生对话框异步执行（/file 与 /folder 共用）。
 *
 * 历史问题（2026-08-20 修复）：此前用 spawnSync + 60s 超时，有两个致命伤：
 *   ① spawnSync 阻塞整个 Node 事件循环——对话框开着多久，服务器就冻结多久
 *     （WS 聊天/流式/全部 API 停摆，等待期间整个应用像死了一样）；
 *   ② 60s 超时按机器节奏定，而对话框是"人翻目录"的节奏——用户多翻几层
 *     就被强杀，PowerShell ETIMEDOUT → 返回"无法打开文件夹对话框"，
 *     前端表现为"等待很长一段时间，然后报错失败"。
 *
 * 现在：异步 spawn（事件循环畅通，对话框打开期间其余功能照常）；
 * 超时 10 分钟（人性化节奏，走开再回来也来得及）；进程级单对话框互斥
 * （双击/并发触发两个模态对话框会互相压盖，无法操作）；退出码非 0 且
 * 无输出时带上 stderr 尾部（此前脚本失败被静默吞成 cancelled）。
 */

/** 对话框超时：人选文件夹是慢交互，10 分钟后自动关闭并提示 */
const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

/** 进程级互斥：同一时刻只允许一个原生对话框（file/folder 共用） */
let dialogInFlight = false;

function runDialogScript(res: Response, kind: 'file' | 'folder', script: string): void {
  if (dialogInFlight) {
    logger.warn(`[browse] ${kind} 对话框请求被拒绝：已有对话框打开（pid=${process.pid}）`);
    res.status(409).json({ success: false, error: '已有对话框打开，请先完成或取消后再试' });
    return;
  }
  dialogInFlight = true;
  logger.info(`[browse] ${kind} 对话框打开（pid=${process.pid}）`);

  let child: ChildProcess;
  try {
    child = spawn('powershell', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], { windowsHide: true });
  } catch (err: any) {
    dialogInFlight = false;
    logger.warn('[browse] PowerShell 启动失败:', err.message);
    res.json({ success: false, error: '无法启动 PowerShell 对话框脚本' });
    return;
  }

  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (respond: () => void) => {
    if (settled) return;
    settled = true;
    dialogInFlight = false;
    clearTimeout(timer);
    respond();
  };
  const timer = setTimeout(() => {
    child.kill();
    finish(() => res.json({ success: false, cancelled: true, error: '对话框超时（10 分钟无操作）已自动关闭' }));
  }, DIALOG_TIMEOUT_MS);

  child.stdout?.setEncoding('utf-8');
  child.stdout?.on('data', (d: string) => { stdout += d; });
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (d: string) => { stderr += d; });

  child.on('error', (err) => {
    logger.warn('[browse] PowerShell 执行失败:', err.message);
    finish(() => res.json({ success: false, error: '无法打开对话框（PowerShell 执行失败）' }));
  });

  child.on('close', (code) => {
    finish(() => {
      const output = stdout.trim();
      if (output === '__CANCELLED__') {
        return res.json({ success: false, cancelled: true });
      }
      if (output) {
        logger.info(`[browse] 用户选择了: ${output}`);
        return res.json({ success: true, path: output });
      }
      if (code === 3) {
        // PS 侧 __PICK_EMPTY__：对话框已完成但取路径失败——报错而非弹第二个框
        return res.json({ success: false, error: '对话框内部错误（未取到所选路径），请重试或手动输入路径' });
      }
      if (code !== 0 && stderr.trim()) {
        // 脚本崩溃（如 Add-Type 编译失败且回退也挂）：带 stderr 尾部返回，
        // 不再静默吞成 cancelled（此前表现为"什么都没发生"）
        const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
        logger.error(`[browse] 对话框脚本异常退出 code=${code}: ${tail}`);
        return res.json({ success: false, error: `对话框脚本失败: ${tail}` });
      }
      // 正常退出但无输出（用户直接关掉对话框等）
      return res.json({ success: false, cancelled: true });
    });
  });
}

export function createBrowseRouter(): Router {
  const router = Router();
  /** GET /api/browse/read-file?path=... —— 读取工作区文件内容 */
  router.get('/read-file', (req: Request, res: Response) => {
    const filePath = (req.query.path as string) || '';
    if (!filePath) return res.status(400).json({ error: '缺少 path 参数' });

    try {
      const fsSync = require('fs');
      const absPath = path.resolve(filePath);
      if (!fs.existsSync(absPath)) return res.status(404).json({ error: '文件不存在' });
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) return res.status(400).json({ error: '路径是目录而非文件' });
      if (stat.size > 2 * 1024 * 1024) return res.status(400).json({ error: '文件超过 2MB' });
      const content = fs.readFileSync(absPath, 'utf-8');
      return res.json({ success: true, path: absPath, content, size: stat.size });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/browse/file
   * Body: { accept?: string, title?: string }
   * accept: 文件扩展名过滤，如 ".mcp" 或 ".json,.txt"
   * title: 对话框标题
   *
   * 返回: { success: true, path: "C:\\...\\file.mcp" }
   * 或:   { success: false, cancelled: true }
   */
  router.post('/file', (req: Request, res: Response) => {
    const { accept, title } = req.body as { accept?: string; title?: string };

    // 构建 PowerShell 脚本：打开文件选择对话框
    const filter = buildFilter(accept);
    const dialogTitle = title ?? '选择文件';

    const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = '${dialogTitle.replace(/'/g, "''")}'
$dlg.Filter = '${filter.replace(/'/g, "''")}'
$dlg.FilterIndex = 1
$dlg.RestoreDirectory = $true

if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dlg.FileName
} else {
    Write-Output '__CANCELLED__'
}
`.trim();

    try {
      runDialogScript(res, 'file', psScript);
    } catch (err: any) {
      logger.error('[browse] 异常:', err.message);
      res.json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/browse/folder
   * Body: { title?: string }
   *
   * 打开原生文件夹选择对话框，返回选中文件夹绝对路径。
   * 用途：用户工作区登记（会话树分组的白名单文件夹）。
   *
   * 对话框选型（2026-08-20）：IFileDialog + FOS_PICKFOLDERS（Vista+ 现代文件
   * 对话框壳 —— 地址栏/搜索/收藏夹，与资源管理器同款观感），替代 WinForms
   * FolderBrowserDialog（包装上古 SHBrowseForFolder 树形对话框，WinForms 无
   * 现代版，观感与系统原生不符）。COM interop 槽位已在 Win 沙箱验证：
   * GetOptions 返回标准 FOS 组合 0x1808、SetFileName/GetFileName 回读一致、
   * Show 模态冒烟通过；Add-Type 编译失败时回退旧 FolderBrowserDialog。
   * 另：控制台输出切 UTF-8（修复非 ASCII 选中路径经 stdout 回传时的乱码）。
   *
   * 执行模型（2026-08-20）：异步 spawn + 10 分钟超时（见 runDialogScript）。
   *
   * 返回: { success: true, path: "C:\\...\\folder" }
   * 或:   { success: false, cancelled: true }
   */
  router.post('/folder', (req: Request, res: Response) => {
    const { title } = req.body as { title?: string };
    const dialogTitle = title ?? '选择工作区文件夹';
    const psScript = buildFolderPickerScript(dialogTitle);

    try {
      runDialogScript(res, 'folder', psScript);
    } catch (err: any) {
      logger.error('[browse] 异常:', err.message);
      res.json({ success: false, error: err.message });
    }
  });

  return router;
}

/**
 * IFileDialog 文件夹选择器的 C# interop 源（经 PS Add-Type 编译）。
 *
 * ⚠ 槽位顺序 = 本机 Windows SDK ShObjIdl_core.h（10.0.19041）IFileDialog 的
 * 【真实声明顺序】，与 MSDN 文档页的字母序完全不同——InterfaceIsIUnknown 严格
 * 按声明顺序映射 vtable 槽位，错一个即调用到别的方法（历史事故：GetResult 曾
 * 落在 AddPlace 槽 → AV 崩溃；SetTitle 曾落在 SetFileNameLabel 槽 → 标题变成
 * 编辑框标签）。真实顺序（含此前漏掉的 SetFolder/GetFolder/GetCurrentSelection/
 * SetOkButtonLabel/AddPlace/SetDefaultExtension/Close；注意 IFileDialog 没有
 * GetTitle/GetFileNameLabel）：
 *   Show SetFileTypes SetFileTypeIndex GetFileTypeIndex Advise Unadvise
 *   SetOptions GetOptions SetDefaultFolder SetFolder GetFolder
 *   GetCurrentSelection SetFileName GetFileName SetTitle SetOkButtonLabel
 *   SetFileNameLabel GetResult AddPlace SetDefaultExtension Close
 *   SetClientGuid ClearClientData SetFilter
 * （GUID d57c7288-… 的 IFileOpenDialog 再追加 GetResults/GetSelectedItems，
 *   本选择器用不到，不声明。）
 */
const FOLDER_PICKER_CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;

namespace AgentChat.Browse
{
    public static class FolderPicker
    {
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        private class FileOpenDialogRCW { }

        [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem
        {
            [PreserveSig] uint BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
            [PreserveSig] uint GetParent(out IShellItem ppsi);
            [PreserveSig] uint GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
            [PreserveSig] uint GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
            [PreserveSig] uint Compare(IShellItem psi, uint hint, out int piOrder);
        }

        [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileDialog
        {
            [PreserveSig] uint Show(IntPtr hwndOwner);
            [PreserveSig] uint SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
            [PreserveSig] uint SetFileTypeIndex(uint iFileType);
            [PreserveSig] uint GetFileTypeIndex(out uint piFileType);
            [PreserveSig] uint Advise(IntPtr pfde, out uint pdwCookie);
            [PreserveSig] uint Unadvise(uint dwCookie);
            [PreserveSig] uint SetOptions(uint fos);
            [PreserveSig] uint GetOptions(out uint pfos);
            [PreserveSig] uint SetDefaultFolder(IntPtr psi);
            [PreserveSig] uint SetFolder(IntPtr psi);
            [PreserveSig] uint GetFolder(out IntPtr ppsi);
            [PreserveSig] uint GetCurrentSelection(out IntPtr ppsi);
            [PreserveSig] uint SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            [PreserveSig] uint GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
            [PreserveSig] uint SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
            [PreserveSig] uint SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
            [PreserveSig] uint SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
            [PreserveSig] uint GetResult(out IShellItem ppsi);
            [PreserveSig] uint AddPlace(IntPtr psi, uint fdap);
            [PreserveSig] uint SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
            [PreserveSig] uint Close(uint hr);
            [PreserveSig] uint SetClientGuid(ref Guid guid);
            [PreserveSig] uint ClearClientData();
            [PreserveSig] uint SetFilter(IntPtr pUnk);
        }

        private const uint FOS_PICKFOLDERS = 0x20;
        private const uint FOS_FORCEFILESYSTEM = 0x40;
        private const uint FOS_FILEMUSTEXIST = 0x1000;
        private const uint SIGDN_FILESYSPATH = 0x80058000;

        public static string Pick(string title)
        {
            IFileDialog fd = (IFileDialog)new FileOpenDialogRCW();
            uint opts;
            fd.GetOptions(out opts);
            fd.SetOptions((opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM) & ~FOS_FILEMUSTEXIST);
            if (!string.IsNullOrEmpty(title)) fd.SetTitle(title);
            uint hr = fd.Show(GetForegroundWindow());
            if (hr != 0) return null;
            // 取结果走规范链路：GetResult(第 20 槽) → IShellItem.GetDisplayName(
            // SIGDN_FILESYSPATH) = 完整文件系统路径（FOS_FORCEFILESYSTEM 保证可取到）。
            // 历史 bug①：GetFileName 读的是"文件名"编辑框，FOS_PICKFOLDERS 下选中
            // 文件夹后常为空；bug②：GetResult 曾声明在错误的 vtable 槽（实际调用
            // AddPlace）→ AV 崩溃。另：Show() 已显示过对话框后【绝不 throw】——
            // 外层 PS catch 会弹回退 FolderBrowserDialog（第二个选择框）。
            IShellItem item;
            if (fd.GetResult(out item) == 0 && item != null)
            {
                string p;
                if (item.GetDisplayName(SIGDN_FILESYSPATH, out p) == 0 && !string.IsNullOrEmpty(p)) return p;
            }
            return "__PICK_EMPTY__";
        }
    }
}
`.trim();

/**
 * 组装文件夹选择 PS 脚本：优先 IFileDialog（现代样式），Add-Type 失败或运行
 * 异常时回退 WinForms FolderBrowserDialog（旧样式，但保功能可用）。
 * 输出协议与旧版一致：选中路径一行，或 __CANCELLED__。
 */
export function buildFolderPickerScript(dialogTitle: string): string {
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$src = @'
${FOLDER_PICKER_CSHARP}
'@
$title = '${dialogTitle.replace(/'/g, "''")}'
# 单次运行最多弹一个对话框：catch 回退仅在现代对话框【未曾显示】时可达
# （Add-Type 编译 / COM 实例化阶段失败）；Pick() 在 Show 之后不再 throw，
# 异常态经 __PICK_EMPTY__ 标记由后端报错，绝不弹第二个框。
try {
  Add-Type -TypeDefinition $src | Out-Null
  $p = [AgentChat.Browse.FolderPicker]::Pick($title)
  if ($p -eq '__PICK_EMPTY__') { exit 3 }
  if ($null -eq $p -or $p -eq '') { Write-Output '__CANCELLED__' } else { Write-Output $p }
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = $title
  $dlg.ShowNewFolderButton = $false
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath } else { Write-Output '__CANCELLED__' }
}
`.trim();
}

/**
 * 根据 accept 构建 Windows 文件对话框的 Filter 字符串。
 * 例如 accept=".mcp" → "MCP 文件 (*.mcp)|*.mcp|所有文件 (*.*)|*.*"
 */
function buildFilter(accept?: string): string {
  if (!accept) {
    return '所有文件 (*.*)|*.*';
  }

  const exts = accept.split(',').map(e => e.trim()).filter(Boolean);
  const label = exts.map(e => `*${e}`).join('; ');
  const pattern = exts.map(e => `*${e}`).join(';');
  return `${label}|${pattern}|所有文件 (*.*)|*.*`;
}
