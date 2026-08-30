// ============================================================
// ac-plugin-market/src/index.ts —— 插件市场行（M24 P5 / X3 首期复活）
//
// M13/M15/M23 显式缩水项复活（src 轨道同名能力参考）：
//   · 源：npm registry 搜索（keywords:agentchat-plugin 限定）+ github
//     topic 定位（topic:agentchat-plugin）——src 轨同款 **opt-in 发现
//     门槛**（作者自标 keyword/topic 才可被发现；无门槛的全文检索与
//     topic:agentchat 都是干扰项来源，X3 首期踩坑修正）；
//   · 安装流 = **暂存人审**（复用 M23 staging 全套：只读文件代理/内容
//     哈希/权限快照/来源锚定 repo·ref·commit）——第三方供应链维持人审
//     （M23 B2 裁决），与 Agent 自开发免审流（install_plugin）分立；
//   · 落位：market/stage → 暂存 → 「目录 · 插件 · 本地」组待审徽章 +
//     审查弹窗（M23 组件复用）→ 人审批准 → 安装装载。
//
// RPC（注册即归属，随本行下线）：
//   · market/search {query} → {results}（npm + github 两源元数据）
//   · market/stage {spec, owner?} → 下载解包 → manifest 校验 →
//     ctx.pluginRegistry.stage（来源锚定 PluginSource）→ 待审
//
// 缩水（M24 §四.2）：评分/评论/依赖解析/版本升级与自动更新不做。
// fetcher 注入口 = 测试零网络（对齐 ac-mcp clientFactory 先例）。
// ============================================================
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import type { PluginSource } from 'ac-plugin-core';
import { extractTarGz } from './tarball.ts';

/** 市场搜索结果条目 */
export interface MarketResult {
  source: 'npm' | 'github';
  /** npm 包名 / github repo 全名（owner/repo） */
  name: string;
  version?: string;
  description?: string;
  /** npm 周下载量 */
  downloads?: number;
  /** github 星数 */
  stars?: number;
  url?: string;
  /** 可直接安装的定位串（npm:<name>@<version> / github:<owner/repo>#<ref>） */
  spec: string;
}

export interface MarketRowOptions {
  /** npm registry 基址（缺省 https://registry.npmjs.org；测试注入） */
  npmRegistry?: string;
  /** github api 基址（缺省 https://api.github.com；测试注入） */
  githubApi?: string;
  /** fetch 实现注入（测试零网络） */
  fetchImpl?: typeof fetch;
  /** 搜索结果上限（每源；缺省 10） */
  limit?: number;
}

type Fetch = typeof fetch;

export const name = 'ac-plugin-market';

export const inject = ['webServer', 'pluginRegistry'];

