// ============================================================
// @agentchat/plugins/src/market/market.ts —— ctx.market 服务（市场）
//
// 发现层与安装层的边界：
//   · search  = 各源适配器聚合（topic:agentchat-plugin）+ 本地缓存（离线降级）
//   · stage   = 解析 → 钉 commit → 下载 → 安全解包 → 契约门禁 → 走
//               既有 staging 管（.staging/ 人审 + 授权 + 哈希），
//               市场安装与本地发布共用同一条信任边界
//   · install = stage + approve（grants 必须显式传入；CLI 默认只 stage
//               并打印审查摘要，避免命令行成为权限后门）
//
// 启动路径零网络依赖：本服务构造不请求任何远端，search 仅显式调用。
// 缓存与临时目录都在 <workspace>/plugins/.market/ 下，与 registry 隔离。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Service, type Context } from '@agentchat/cordis';
import {
  HOST_CONTRACTS_VERSION,
  isContractsCompatible,
  type PluginSource,
  type PluginStagingRecord,
} from '@agentchat/agent-config';
import {
  approveStaging,
  loadManifestFromDir,
  pluginsRoot,
  rejectStaging,
  stagePlugin,
  type ApproveResult,
} from '../registry';
import { grantPermissions } from '../permissions';
import type { PluginHost } from '../host';
import { GitHubSource } from './github';
import { extractTarGz } from './tarball';
import { parseMarketSpec, type MarketEntry, type MarketSource } from './source';

/** 市场索引缓存文档（plugins/.market/index.json） */
export interface MarketIndexDoc {
  version: 1;
  updatedAt: string;
  entries: MarketEntry[];
}

export interface MarketOptions {
  /** 工作区目录（缺省：AGENTCHAT_WORKSPACE 或 workspace/default，相对 cwd） */
  workspaceDir?: string;
  /** 源适配器列表（缺省 GitHub topic 源；测试注入 mock 用） */
  sources?: MarketSource[];
  /** 安装 owner 记录（缺省 'market'） */
  owner?: string;
}

export interface MarketSearchResult {
  /** 合并去重后的条目（repo 为键） */
  entries: MarketEntry[];
  /** true = 全部源失败，返回的是本地缓存（离线降级） */
  stale: boolean;
  /** 首个失败原因（stale 时提示用） */
  error?: string;
}

export interface MarketStageOptions {
  /** 覆盖 owner 记录 */
  owner?: string;
}

function resolveWorkspaceDir(explicit?: string): string {
  const ws = explicit ?? process.env.AGENTCHAT_WORKSPACE ?? 'workspace/default';
  return path.isAbsolute(ws) ? ws : path.resolve(process.cwd(), ws);
}

/** 市场缓存目录（<workspace>/plugins/.market） */
function marketRoot(workspaceDir: string): string {
  return path.join(pluginsRoot(workspaceDir), '.market');
}

/** 市场服务：搜索 / 暂存 / 安装。cordis Service，注册为 ctx.market。 */
export class MarketService extends Service {
  private readonly workspaceDir: string;
  private readonly sources: MarketSource[];
  private readonly defaultOwner: string;

  constructor(ctx: Context, options: MarketOptions = {}) {
    super(ctx, 'market');
    this.workspaceDir = resolveWorkspaceDir(options.workspaceDir);
    this.sources = options.sources?.length ? options.sources : [new GitHubSource()];
    this.defaultOwner = options.owner ?? 'market';
  }

  /** 工作区目录（CLI/HTTP 层读 staging/registry 用；只读暴露） */
  get workspaceRootDir(): string {
    return this.workspaceDir;
  }

  // ---- 缓存 ----

  private get cacheFile(): string {
    return path.join(marketRoot(this.workspaceDir), 'index.json');
  }

