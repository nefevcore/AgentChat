// ============================================================
// @agentchat/plugins/src/market/source.ts —— 市场源契约（发现层）
//
// 两层设计：
//   · topic（或静态索引）只负责"找到仓库" —— 无门槛、不可信
//   · 仓库里的 manifest.json 才是市场条目 —— 拉回本地后必须过
//     validatePluginManifest，且钉到 commit（PluginSource）
//
// 源适配器接口（MarketSource）：GitHub 是第一个实现；后续可加
// Gitea / GitLab / 静态 JSON 索引 / 自托管实例，宿主无感切换。
// 启动路径绝不硬依赖网络：search 只在显式请求时调用，索引落本地缓存。
// ============================================================
import type { PluginManifest } from '@agentchat/agent-config';

/** 市场条目（发现层产物；manifest 字段在 resolve 后填充） */
export interface MarketEntry {
  /** 条目名（= manifest.name；resolve 前可能是仓库名的猜测） */
  name: string;
  /** 仓库坐标（owner/name） */
  repo: string;
  /** 发现时可见的 ref（tag/branch；resolve 时钉定 commit） */
  ref?: string;
  /** manifest 快照（resolve 后填充） */
  manifest?: PluginManifest;
  /** 仓库描述（发现层展示用） */
  description?: string;
  /** 星标数（发现层展示用，按源语义） */
  stars?: number;
  /** 更新时间（ISO） */
  updatedAt?: string;
  /** 发现通道 id（如 "github"） */
  channel: string;
}

/** resolve 产物：manifest + 钉定 commit + tarball 地址 */
export interface ResolvedEntry {
  entry: MarketEntry;
  /** 解析并钉定的 commit SHA（安装锚点） */
  commit: string;
  /** tarball 下载地址（含 commit，确保下载内容 = 审查内容） */
  tarball: string;
}

/** 源适配器接口（实现方做发现、元数据解析与受控下载，不做安装） */
export interface MarketSource {
  /** 通道 id（MarketEntry.channel） */
  readonly id: string;
  /** 按 topic（或源自身的聚合方式）搜索仓库 */
  search(query?: string): Promise<MarketEntry[]>;
  /** 拉取仓库 manifest 并钉定 commit */
  resolve(repo: string, ref?: string): Promise<ResolvedEntry>;
  /** 下载 tarball（带通道认证头；返回的 Buffer 是不可信输入） */
  download(url: string): Promise<Buffer>;
}

/** 市场条目解析结果（MarketService.stage/install 的输入） */
export interface MarketSpec {
  repo?: string;
  ref?: string;
  name?: string;
}

/**
 * 解析安装说明符：
 *   · "owner/repo"        → 直连仓库（默认分支）
 *   · "owner/repo#v1.2.0" → 直连仓库钉 ref（tag/branch/commit）
 *   · "name"              → 市场索引条目名（须先 search 落缓存）
 */
export function parseMarketSpec(input: string): MarketSpec {
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('市场安装说明符为空');
  if (trimmed.includes('#')) {
    const [repo, ref] = trimmed.split('#');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error(`仓库坐标非法: "${repo}"（期望 owner/name）`);
    }
    if (!ref || /[\s/]/.test(ref)) throw new Error(`ref 非法: "${ref}"`);
    return { repo, ref };
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) return { repo: trimmed };
  return { name: trimmed };
}
