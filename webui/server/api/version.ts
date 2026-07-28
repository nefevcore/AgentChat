// ============================================================
// 版本 API —— GET /api/version, GET /api/version/changelog, POST /api/version/update
// ============================================================

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = process.cwd();

function getCurrentVersion(): string {
  try {
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const GITHUB_REPO = 'nefevcore/AgentChat';

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

  /** GET /api/version —— 当前版本 + 最新 release 信息
   *  ?simulate=true — 模拟有新版本，用于测试更新流程 */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const current = getCurrentVersion();
      const simulate = req.query.simulate === 'true';

      let latest = simulate ? null : await fetchLatestRelease();
      let hasUpdate = false;

      if (simulate) {
        // 虚构一个更高版本
        const [major, minor, patch] = current.split('.').map(Number);
        latest = {
          version: `${major}.${minor}.${(patch || 0) + 1}`,
          url: `https://github.com/${GITHUB_REPO}/releases/latest`,
          publishedAt: new Date().toISOString(),
        };
        hasUpdate = true;
        // 清除真实缓存，下次不带 ?simulate 时重新获取
        cachedLatest = null;
        cacheTime = 0;
      } else if (latest) {
        hasUpdate = compareVersion(latest.version, current) > 0;
      }

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

  /** GET /api/version/changelog */
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

  /** POST /api/version/update —— 自动 git pull + 构建 + 重启 */
  router.post('/update', (_req: Request, res: Response) => {
    const steps: string[] = [];
    try {
      // 1. git pull（先 stash 本地改动，pull 后再 pop）
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000 }).trim();
      const hasChanges = execSync('git status --porcelain', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
      let stashed = false;
      if (hasChanges) {
        execSync('git stash push -m "agentchat-auto-update"', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 10000 });
        stashed = true;
        steps.push('git stash: 已暂存本地改动');
      }
      const pullResult = execSync(`git pull origin ${branch}`, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 30000 });
      steps.push(`git pull: ${pullResult.trim().split('\n').pop() || 'Already up to date.'}`);
      if (stashed) {
        try {
          execSync('git stash pop', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 10000 });
          steps.push('git stash pop: 已恢复本地改动');
        } catch {
          steps.push('git stash pop: 有冲突，请手动处理 git stash');
        }
      }

      // 2. npm install
      const installResult = execSync('npm install --no-audit --no-fund', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000 });
      steps.push(`npm install: ${installResult.trim().split('\n').pop() || 'done'}`);

      // 3. 构建（非 fatal — tsc 可能有既有 warning，tsx 不需要 dist/）
      try {
        const buildResult = execSync('npm run build', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 120000 });
        steps.push(`npm run build: ${buildResult.trim().split('\n').pop() || 'done'}`);
      } catch (buildErr: any) {
        steps.push(`npm run build: 跳过 (${buildErr.stderr ? String(buildErr.stderr).trim().split('\n').pop() : 'non-fatal'})`);
      }

      const isNodemon = process.env.npm_lifecycle_event?.includes('watch')
        || process.argv.some(a => a.includes('nodemon'));

      if (isNodemon) {
        res.json({ status: 'success', steps, message: '更新完成，即将重启...' });
        setTimeout(() => {
          console.log('[version] 自动更新完成，nodemon 触发重启...');
          process.exit(0);
        }, 500);
      } else {
        steps.push('提示: 后端未在 nodemon 下运行，请手动重启后端进程使新代码生效');
        res.json({ status: 'success', steps, message: '更新完成。请手动重启后端 (Ctrl+C 后重新启动)' });
      }
    } catch (err: any) {
      const msg = err.stderr || err.stdout || err.message || String(err);
      const detail = msg.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
      steps.push(`失败: ${detail}`);
      res.json({ status: 'error', steps, message: `更新失败: ${detail}` });
    }
  });

  return router;
}
