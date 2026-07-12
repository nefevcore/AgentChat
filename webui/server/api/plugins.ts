// ============================================================
// Plugins API —— GET /api/plugins, GET /api/plugins/:agentId
// ============================================================

import { Router, Request, Response } from 'express';
import { AgentLoader } from '@discovery/agent-loader';
import { getGlobalConfig } from '@core/config';
import * as fs from 'fs';
import * as path from 'path';

export function createPluginsRouter(loader: AgentLoader): Router {
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
    const configPath = path.join(getGlobalConfig().agentsDir, agentId, 'config.json');

    if (!fs.existsSync(configPath)) {
      res.status(404).json({ error: `Agent "${agentId}" 的配置文件不存在` });
      return;
    }

    try {
      // 读取现有配置
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // 根据传入的插件状态更新 tools / pre_hooks / post_hooks
      const tools: string[] = [];
      const preHooks: string[] = [];
      const postHooks: string[] = [];

      for (const p of enabledPlugins) {
        if (!p.enabled) continue;
        switch (p.type) {
          case 'tool':
            tools.push(p.name);
            break;
          case 'pre_hook':
            preHooks.push(p.name);
            break;
          case 'post_hook':
            postHooks.push(p.name);
            break;
        }
      }

      config.tools = tools;
      config.pre_hooks = preHooks;
      config.post_hooks = postHooks;

      // 写回配置文件
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

      console.log(`[Plugins API] Agent "${agentId}" 插件已更新: ${tools.length} tools, ${preHooks.length} pre-hooks, ${postHooks.length} post-hooks`);

      res.json({
        success: true,
        agentId,
        tools,
        pre_hooks: preHooks,
        post_hooks: postHooks,
      });
    } catch (err: any) {
      res.status(500).json({ error: `更新配置失败: ${err.message}` });
    }
  });

  return router;
}
