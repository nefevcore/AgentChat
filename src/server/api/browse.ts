// ============================================================
// 文件浏览 API —— 打开原生文件选择对话框，返回选中文件路径
//
// 用途：前端 file 类型配置字段的"选择文件"功能。
// 通过 PowerShell 的 OpenFileDialog 获取完整绝对路径，
// 绕过浏览器安全限制（浏览器无法直接获取文件完整路径）。
// ============================================================

import { Router, Request, Response } from 'express';
import { spawnSync } from 'child_process';
import { logger } from '@utils/logger';

export function createBrowseRouter(): Router {
  const router = Router();
  /** GET /api/browse/read-file?path=... —— 读取工作区文件内容 */
  router.get('/read-file', (req: Request, res: Response) => {
    const filePath = (req.query.path as string) || '';
    if (!filePath) return res.status(400).json({ error: '缺少 path 参数' });

    try {
      const fsSync = require('fs');
      const absPath = require('path').resolve(filePath);
      if (!fsSync.existsSync(absPath)) return res.status(404).json({ error: '文件不存在' });
      const stat = fsSync.statSync(absPath);
      if (stat.isDirectory()) return res.status(400).json({ error: '路径是目录而非文件' });
      if (stat.size > 2 * 1024 * 1024) return res.status(400).json({ error: '文件超过 2MB' });
      const content = fsSync.readFileSync(absPath, 'utf-8');
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
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        encoding: 'utf-8',
        timeout: 60000,
        windowsHide: true,
      });

      const output = (result.stdout ?? '').trim();

      if (result.error) {
        logger.warn('[browse] PowerShell 执行失败:', result.error.message);
        return res.json({ success: false, error: '无法打开文件对话框' });
      }

      if (output === '__CANCELLED__' || !output) {
        return res.json({ success: false, cancelled: true });
      }

      logger.info(`[browse] 用户选择了文件: ${output}`);
      return res.json({ success: true, path: output });
    } catch (err: any) {
      logger.error('[browse] 异常:', err.message);
      return res.json({ success: false, error: err.message });
    }
  });

  return router;
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
