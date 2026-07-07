// ============================================================
// Upload API —— POST /api/upload
// 文件上传，SHA-256 哈希存储
// ============================================================

import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import multer from 'multer';

// 使用 multer 处理 multipart/form-data
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

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
      // 计算 SHA-256 哈希
      const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const ext = path.extname(file.originalname);
      const storedName = hash + ext;
      const filePath = path.join(uploadDir, storedName);

      // 写入文件
      fs.writeFileSync(filePath, file.buffer);

      console.log(`[Upload] ${file.originalname} → ${storedName}（${file.size} 字节）`);

      res.json({
        hash: storedName,
        originalName: file.originalname,
        path: filePath,
        size: file.size,
        mimeType: file.mimetype,
      });
    } catch (err: any) {
      console.error(`[Upload] Error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
