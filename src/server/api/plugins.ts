// ============================================================
// Plugins API —— GET /api/plugins, GET /api/plugins/:agentId
// ============================================================

import { Router, Request, Response } from 'express';
import { createLogger } from '@core/logger';
const logger = createLogger('[server:plugins]');
import { configService } from '@services/config-service';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 插件管理所需能力（v0.5.0 收敛：webui 只 import services）。
 * 由 src/app/plugin-loader 的 PluginLoader 实现，经服务注册表注入。
 */
export interface PluginManager {
  getAllPlugins(): Array<Record<string, unknown>>;
  getConfigSchemas(): Record<string, unknown>;
  getLLMSchemas(): Record<string, unknown>;
  getSearchSchemas(): Record<string, unknown>;
  getAgentPlugins(agentId: string): Array<Record<string, unknown>>;
}

export function createPluginsRouter(loader: PluginManager): Router {
  const router = Router();

  /** GET /api/plugins —— 获取所有可用插件 */
  router.get('/', (_req: Request, res: Response) => {
    const plugins = loader.getAllPlugins();
    res.json({ plugins });
  });

  /** GET /api/plugins/schemas —— 获取所有插件的配置 Schema（从 config.ts 自动推断） */
  router.get('/schemas', (_req: Request, res: Response) => {
    const schemas = loader.getConfigSchemas();
    res.json(schemas);
  });

  /** GET /api/plugins/llm-schemas —— 获取所有 LLM 提供商的配置 Schema */
  router.get('/llm-schemas', (_req: Request, res: Response) => {
    const schemas = loader.getLLMSchemas();
    res.json(schemas);
  });

  /** GET /api/plugins/search-schemas —— 获取搜索引擎各 provider 的配置 Schema */
  router.get('/search-schemas', (_req: Request, res: Response) => {
    const schemas = loader.getSearchSchemas();
    res.json(schemas);
  });

  /** GET /api/plugins/:agentId —— 获取指定 Agent 的插件列表（含启用状态） */
  router.get('/:agentId', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const plugins = loader.getAgentPlugins(agentId);
    res.json({ agentId, plugins });
  });

  /** POST /api/plugins/:agentId —— 更新 Agent 的插件启用状态 */
  router.post('/:agentId', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const { enabledPlugins } = req.body as { enabledPlugins?: Array<{ name: string; type: string; enabled: boolean }> };

    if (!enabledPlugins || !Array.isArray(enabledPlugins)) {
      res.status(400).json({ error: '缺少 enabledPlugins 字段或格式不正确' });
      return;
    }

    // 查找 Agent 配置文件
    const configPath = path.join(configService.getGlobalConfig().agentsDir, agentId, 'config.json');

    if (!fs.existsSync(configPath)) {
      res.status(404).json({ error: `Agent "${agentId}" 的配置文件不存在` });
      return;
    }

    try {
      // 读取现有配置
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // 新架构：Agent 配置用 plugins 数组声明（工具 + 五类钩子），
      // 按内置插件分组重建：启用的 tool 名 → plugins[].tools；钩子声明保留原状
      const enabledTools = enabledPlugins
        .filter((p) => p.enabled && p.type === 'tool')
        .map((p) => p.name);

      const existingPlugins = Array.isArray(config.plugins) ? config.plugins : [];
      const builtin = existingPlugins.find((p: any) => p.name === 'builtin') ?? { name: 'builtin', tools: [] };
      builtin.tools = enabledTools;
      config.plugins = existingPlugins.length > 0
        ? existingPlugins.map((p: any) => (p.name === 'builtin' ? builtin : p))
        : [builtin];

      // 写回配置文件
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

      logger.info(`[Plugins API] Agent "${agentId}" 插件已更新: ${enabledTools.length} tools`);

      res.json({
        success: true,
        agentId,
        plugins: config.plugins,
      });
    } catch (err: any) {
      res.status(500).json({ error: `更新配置失败: ${err.message}` });
    }
  });

  return router;
}
