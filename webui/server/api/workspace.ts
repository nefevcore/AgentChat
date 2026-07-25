// ============================================================
// 工作区文件 API —— GET /api/workspace/file?path=...
// 读取工作区文件内容，用于 WebUI 预览
// ============================================================

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalConfig } from '@core/config';

/** 常见 MIME 类型映射 */
const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/typescript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.java': 'text/x-java; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',
  '.env': 'text/plain; charset=utf-8',
  '.sh': 'text/x-sh; charset=utf-8',
  '.bash': 'text/x-sh; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.sql': 'text/x-sql; charset=utf-8',
  '.abap': 'text/plain; charset=utf-8',
  '.vue': 'text/x-vue; charset=utf-8',
  '.svelte': 'text/plain; charset=utf-8',
  '.rs': 'text/x-rust; charset=utf-8',
  '.go': 'text/x-go; charset=utf-8',
  '.rb': 'text/x-ruby; charset=utf-8',
  '.php': 'text/x-php; charset=utf-8',
  '.swift': 'text/x-swift; charset=utf-8',
  '.kt': 'text/x-kotlin; charset=utf-8',
  '.scala': 'text/x-scala; charset=utf-8',
  '.c': 'text/x-c; charset=utf-8',
  '.cpp': 'text/x-c++src; charset=utf-8',
  '.cxx': 'text/x-c++src; charset=utf-8',
  '.h': 'text/x-c; charset=utf-8',
  '.hpp': 'text/x-c++src; charset=utf-8',
  '.cs': 'text/x-csharp; charset=utf-8',
  '.dockerfile': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.bat': 'text/plain; charset=utf-8',
  '.cmd': 'text/plain; charset=utf-8',
};

/** 二进制/图片扩展名（不返回文本内容，只返回元数据） */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
]);

/** 最大返回文件大小（10MB） */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export function createWorkspaceRouter(): Router {
  const router = Router();

  /**
   * GET /api/workspace/file?path=...
   * 返回工作区文件内容及元数据。
   *
   * Query: path — 相对于工作区根目录的文件路径（支持 ./ 前缀）
   *
   * 返回:
   *   { path, content, contentType, size, binary }
   *   或 { error } 4xx/5xx
   */
  router.get('/file', (req: Request, res: Response) => {
    const filePath = req.query.path as string | undefined;
    if (!filePath) {
      return res.status(400).json({ error: '缺少 path 参数' });
    }

    const workspaceDir = getGlobalConfig().workspaceDir;

    // 规范化路径：去掉 ./ 前缀，解析相对路径
    const normalized = path.posix.normalize(filePath.replace(/\\/g, '/').replace(/^\.\//, ''));
    const fullPath = path.resolve(workspaceDir, normalized);

    // 安全检查：确保解析后的路径在工作区目录内
    if (!fullPath.startsWith(path.resolve(workspaceDir) + path.sep) && fullPath !== path.resolve(workspaceDir)) {
      return res.status(403).json({ error: '不允许访问工作区外的文件' });
    }

    // 检查文件是否存在
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: `文件不存在: ${normalized}` });
    }

    // 检查是否为目录
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: '不支持预览目录', path: normalized, isDirectory: true });
    }

    // 检查文件大小
    if (stat.size > MAX_FILE_SIZE) {
      return res.status(413).json({ error: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，超过 10MB 限制` });
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_MAP[ext] || 'text/plain; charset=utf-8';
    const isBinary = BINARY_EXTS.has(ext);

    if (isBinary) {
      // 对于图片，返回 base64 编码
      const buffer = fs.readFileSync(fullPath);
      const base64 = buffer.toString('base64');
      return res.json({
        path: normalized,
        content: base64,
        contentType,
        size: stat.size,
        binary: true,
        base64: true,
      });
    }

    // 尝试以 UTF-8 读取
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return res.status(500).json({ error: '无法读取文件内容' });
    }

    res.json({
      path: normalized,
      content,
      contentType,
      size: stat.size,
      binary: false,
    });
  });

  /**
   * GET /api/workspace/raw?path=...
   * 以原始内容类型返回文件，用于新窗口打开 HTML 预览等场景。
   */
  router.get('/raw', (req: Request, res: Response) => {
    const filePath = req.query.path as string | undefined;
    if (!filePath) {
      return res.status(400).send('缺少 path 参数');
    }

    const workspaceDir = getGlobalConfig().workspaceDir;
    const normalized = path.posix.normalize(filePath.replace(/\\/g, '/').replace(/^\.\//, ''));
    const fullPath = path.resolve(workspaceDir, normalized);

    // 安全检查
    if (!fullPath.startsWith(path.resolve(workspaceDir) + path.sep) && fullPath !== path.resolve(workspaceDir)) {
      return res.status(403).send('不允许访问工作区外的文件');
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).send(`文件不存在: ${normalized}`);
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return res.status(400).send('不支持预览目录');
    }

    if (stat.size > MAX_FILE_SIZE) {
      return res.status(413).send(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_MAP[ext] || 'text/plain; charset=utf-8';
    const content = fs.readFileSync(fullPath, 'utf-8');
    res.setHeader('Content-Type', contentType);
    res.send(content);
  });

  return router;
}
