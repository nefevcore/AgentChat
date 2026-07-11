// ============================================================
// 全局配置 API —— GET/POST /api/config
// ============================================================

import { Router, Request, Response } from 'express';
import { getGlobalConfig } from '../../../src/core/config';
import { getGlobalCredential, setGlobalCredential } from '../../../src/core/credential-store';
import * as fs from 'fs';
import * as path from 'path';

export function createConfigRouter(): Router {
  const router = Router();
  const configPath = path.join(getGlobalConfig().workspaceDir, 'config.json');

  /** GET /api/config —— 获取全局配置（从凭据库回填 api_key 掩码） */
  router.get('/', (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(configPath)) {
        res.json({ config: {} });
        return;
      }
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      delete config.$comment;
      // 从凭据库回填 api_key（显示掩码，仅用于指示是否已设置）
      if (config.llm?.provider) {
        const key = getGlobalCredential(config.llm.provider as string);
        config.llm.api_key = key ? '••••••••' : '';
      }
      res.json({ config });
    } catch (err: any) {
      res.status(500).json({ error: `读取全局配置失败: ${err.message}` });
    }
  });

  /** POST /api/config —— 保存全局配置（提取 api_key 到凭据库） */
  router.post('/', (req: Request, res: Response) => {
    try {
      let config = req.body.config as Record<string, unknown>;
      if (!config || typeof config !== 'object') {
        res.status(400).json({ error: '无效的配置数据' });
        return;
      }

      // 提取 api_key 到凭据存储，config.json 中不保存
      const llm = config.llm as Record<string, unknown> | undefined;
      if (llm?.provider && llm.api_key !== undefined && llm.api_key !== '••••••••') {
        setGlobalCredential(llm.provider as string, (llm.api_key as string) || '');
      }
      if (llm) delete llm.api_key; // 不写入 config.json

      // 读取现有文件，保留 $comment
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }

      // 合并：保留内部字段，覆盖用户字段
      const merged: Record<string, unknown> = {};
      for (const key of Object.keys(existing)) {
        if (key.startsWith('$')) {
          merged[key] = existing[key];
        }
      }
      for (const key of Object.keys(config)) {
        if (!key.startsWith('$')) {
          merged[key] = config[key];
        }
      }

      fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
      console.log(`[Config API] 全局配置已保存`);
      res.json({ success: true, message: '全局配置已保存' });
    } catch (err: any) {
      res.status(500).json({ error: `保存全局配置失败: ${err.message}` });
    }
  });

  return router;
}
