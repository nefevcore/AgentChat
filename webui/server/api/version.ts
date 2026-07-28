// ============================================================
// 版本 API —— GET /api/version, GET /api/version/changelog
// ============================================================

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

/** 项目根目录（process.cwd() 在 npm run dev/start 时即为项目根） */
const PROJECT_ROOT = process.cwd();

/** 从 package.json 读取当前版本 */
function getCurrentVersion(): string {
  try {
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** GitHub repo 信息 */
const GITHUB_REPO = 'nefevcore/AgentChat';

/** 从 GitHub API 获取最新 release（缓存 5 分钟） */
let cachedLatest: { version: string; url: string; publishedAt: string } | null = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchLatestRelease(): Promise<{ version: string; url: string; publishedAt: string } | null> {
  const now = Date.now();
  if (cachedLatest && now - cacheTime < CACHE_TTL) return cachedLatest;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'AgentChat' },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = await res.json() as any;
    cachedLatest = {
      version: data.tag_name?.replace(/^v/, '') || '',
      url: data.html_url || '',
      publishedAt: data.published_at || '',
    };
    cacheTime = now;
    return cachedLatest;
  } catch {
    return null;
  }
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export function createVersionRouter(): Router {
  const router = Router();

  /** GET /api/version —— 当前版本 + 最新 release 信息 */
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const current = getCurrentVersion();
      const latest = await fetchLatestRelease();
      const hasUpdate = latest ? compareVersion(latest.version, current) > 0 : false;

      res.json({
        current,
        latest: latest?.version || null,
        hasUpdate,
        latestUrl: latest?.url || null,
        latestPublishedAt: latest?.publishedAt || null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/version/changelog —— 读取 CHANGELOG.md */
  router.get('/changelog', (_req: Request, res: Response) => {
    try {
      const changelogPath = path.join(PROJECT_ROOT, 'CHANGELOG.md');
      if (!fs.existsSync(changelogPath)) {
        res.json({ content: '' });
        return;
      }
      const content = fs.readFileSync(changelogPath, 'utf-8');
      res.json({ content });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
