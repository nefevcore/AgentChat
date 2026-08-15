// ============================================================
// Plugins API —— /api/plugins/*（P1：UI/Web 插件化后端契约）
//
// 子路由拆分（docs/ui-web-pluginization-plan.md §3.5）：
//   · catalog.ts   —— /catalog、/permissions、/global/*
//   · assembly.ts  —— /assembly/:agentId（新装配视图 + PUT 热重载）
//   · library.ts   —— /library/*、/session/*、/staging/:id/*
// 本文件保留兼容端点（旧扁平数组等一个版本周期，UI 迁移后 deprecated）。
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import { createLogger } from '@agentchat/util';
import type {
  AssemblyUpdate,
  AssemblyView,
  PluginCatalog,
  PluginInfo,
  PluginLibrary,
  PluginPermissionsView,
  StagingFileContent,
  StagingFileInfo,
  StagingRecord,
} from '@agentchat/protocol';
import { createCatalogRouter } from './plugins/catalog';
import { createAssemblyRouter } from './plugins/assembly';
import { createLibraryRouter } from './plugins/library';
import { toPluginApiError } from './plugins-shared';

const logger = createLogger('[server:plugins]');

/**
 * 插件管理所需能力（P1 契约）。
 * 由 boot 的 makePluginManager 实现，经服务注册表注入。
 */
export interface PluginManager {
  // ---- 兼容期旧端点（P2 UI 迁移完成后 deprecated）----
  getAllPlugins(): Array<Record<string, unknown>>;
  getConfigSchemas(): Record<string, unknown>;
  getLLMSchemas(): Record<string, unknown>;
  getSearchSchemas(): Record<string, unknown>;
  getAgentPlugins(agentId: string): Array<Record<string, unknown>>;
  getAgentTools(agentId: string): {
    catalog: Array<Record<string, unknown>>;
    enabled: string[];
    explicit: string[];
  };
  getGlobalPlugins(): Array<Record<string, unknown>>;
  getGlobalTools(): {
    catalog: Array<Record<string, unknown>>;
    explicit: string[];
  };

  // ---- ① Agent 装配视图 ----
  getAssembly(agentId: string): AssemblyView | null;
  saveAssembly(agentId: string, patch: AssemblyUpdate): {
    success: true;
    assembly: AssemblyView;
    migrated?: boolean;
  };

  // ---- ② 插件目录 ----
  getCatalog(): PluginCatalog;

  // ---- ③ 插件库生命周期 ----
  getLibrary(): PluginLibrary;
  stagePlugin(dir: string, owner: string): StagingRecord;
  approvePlugin(id: string, grants?: unknown): Promise<PluginInfo>;
  rejectPlugin(id: string): { success: true };
  uninstallPlugin(name: string): Promise<{ success: true; backupDir?: string }>;

  // ---- ④ 会话插件（开发态）----
  getSessionPlugins(): PluginInfo[];
  reloadSessionPlugin(name: string): Promise<{ status: 'loaded' | 'replaced' }>;
  unloadSessionPlugin(name: string): Promise<{ success: true }>;
  registerSessionPlugin(
    dir: string,
    owner?: string,
    grants?: unknown,
    watch?: boolean,
  ): Promise<{ status: 'loaded' | 'replaced'; plugin: PluginInfo }>;

  // ---- ⑤ 权限词汇表 ----
  getPermissions(): PluginPermissionsView;

  // ---- ⑥ 暂存代码查看（人审必需）----
  getStagingTree(id: string): { files: StagingFileInfo[] };
  getStagingFile(id: string, rel: string): StagingFileContent;
}

/** Express 路由统一 catch 出口 */
export function sendPluginError(res: Response, err: unknown): void {
  const apiErr = toPluginApiError(err);
  if (apiErr.status >= 500) {
    logger.error(`[Plugins API] ${apiErr.message}`);
  }
  res.status(apiErr.status).json({ error: apiErr.message });
}

export function createPluginsRouter(loader: PluginManager): Router {
  const router = Router();

  // P1 新契约子路由（静态路径优先，避免被 /:agentId 捕获）
  router.use('/assembly', createAssemblyRouter(loader));
  router.use(createLibraryRouter(loader));
  router.use(createCatalogRouter(loader));

  // ---- 兼容期旧端点（一个版本周期）----

  /** GET /api/plugins —— 获取所有可用插件 */
  router.get('/', (_req: Request, res: Response) => {
    const plugins = loader.getAllPlugins();
    res.json({ plugins });
  });

  /** GET /api/plugins/schemas —— 获取所有插件的配置 Schema */
  router.get('/schemas', (_req: Request, res: Response) => {
    const schemas = loader.getConfigSchemas();
    res.json(schemas);
  });

  /** GET /api/plugins/llm-schemas —— LLM 提供商配置 Schema */
  router.get('/llm-schemas', (_req: Request, res: Response) => {
    const schemas = loader.getLLMSchemas();
    res.json(schemas);
  });

  /** GET /api/plugins/search-schemas —— 搜索引擎配置 Schema */
  router.get('/search-schemas', (_req: Request, res: Response) => {
    const schemas = loader.getSearchSchemas();
    res.json(schemas);
  });

  /** GET /api/plugins/tools/:agentId —— 工具清单（全部目录 + 实际启用） */
  router.get('/tools/:agentId', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const tools = loader.getAgentTools(agentId);
    res.json({ agentId, ...tools });
  });

  /** GET /api/plugins/:agentId —— 旧扁平数组（deprecated；新 UI 用 /assembly/:agentId） */
  router.get('/:agentId', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const plugins = loader.getAgentPlugins(agentId);
    res.json({ agentId, plugins });
  });

  /**
   * POST /api/plugins/:agentId —— 旧 UI 钩子启用状态（deprecated）。
   * P1 起改走 saveAssembly 的 hooks 归一化路径：热重载 + 事件广播立即生效。
   */
  router.post('/:agentId', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const { enabledPlugins } = req.body as { enabledPlugins?: Array<{ name: string; type: string; enabled: boolean }> };

    if (!enabledPlugins || !Array.isArray(enabledPlugins)) {
      res.status(400).json({ error: '缺少 enabledPlugins 字段或格式不正确' });
      return;
    }

    const hookKindMap: Record<string, string> = {
      pre_hook: 'runStart',
      post_hook: 'runEnd',
    };

    try {
      const patchHooks: Record<string, string[]> = {};
      for (const p of enabledPlugins) {
        const kind = hookKindMap[p.type];
        if (!kind || !p.enabled) continue;
        (patchHooks[kind] ??= []).push(p.name);
      }
      const saved = loader.saveAssembly(agentId, {
        hooks: { runStart: patchHooks.runStart ?? [], runEnd: patchHooks.runEnd ?? [] },
      });
      res.json({
        success: true,
        agentId,
        hooks: saved.assembly.hooks.order,
      });
    } catch (err) {
      sendPluginError(res, err);
    }
  });

  return router;
}
