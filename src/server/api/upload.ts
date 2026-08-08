// ============================================================
// Upload API —— POST /api/upload
// 附件上传：带 agentId → files/<agentId>/_tmp/（Agent 工作区临时目录）；
//           不带 → files/_tmp/（全局临时目录）。保留原始文件名。
// 重名处理：先比 SHA-256 哈希——内容一致则复用（幂等，不重复存）；
//           不一致则追加序号（name(1).ext, name(2).ext ...）。
// ============================================================

import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@core/logger';
const logger = createLogger('[server:upload]');
import { configService } from '@services/config-service';
import multer from 'multer';

// 使用 multer 处理 multipart/form-data
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  // 中文文件名：multipart 头默认按 latin1 解码，改为 utf-8 避免乱码
  defParamCharset: 'utf-8',
});

/** 计算 buffer 的 SHA-256 哈希（hex） */
function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 生成唯一存储名：优先原始文件名；若重名则哈希比对，
 * 一致 → 复用原名；不一致 → 加序号（name(1).ext）。
 */
function resolveStoredName(uploadDir: string, originalName: string, buffer: Buffer): { name: string; reused: boolean } {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  const hash = sha256(buffer);

  // 目标文件名（原始名优先）
  const candidate = originalName;
  const candidatePath = path.join(uploadDir, candidate);

  if (fs.existsSync(candidatePath)) {
    // 重名：哈希比对
    const existing = fs.readFileSync(candidatePath);
    if (sha256(existing) === hash) {
      return { name: candidate, reused: true }; // 内容一致 → 复用
    }
    // 不一致 → 加序号
    for (let i = 1; i < 1000; i++) {
      const numbered = `${base}(${i})${ext}`;
      const numberedPath = path.join(uploadDir, numbered);
      if (!fs.existsSync(numberedPath)) return { name: numbered, reused: false };
      // 若序号名也存在但内容一致，也可复用
      const existingN = fs.readFileSync(numberedPath);
      if (sha256(existingN) === hash) return { name: numbered, reused: true };
    }
  }
  return { name: candidate, reused: false };
}

export function createUploadRouter(uploadDir: string): Router {
  const router = Router();

  // 确保上传目录存在
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  router.post('/', upload.single('file'), (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: '未上传文件' });
    }

    try {
      // 目标目录：带 agentId → files/<agentId>/_tmp/（Agent 工作区）；不带 → files/_tmp/（全局）
      const agentId = (req.body?.agentId as string | undefined)?.trim();
      const targetDir = agentId
        ? path.join(uploadDir, agentId, '_tmp')
        : path.join(uploadDir, '_tmp');
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

      const { name: storedName, reused } = resolveStoredName(targetDir, file.originalname, file.buffer);
      const filePath = path.join(targetDir, storedName);

      if (!reused) {
        fs.writeFileSync(filePath, file.buffer);
      }

      logger.info(`[Upload] ${file.originalname} → ${storedName}（${file.size} 字节, ${reused ? '复用' : '新增'}, agent=${agentId || '全局'}）`);

      // 返回相对 workspaceDir 的路径（供 /api/workspace/file 预览/下载使用）
      const workspaceDir = configService.getGlobalConfig().workspaceDir;
      const relPath = path.relative(workspaceDir, filePath).split(path.sep).join('/');

      res.json({
        hash: sha256(file.buffer),
        originalName: file.originalname,
        storedName,
        path: relPath,
        size: file.size,
        mimeType: file.mimetype,
        reused,
      });
    } catch (err: any) {
      logger.error(`[Upload] Error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