  private readCache(): MarketEntry[] {
    try {
      const doc = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) as MarketIndexDoc;
      if (doc.version === 1 && Array.isArray(doc.entries)) return doc.entries;
    } catch { /* 无缓存或损坏 = 空 */ }
    return [];
  }

  private writeCache(entries: MarketEntry[]): void {
    const dir = marketRoot(this.workspaceDir);
    fs.mkdirSync(dir, { recursive: true });
    const doc: MarketIndexDoc = { version: 1, updatedAt: new Date().toISOString(), entries };
    fs.writeFileSync(this.cacheFile, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  }

  /** 读取本地缓存索引（不触网） */
  cachedEntries(): MarketEntry[] {
    return this.readCache();
  }

  // ---- 发现 ----

    /**
     * 搜索市场（显式触发，启动路径不调用）。
     * 全部源失败时降级返回本地缓存（stale=true），不抛错——离线也能看清单。
     *
     * 缓存语义（v2，修只增不删的棘轮缺陷）：
     *   · 无关键词（topic 清单刷新）→ 结果成员 = 本轮返回；缓存同部重写
     *     （陈旧成员被淘汰；resolve 阶段富化的 manifest 信息按 repo 保留）。
     *   · 有关键词 → 结果 = 本轮命中，不与缓存合并（否则旧 topic 时代的
     *     缓存残留会污染关键词结果），缓存不动。
     *   · 源全部失败 → 降级返回缓存（stale=true），无论哪种模式。
     */
    async search(query?: string): Promise<MarketSearchResult> {
      const collected: MarketEntry[] = [];
      const errors: string[] = [];
      for (const source of this.sources) {
        try {
          collected.push(...await source.search(query));
        } catch (err: any) {
          errors.push(`[${source.id}] ${err?.message ?? String(err)}`);
        }
      }

      if (collected.length === 0 && errors.length > 0) {
        return { entries: this.readCache(), stale: true, error: errors.join('；') };
      }

      const byStars = (a: MarketEntry, b: MarketEntry) => (b.stars ?? 0) - (a.stars ?? 0);

      // 关键词搜索：只返回本轮命中（不合并缓存）
      if (query?.trim()) {
        return { entries: [...collected].sort(byStars), stale: false, ...(errors.length ? { error: errors.join('；') } : {}) };
      }

      // topic 清单刷新：成员 = 本轮；对仍在册的 repo 保留缓存里的 manifest 富化
      const enriched = new Map<string, MarketEntry>();
      for (const cached of this.readCache()) {
        if (cached.manifest) enriched.set(cached.repo, cached);
      }
      const entries = collected
        .map((entry) => (enriched.has(entry.repo) ? { ...entry, manifest: enriched.get(entry.repo)!.manifest } : entry))
        .sort(byStars);
      this.writeCache(entries);
      return { entries, stale: false, ...(errors.length ? { error: errors.join('；') } : {}) };
  }

  // ---- 安装 ----

  /** 解析说明符：name → 缓存条目；owner/repo[#ref] → 直连 */
  private async resolveSpec(spec: string): Promise<{ source: MarketSource; repo: string; ref?: string }> {
    const parsed = parseMarketSpec(spec);
    if (parsed.repo) {
      const channel = this.sources.find((s) => s.id === 'github') ?? this.sources[0];
      return { source: channel, repo: parsed.repo, ref: parsed.ref };
    }
    // 按名查缓存（须先 search 过；resolve 后的条目带真名）
    const hit = this.readCache().find((e) => e.name === parsed.name && e.repo);
    if (!hit) throw new Error(`市场索引中找不到 "${parsed.name}"（先 search 或用 owner/repo 形式安装）`);
    const channel = this.sources.find((s) => s.id === hit.channel) ?? this.sources[0];
    return { source: channel, repo: hit.repo!, ref: parsed.ref };
  }

  /**
   * 市场 stage：解析 → 钉 commit → 下载 → 安全解包 → 契约门禁 → 既有 staging 管。
   * 返回暂存记录；后续 approve（人审 + 授权）与本地发布完全同路径。
   */
  async stage(spec: string, options: MarketStageOptions = {}): Promise<PluginStagingRecord> {
    const { source, repo, ref } = await this.resolveSpec(spec);
    const resolved = await source.resolve(repo, ref);

    // 契约门禁：不兼容的插件在进入审查前拒绝（省一次人审来回）
    const declared = resolved.entry.manifest?.contracts;
    if (!isContractsCompatible(declared, HOST_CONTRACTS_VERSION)) {
      throw new Error(
        `插件 "${resolved.entry.name}" 声明 contracts "${declared}"，与宿主契约 ${HOST_CONTRACTS_VERSION} 不兼容（找插件作者更新，或等宿主降级兼容）`,
      );
    }

    // 下载 + 解包到临时目录（.market/tmp，strip GitHub tarball 顶层目录）
    const archive = await source.download(resolved.tarball);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-market-'));
    try {
      extractTarGz(archive, tmpDir, { stripComponents: 1 });

      // 解包后的 manifest 是真相源；与 resolve 拉到的（同 commit）必须一致
      const manifest = loadManifestFromDir(tmpDir);
      if (manifest.name !== resolved.entry.name || manifest.version !== resolved.entry.manifest?.version) {
        throw new Error(
          `tarball 内 manifest 与 commit ${resolved.commit.slice(0, 8)} 处不一致（${manifest.name}@${manifest.version} ≠ ${resolved.entry.name}@${resolved.entry.manifest?.version}）`,
        );
      }

      const pluginSource: PluginSource = {
        kind: 'market',
        repo,
        ref: resolved.entry.ref,
        commit: resolved.commit,
        tarball: resolved.tarball,
        channel: source.id,
      };
      const record = stagePlugin(this.workspaceDir, tmpDir, options.owner ?? this.defaultOwner, pluginSource);

      // 命中真名，回写缓存（此后 `plugin add <name>` 可直接用）
      const entries = this.readCache().filter((e) => e.repo !== repo);
      entries.push(resolved.entry);
      this.writeCache(entries);
      return record;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * 市场 install = stage + approve（一步到位）。
   * grants 语义与本地发布一致：process/shell/ui 必须显式传入才安装；
   * 未满足时**自动清理本次暂存记录**并抛错（不残留待审项——
   * 想走人审流程的调用方应直接用 stage()）。
   * 宿主内运行时（ctx.pluginHost 可用）安装后热加载并广播目录变更，
   * 与 /api/plugins library/approve 完全同语义；CLI 独立进程无 host，
   * 落盘后由下次启动扫描装载。
   */
  async install(spec: string, grants?: unknown, options: MarketStageOptions = {}): Promise<ApproveResult> {
    const record = await this.stage(spec, options);

    // grants 预检：缺高危权限时清掉本次暂存再抛错（fail fast，不进人审队列）
    const granted = grantPermissions(grants);
    const missing = (record.requiredGrants ?? []).filter((p) => !granted.includes(p));
    if (missing.length > 0) {
      rejectStaging(this.workspaceDir, record.id);
      throw new Error(
        `插件 "${record.manifest.name}" 声明了未授予的权限：${missing.join('/')}（传入 grants 重试，或用 stage 走人审流程）`,
      );
    }

    const approved = approveStaging(this.workspaceDir, record.id, grants);

    // 宿主内：热加载（失败仅告警，安装已落盘，重启扫描会再试）+ 目录变更广播
    const host = this.ctx.get?.('pluginHost') as PluginHost | undefined;
    if (host) {
      try {
        await host.load({
          manifest: approved.manifest,
          dir: approved.installedDir,
          agentId: approved.manifest.author,
          sessionOnly: false,
          allowedPermissions: approved.permissions,
        });
      } catch (err: any) {
        this.ctx.logger?.('market').warn(`插件 "${approved.name}" 已安装，但即时装载失败: ${err?.message ?? String(err)}`);
      }
      host.notifyCatalogChanged('installed');
    }
    return approved;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    market: MarketService
  }
}
