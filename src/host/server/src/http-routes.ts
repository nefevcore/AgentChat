// ============================================================
// @agentchat/server/src/http-routes.ts —— HTTP 路由注册表（L3 传输层插件化）
//
// 宿主（WebUIServer）只挂中间件/WS/SPA fallback + 本注册表；
// 各域插件在自己的 apply 里 ctx.http.register('/api/xxx', router)，
// 挂/摘插件行 = 挂/摘对应路由。
//
// 实现要点：注册表暴露一个稳定的中间件（mount 到 Express 后不换引用），
// 内部按注册顺序重建 current Router；register 返回 disposer，
// 插件卸载（含 HMR 失败回滚）后旧路由被准确摘除，不会残留旧 handler。
// ============================================================
import express, { Router } from 'express';
import type { RequestHandler } from 'express';
import { Service, type Context } from '@agentchat/cordis';

export type HttpRouteHandler = RequestHandler | Router;

interface RouteEntry {
  path: string;
  handler: HttpRouteHandler;
}

/** 路由注册信息（诊断/测试用） */
export interface HttpRouteInfo {
  path: string;
  /** 注册先后序号（1-based；重建不影响序号） */
  order: number;
}

export class HttpRouteRegistry extends Service {
  private entries: RouteEntry[] = [];
  private current = express.Router();

  /** 稳定中间件：WebUIServer 构造时 mount 一次，后续重建 router 不需要重新 mount */
  readonly middleware: RequestHandler = (req, res, next) => {
    this.current(req, res, next);
  };

  constructor(ctx: Context) {
    super(ctx, 'http');
  }

  /** 注册路径（如 /api/agents）。同路径允许多个插件分段挂载，顺序 = 注册顺序。 */
  register(path: string, handler: HttpRouteHandler): () => void {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const entry: RouteEntry = { path: normalized, handler };
    this.entries.push(entry);
    this.rebuild();
    return () => {
      const idx = this.entries.indexOf(entry);
      if (idx >= 0) {
        this.entries.splice(idx, 1);
        this.rebuild();
      }
    };
  }

  /** 静态资源/中间件注册（与 register 同语义，命名对齐目标形态） */
  registerStatic(path: string, handler: HttpRouteHandler): () => void {
    return this.register(path, handler);
  }

  /** 当前注册路径（诊断/验收：挂/摘插件行即挂/摘路由） */
  list(): HttpRouteInfo[] {
    return this.entries.map((entry, index) => ({ path: entry.path, order: index + 1 }));
  }

  has(path: string): boolean {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return this.entries.some((entry) => entry.path === normalized);
  }

  private rebuild(): void {
    const router = express.Router();
    for (const entry of this.entries) {
      router.use(entry.path, entry.handler);
    }
    this.current = router;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** HTTP 路由注册表（@agentchat/server/src/http-plugin 提供；WebUIServer mount） */
    http: HttpRouteRegistry;
  }
}
