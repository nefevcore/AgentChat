// ============================================================
// 全局配置 API —— GET/POST /api/config
// ============================================================

import { Router, Request, Response } from 'express';
import { configService } from '@services/config-service';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@core/logger';
const logger = createLogger('[server:config]');

/** 解析 LLM 配置：优先 llm 字段，否则从池中找默认条目 */
function resolveLlmForDisplay(raw: unknown): Record<string, unknown> | null {
  if (raw) {
    if (typeof raw === 'string') {
      const pool = configService.getGlobalConfig().llmProviders[raw];
      return pool ? { $ref: raw, ...pool } as Record<string, unknown> : null;
    }
    const obj = raw as Record<string, unknown>;
    if (obj.$ref) {
      const pool = configService.getGlobalConfig().llmProviders[obj.$ref as string];
      return pool ? { ...pool, ...obj } as Record<string, unknown> : obj;
    }
    return obj;
  }
  // 无 llm 字段：自动从池取默认
  const pools = configService.getGlobalConfig().llmProviders;
  const entries = Object.entries(pools).filter(([k]) => !k.startsWith('$'));
  const def = entries.find(([_, v]) => v && (v as any).default);
  const poolName = def ? def[0] : entries[0]?.[0];
  if (poolName && pools[poolName]) {
    return { $ref: poolName, ...pools[poolName] } as Record<string, unknown>;
  }
  return null;
}

export function createConfigRouter(): Router {
  const router = Router();
  const configPath = path.join(configService.getGlobalConfig().workspaceDir, 'config.json');

  /** GET /api/config —— 获取全局配置（从凭据库回填 api_key 掩码） */
  router.get('/', (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(configPath)) {
        res.json({ config: {} });
        return;
      }
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      delete config.$comment;
      // 解析 LLM 池引用为完整配置
      if (config.llm) {
        config.llm = resolveLlmForDisplay(config.llm);
      }
      // 从凭据库回填 api_key（显示掩码，仅用于指示是否已设置）
      if (config.llm?.provider) {
        const credId = (config.llm as any).$ref ? `pool:${(config.llm as any).$ref}` : config.llm.provider as string;
        const key = configService.getCredential(credId);
        config.llm.api_key = key ? '••••••••' : '';
      }
      // 回填 llmProviders 池条目的 api_key 掩码
      if (config.llmProviders && typeof config.llmProviders === 'object') {
        for (const [name, entry] of Object.entries(config.llmProviders as Record<string, any>)) {
          if (name.startsWith('$') || !entry || typeof entry !== 'object') continue;
          if (entry.api_key) {
            const key = configService.getCredential(`pool:${name}`);
            entry.api_key = key ? '••••••••' : '';
          }
        }
      }
      // 回填 searchProviders 池条目的 apiKey 掩码
      if (config.searchProviders && typeof config.searchProviders === 'object') {
        for (const [name, entry] of Object.entries(config.searchProviders as Record<string, any>)) {
          if (name.startsWith('$') || !entry || typeof entry !== 'object') continue;
          const apiKeyField = entry.tavilyApiKey !== undefined ? 'tavilyApiKey'
            : entry.serpapiApiKey !== undefined ? 'serpapiApiKey'
            : entry.braveApiKey !== undefined ? 'braveApiKey' : null;
          if (apiKeyField && entry[apiKeyField]) {
            const key = configService.getCredential(`searchpool:${name}`);
            entry[apiKeyField] = key ? '••••••••' : '';
          }
        }
      }
      res.json({ config });
    } catch (err: any) {
      res.status(500).json({ error: `读取全局配置失败: ${err.message}` });
    }
  });

  /** GET /api/config/pools —— 获取模型管理 / 搜索引擎 */
  router.get('/pools', (_req: Request, res: Response) => {
    try {
      const global = configService.getGlobalConfig();
      // 过滤 $ 前缀的注释键
      const filterDollar = (obj: Record<string, unknown>) => {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (!k.startsWith('$')) result[k] = v;
        }
        return result;
      };
      res.json({
        llmProviders: filterDollar(global.llmProviders as unknown as Record<string, unknown>),
        searchProviders: filterDollar(global.searchProviders as unknown as Record<string, unknown>),
      });
    } catch (err: any) {
      res.status(500).json({ error: `读取池配置失败: ${err.message}` });
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
        const credId = llm.$ref ? `pool:${llm.$ref}` : llm.provider as string;
        configService.setCredential(credId, (llm.api_key as string) || '');
      }
      if (llm) delete llm.api_key; // 不写入 config.json

      // 提取 llmProviders 池条目的 api_key
      const llmPools = config.llmProviders as Record<string, Record<string, unknown>> | undefined;
      if (llmPools) {
        for (const [name, entry] of Object.entries(llmPools)) {
          if (name.startsWith('$') || !entry) continue;
          if (entry.api_key !== undefined && entry.api_key !== '••••••••') {
            configService.setCredential(`pool:${name}`, (entry.api_key as string) || '');
          }
          delete entry.api_key;
        }
      }

      // 提取 searchProviders 池条目的 apiKey
      const searchPools = config.searchProviders as Record<string, Record<string, unknown>> | undefined;
      if (searchPools) {
        for (const [name, entry] of Object.entries(searchPools)) {
          if (name.startsWith('$') || !entry) continue;
          const apiKeyField = entry.tavilyApiKey !== undefined ? 'tavilyApiKey'
            : entry.serpapiApiKey !== undefined ? 'serpapiApiKey'
            : entry.braveApiKey !== undefined ? 'braveApiKey' : null;
          if (apiKeyField && entry[apiKeyField] !== undefined && entry[apiKeyField] !== '••••••••') {
            configService.setCredential(`searchpool:${name}`, (entry[apiKeyField] as string) || '');
          }
          if (apiKeyField) delete entry[apiKeyField];
        }
      }

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
      configService.reloadGlobalConfig();

      // 新架构：registry 只存配置、LLM 每次投递按需解析（无实例可热重载）——
      // 配置/凭据保存后下次 Agent 运行时自动生效，无需 reloadAllLLMs
      logger.info(`[Config API] 全局配置已保存并热重载（Agent 下次运行时自动生效）`);
      res.json({ success: true, message: '全局配置已保存' });
    } catch (err: any) {
      res.status(500).json({ error: `保存全局配置失败: ${err.message}` });
    }
  });

  return router;
}
