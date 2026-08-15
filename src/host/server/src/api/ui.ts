// ============================================================
// UI API —— /api/ui/* + /ui-plugin/:name/* 静态资源守卫（P5 深度 UI 扩展）
//
// · GET /api/ui/extensions —— 当前全部 UI 扩展清单（读 ctx.webui）
// · GET /api/ui/slots       —— slot 目录 v1（可发现性）
// · /ui-plugin/:name/*      —— 插件 UI 产物静态托管（白名单类型 + 路径守卫）
//
// 安全边界（docs/ui-web-pluginization-plan.md §7.9）：
//   name 必须匹配 ^[a-z0-9-]+$；解析后路径必须落在插件目录内；
//   禁止符号链接逃逸；Content-Type 白名单（js/mjs/css/map/json/svg/png/webp）。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Context } from '@agentchat/cordis';
import type { UIExtensionDescriptor, UISlotInfo } from '@agentchat/protocol';

/** slot 目录 v1（中文标签/描述与 docs §7.8.3 对齐） */
export const UI_SLOT_CATALOG: UISlotInfo[] = [
  { id: 'perspective', label: '顶级视角', description: '主界面顶层视角（如统计工作台、社区流），由 PerspectiveHost 渲染。' },
  { id: 'tool-result', label: '工具结果视图', description: '工具结果富渲染器（match + component + priority），由 useToolResult 分发。' },
  { id: 'message-view', label: '消息视图', description: '消息形态渲染器（按 turn/final 匹配），由 TurnDisplayItem 分发。' },
  { id: 'ws-event', label: 'WS 事件处理', description: 'WebSocket 原始事件处理器，由 eventHandlers.dispatchEvent 分发。' },
  { id: 'settings-tab:global', label: '全局设置页签', description: '全局设置面板的新页签，宿主传入 { globalConfig, nsSchemas, pools }。' },
  { id: 'settings-tab:agent', label: 'Agent 设置页签', description: 'Agent 设置面板的新页签，宿主传入 { agentId, raw, effective, emit }。' },
  { id: 'sidebar-action', label: '侧边栏动作', description: '侧边栏动作按钮（icon/label/onClick），由 Sidebar 渲染。' },
  { id: 'global-style', label: '全局样式注入', description: '注入以插件名为 class 前缀的 scoped CSS / CSS 变量（P5.5）。' },
];

const PLUGIN_NAME_RE = /^[a-z0-9-]+$/;

/** 允许经 /ui-plugin 静态托管下发的扩展名白名单 */
const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** ctx.get('webui') 的结构化最小面（避免 server 包反向依赖 @agentchat/plugins） */
interface WebUILike {
  listExtensions(): UIExtensionDescriptor[];
  getEntryDir(name: string): string | null;
}

function getWebUI(ctx: Context | undefined): WebUILike | undefined {
  if (!ctx) return undefined;
  return ctx.get('webui') as WebUILike | undefined;
}

/** 创建 /api/ui 路由（挂载于 WebUIServer；ctx 未提供或 webui 不存在时 extensions 为空） */
export function createUiRouter(ctx?: Context): Router {
  const router = Router();

  router.get('/extensions', (_req: Request, res: Response) => {
    const webui = getWebUI(ctx);
    res.json({ extensions: webui?.listExtensions() ?? [] });
  });

  router.get('/slots', (_req: Request, res: Response) => {
    res.json({ slots: UI_SLOT_CATALOG });
  });

  return router;
}

/**
 * 创建 /ui-plugin 静态托管中间件（挂载在 SPA fallback 之前）。
 * 请求路径形如 /ui-plugin/<name>/<rel...>。
 */
export function createUiPluginStaticHandler(ctx?: Context) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const webui = getWebUI(ctx);

    // 使用 originalUrl 解析完整路径（app.use('/ui-plugin', ...) 下 req.url 可能已被剥前缀）
    let rawPath = req.originalUrl ?? req.url ?? '';
    const queryIdx = rawPath.indexOf('?');
    if (queryIdx >= 0) rawPath = rawPath.slice(0, queryIdx);

    const prefix = '/ui-plugin';
    let rest = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath;
    if (!rest.startsWith('/')) rest = `/${rest}`;

    let decoded = rest;
    try {
      decoded = decodeURIComponent(rest);
    } catch {
      // 保留原始串；后续 path.resolve + startsWith 守卫仍会兜底
    }

    const parts = decoded.split('/').filter((seg) => seg !== '');
    if (parts.length < 2) {
      res.status(404).json({ error: 'UI 插件资源不存在' });
      return;
    }
    const [name, ...fileSegs] = parts;
    if (!PLUGIN_NAME_RE.test(name)) {
      res.status(403).json({ error: `UI 插件名非法: ${name}` });
      return;
    }
    const rel = fileSegs.join('/');
    if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '')) {
      res.status(403).json({ error: `UI 插件资源路径非法: ${rel}` });
      return;
    }

    const dir = webui?.getEntryDir(name);
    if (!dir) {
      res.status(404).json({ error: `UI 插件 "${name}" 未注册` });
      return;
    }

    const full = path.resolve(dir, rel);
    const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
    if (!full.startsWith(dirWithSep)) {
      res.status(403).json({ error: `UI 插件资源路径逃逸: ${rel}` });
      return;
    }

    // 符号链接逃逸守卫：realpath 后仍必须在插件目录内
    try {
      const realRoot = fs.realpathSync(dir);
      const realFull = fs.realpathSync(full);
      const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
      if (!realFull.startsWith(realRootWithSep)) {
        res.status(403).json({ error: `UI 插件资源路径逃逸（符号链接）: ${rel}` });
        return;
      }
    } catch {
      res.status(404).json({ error: `UI 插件资源不存在: ${rel}` });
      return;
    }

    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.status(404).json({ error: `UI 插件资源不存在: ${rel}` });
      return;
    }

    const contentType = CONTENT_TYPES[path.extname(full).toLowerCase()];
    if (!contentType) {
      res.status(403).json({ error: `UI 插件资源类型不允许: ${path.extname(full) || '(无扩展名)'}` });
      return;
    }

    res.type(contentType);
    res.sendFile(full, (err) => {
      if (err && !res.headersSent) next(err);
    });
  };
}
