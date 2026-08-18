// ============================================================
// @agentchat/plugins/src/market/github.ts —— GitHub topic 发现适配器
//
// 发现：search/repositories?q=topic:agentchat（topic 无门槛 = 只是提示，
// 信任来自 staging 审查 + 权限授予 + commit 钉定，不来自 topic）。
// 解析：commits/{ref} 取 commit SHA 钉定 → raw/{commit}/manifest.json
//       拉清单（manifest 与 tarball 锚定同一个 commit）。
//
// 限流现实：匿名 10 搜索/分钟、核心 60/小时；支持 AGENTCHAT_GITHUB_TOKEN
// 提升配额。所有请求带超时；失败上抛（调用方降级到本地缓存索引）。
// ============================================================
import { validatePluginManifest, type PluginManifest } from '@agentchat/agent-config';
import type { MarketEntry, MarketSource, ResolvedEntry } from './source';

export interface GitHubSourceOptions {
  /** API 基址（测试注入用；缺省 https://api.github.com） */
  apiBase?: string;
  /** raw 基址（测试注入用；缺省 https://raw.githubusercontent.com） */
  rawBase?: string;
  /** 认证 token（缺省读 AGENTCHAT_GITHUB_TOKEN） */
  token?: string;
  /** 搜索每页条数（缺省 30） */
  perPage?: number;
  /** 发现 topic（缺省 agentchat） */
  topic?: string;
  /** 请求超时毫秒（缺省 15000） */
  timeoutMs?: number;
}

/** GitHub search/repositories 条目（只取用到的字段） */
interface GhRepo {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  pushed_at: string;
  default_branch: string;
}

interface GhCommit {
  sha: string;
}

/** fetch 注入（默认 globalThis.fetch；测试替换用） */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class GitHubSource implements MarketSource {
  readonly id = 'github';

  private readonly apiBase: string;
  private readonly rawBase: string;
  private readonly token?: string;
  private readonly perPage: number;
  private readonly topic: string;
  private readonly timeoutMs: number;
  private readonly fetchLike: FetchLike;

  constructor(options: GitHubSourceOptions & { fetch?: FetchLike } = {}) {
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.rawBase = (options.rawBase ?? 'https://raw.githubusercontent.com').replace(/\/+$/, '');
    this.token = options.token ?? process.env.AGENTCHAT_GITHUB_TOKEN;
    this.perPage = options.perPage ?? 30;
    this.topic = options.topic ?? 'agentchat';
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  }

  private async api<T>(url: string): Promise<T> {
    const response = await this.fetchLike(url, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'follow',
    });
    if (!response.ok) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const hint = response.status === 403 || response.status === 429
        ? (remaining === '0' ? '（GitHub 限流；可设置 AGENTCHAT_GITHUB_TOKEN 提升配额）' : '')
        : '';
      throw new Error(`GitHub API ${response.status} ${url}${hint}`);
    }
    return response.json() as Promise<T>;
  }

  async search(query?: string): Promise<MarketEntry[]> {
    // topic 聚合 + 可选关键词；限定非 fork 有 manifest 的仓库不可行（search 不支持），
    // manifest 缺失的仓库在 resolve 阶段被自然过滤。
    const q = query?.trim()
      ? `topic:${this.topic} ${query.trim()}`
      : `topic:${this.topic}`;
    const data = await this.api<{ total_count: number; items: GhRepo[] }>(
      `${this.apiBase}/search/repositories?q=${encodeURIComponent(q)}&sort=updated&per_page=${this.perPage}`,
    );
    return data.items.map((repo) => ({
      // 发现层 name 先用仓库名（可能不合法作插件名）；resolve 拉到 manifest 后被真名覆盖
      name: repo.full_name,
      repo: repo.full_name,
      ref: repo.default_branch,
      description: repo.description ?? undefined,
      stars: repo.stargazers_count,
      updatedAt: repo.pushed_at,
      channel: this.id,
    }));
  }

  async resolve(repo: string, ref?: string): Promise<ResolvedEntry> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error(`仓库坐标非法: "${repo}"（期望 owner/name）`);
    }
    // ① 钉 commit：ref → SHA（ref 可移动，SHA 不可）
    const resolvedRef = ref ?? (await this.api<GhRepo>(`${this.apiBase}/repos/${repo}`)).default_branch;
    const commit = (await this.api<GhCommit>(`${this.apiBase}/repos/${repo}/commits/${encodeURIComponent(resolvedRef)}`)).sha;

    // ② 拉 manifest：锚定 commit（而非 ref），保证 manifest = 将要下载的内容
    let raw: string;
    try {
      raw = await this.fetchRaw(`${this.rawBase}/${repo}/${commit}/manifest.json`);
    } catch (err: any) {
      if (String(err?.message ?? '').includes('404')) {
        throw new Error(`仓库 ${repo}@${commit} 没有 manifest.json（不是 AgentChat 插件包）`);
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`manifest.json 解析失败（${repo}@${commit}）: ${err?.message ?? String(err)}`);
    }
    const check = validatePluginManifest(parsed);
    if (!check.ok) throw new Error(`manifest 非法（${repo}@${commit}）: ${check.errors.join('；')}`);
    const manifest: PluginManifest = check.manifest!;

    return {
      entry: {
        name: manifest.name,
        repo,
        ref: resolvedRef,
        manifest,
        description: manifest.description,
        channel: this.id,
      },
      commit,
      tarball: `${this.apiBase}/repos/${repo}/tarball/${commit}`,
    };
  }

  async download(url: string): Promise<Buffer> {
    // 只下载本通道 API 域下的地址（防止 manifest/条目里塞内网 URL 当 SSRF 跳板）
    if (!url.startsWith(`${this.apiBase}/`)) {
      throw new Error(`tarball 地址不在源 ${this.id} 的 API 域内: ${url}`);
    }
    const response = await this.fetchLike(url, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`下载 tarball 失败：${response.status} ${url}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agentchat-market',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async fetchRaw(url: string): Promise<string> {
    const headers: Record<string, string> = { 'User-Agent': 'agentchat-market' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await this.fetchLike(url, {
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'follow',
    });
    if (response.status === 404) throw new Error(`目标不存在（404）: ${url}`);
    if (!response.ok) throw new Error(`拉取失败 ${response.status}: ${url}`);
    return response.text();
  }
}