export function apply(ctx: Context, options: MarketRowOptions = {}) {
  const doFetch: Fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const npmRegistry = (options.npmRegistry ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
  const githubApi = (options.githubApi ?? 'https://api.github.com').replace(/\/+$/, '');
  const limit = options.limit ?? 10;

  async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    const res = await doFetch(url, { headers: { accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return (await res.json()) as T;
  }

  async function fetchBuffer(url: string): Promise<Buffer> {
    const res = await doFetch(url, { headers: { accept: 'application/octet-stream' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }

  function githubHeaders(): Record<string, string> {
    const token = process.env.AGENTCHAT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  const web = ctx.webServer;

  // ---- market/search：npm registry 搜索 + github topic 定位 ----
  web.registerRpc('market/search', async (params) => {
    const p = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
    const query = typeof p.query === 'string' ? p.query.trim() : '';
    const results: MarketResult[] = [];

    // npm：registry 搜索端点 keywords 限定（opt-in 门槛 = 插件作者自标
    // keywords "agentchat-plugin"；全文检索按相关度捞任何提到 agentchat
    // 的包——干扰项来源，弃用）
    try {
      const text = encodeURIComponent(query ? `keywords:agentchat-plugin ${query}` : 'keywords:agentchat-plugin');
      const data = await fetchJson<{
        objects?: Array<{
          package: { name: string; version?: string; description?: string; links?: { repository?: string; npm?: string } };
        }>;
      }>(`${npmRegistry}/-/v1/search?text=${text}&size=${limit}`);
      const names = (data.objects ?? []).map((o) => o.package.name);
      // 周下载量批量补全（失败容忍——结果照常返回）
      let downloads: Record<string, number> = {};
      if (names.length > 0) {
        try {
          const dl = await doFetch('https://api.npmjs.org/downloads/point/last-week/bulk', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(names),
          });
          if (dl.ok) {
            const rows = (await dl.json()) as Record<string, { downloads?: number }>;
            downloads = Object.fromEntries(
              Object.entries(rows).map(([k, v]) => [k, v.downloads ?? 0]),
            );
          }
        } catch {
          /* 下载量是装饰性数据——失败静默 */
        }
      }
      for (const o of data.objects ?? []) {
        results.push({
          source: 'npm',
          name: o.package.name,
          ...(o.package.version ? { version: o.package.version } : {}),
          ...(o.package.description ? { description: o.package.description } : {}),
          ...(downloads[o.package.name] !== undefined ? { downloads: downloads[o.package.name] } : {}),
          url: o.package.links?.npm ?? `https://www.npmjs.com/package/${o.package.name}`,
          spec: `npm:${o.package.name}${o.package.version ? `@${o.package.version}` : ''}`,
        });
      }
    } catch (err: unknown) {
      ctx.logger.warn('[market] npm 搜索失败: %C', err instanceof Error ? err.message : String(err));
    }

    // github：topic 检索（topic:agentchat-plugin——src 轨 market/github.ts
    // 同款约定：仓库显式挂 topic 才可被发现；topic 只是发现提示不承载信任，
    // 信任来自 staging 人审 + 权限授予 + commit 钉定）
    try {
      const q = encodeURIComponent(`topic:agentchat-plugin${query ? ` ${query} in:name,description` : ''}`);
      const data = await fetchJson<{
        total_count?: number;
        items?: Array<{ full_name: string; description?: string; stargazers_count?: number; html_url?: string; default_branch?: string }>;
      }>(`${githubApi}/search/repositories?q=${q}&per_page=${limit}`, githubHeaders());
      for (const item of data.items ?? []) {
        results.push({
          source: 'github',
          name: item.full_name,
          description: item.description ?? undefined,
          ...(typeof item.stargazers_count === 'number' ? { stars: item.stargazers_count } : {}),
          ...(item.html_url ? { url: item.html_url } : {}),
          spec: `github:${item.full_name}${item.default_branch ? `#${item.default_branch}` : ''}`,
        });
      }
    } catch (err: unknown) {
      ctx.logger.warn('[market] github 搜索失败: %C', err instanceof Error ? err.message : String(err));
    }

    return { results };
  });

  // ---- market/stage：下载解包 → manifest 校验 → 暂存（人审入口） ----
  web.registerRpc('market/stage', async (params) => {
    const p = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
    const spec = typeof p.spec === 'string' ? p.spec.trim() : '';
    const owner = typeof p.owner === 'string' && p.owner.trim() ? p.owner.trim() : 'user';
    if (!spec) throw new Error('参数 spec 缺失（npm:<name>[@<version>] 或 github:<owner/repo>[#<ref>]）');

    let stagedFrom: string; // 下载源目录
    let source: PluginSource;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-market-'));
    try {
      if (spec.startsWith('npm:')) {
        const id = spec.slice('npm:'.length);
        const at = id.lastIndexOf('@');
        const pkgName = at > 0 ? id.slice(0, at) : id;
        const version = at > 0 ? id.slice(at + 1) : undefined;
        if (!pkgName) throw new Error('npm spec 缺少包名');
        // 版本解析：registry 元数据（dist.tarball + 最新版本缺省）
        type NpmDoc = {
          'dist-tags'?: Record<string, string>;
          versions?: Record<string, { dist?: { tarball?: string } }>;
        };
        const doc = await fetchJson<NpmDoc>(`${npmRegistry}/${encodeURIComponent(pkgName).replace('%40', '@')}`);
        const resolved = version ?? doc['dist-tags']?.latest ?? Object.keys(doc.versions ?? {}).pop();
        const tarball = resolved ? doc.versions?.[resolved]?.dist?.tarball : undefined;
        if (!tarball || !resolved) throw new Error(`npm 包 "${pkgName}" 无可安装版本`);
        const gz = await fetchBuffer(tarball);
        const files = extractTarGz(gz, tmp, 1);
        if (files === 0) throw new Error(`npm 包 "${pkgName}@${resolved}" 解包后无文件`);
        stagedFrom = tmp;
        source = { kind: 'tarball', spec: `npm:${pkgName}@${resolved}` };
      } else if (spec.startsWith('github:')) {
        const locator = spec.slice('github:'.length);
        const hash = locator.indexOf('#');
        const repo = (hash > 0 ? locator.slice(0, hash) : locator).trim();
        const ref = hash > 0 ? locator.slice(hash + 1).trim() : undefined;
        if (!repo || !repo.includes('/')) throw new Error('github spec 须为 github:<owner/repo>[#<ref>]');
        // 解析 ref → commit（来源锚定 repo·ref·commit）
        const repoMeta = await fetchJson<{ default_branch?: string }>(
          `${githubApi}/repos/${repo}`,
          githubHeaders(),
        );
        const branch = ref ?? repoMeta.default_branch ?? 'HEAD';
        const commitMeta = await fetchJson<{ sha?: string }>(
          `${githubApi}/repos/${repo}/commits/${encodeURIComponent(branch)}`,
          githubHeaders(),
        );
        const gz = await fetchBuffer(`https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(branch)}`);
        const files = extractTarGz(gz, tmp, 1);
        if (files === 0) throw new Error(`github 仓库 ${repo}#${branch} 解包后无文件`);
        stagedFrom = tmp;
        source = {
          kind: 'github',
          repo,
          ...(ref ? { ref } : {}),
          ...(commitMeta.sha ? { commit: commitMeta.sha } : {}),
          spec: `github:${repo}#${branch}`,
        };
      } else {
        throw new Error(`无法识别的 spec "${spec}"（前缀 npm: / github:）`);
      }

      // manifest 在场校验（stage 内部再全量校验——此处先给可诊断错误）
      if (!fs.existsSync(path.join(stagedFrom, 'manifest.json'))) {
        throw new Error('来源包缺少 manifest.json（非 AgentChat 插件——市场只收 manifest 插件包）');
      }
      // 暂存（人审入口）：复用 M23 staging 全套（哈希/只读代理/权限快照/来源锚定）
      const staging = await ctx.pluginRegistry.stage(stagedFrom, owner, source);
      return { staging, source };
    } finally {
      // 暂存复制完成后清理下载临时目录（失败路径同样清理）
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* Windows 占用瞬时失败 → 留给 OS 临时目录清理 */
      }
    }
  });
}
