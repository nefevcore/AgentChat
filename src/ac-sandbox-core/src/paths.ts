// ============================================================
// ac-sandbox-core/src/paths.ts —— 沙箱路径解析器（src toolkit 参数化平移）
//
// 解除 src toolkit→agent-config 依赖倒挂（地图 §3.4）：解析器不再读
// AgentConfig，而是显式参数 createSandboxResolver({workdir, allowedPaths,
// denyPatterns})——调用方（ac-security 行）负责从 AgentConfig.settings['security']
// 取参。语义原样：目标必须落在允许根内，且不得命中敏感黑名单（DENY
// 优先于 allow）。
// ============================================================
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * 内置敏感路径黑名单（不可覆盖）：
 *   · 家目录凭据目录（~/.agentchat 整目录）
 *   · 常见密钥/凭据文件名模式
 */
export const BUILTIN_DENY_PATTERNS: string[] = [
  '~/.agentchat',
  '**/.env',
  '**/*.pem',
  '**/id_rsa*',
  '**/*_rsa',
  '**/.npmrc',
  '**/.git-credentials',
  // A3：凭据库文件名（ac-credentials owning 文件；任意目录层级同名全拦
  // ——名字足够特异无误伤。config.json 不走文件名模式：通用名会误伤用户
  // 项目文件，由控制面黑名单按数据根绝对路径精确注入）
  '**/credentials.json',
];

/** 沙箱解析器参数（ac-security 行从 AgentConfig.settings['security'] 装配） */
export interface SandboxResolverOptions {
  /** 相对路径解析基准（缺省 process.cwd()；src security.workdir 对应物） */
  workdir?: string;
  /** 额外允许根（相对路径按 workdir 解析；src security.allowedPaths 对应物） */
  allowedPaths?: string[];
  /** 追加黑名单（内置不可覆盖；src security.denyPaths 对应物） */
  denyPatterns?: string[];
}

export interface SandboxResolver {
  /** 相对路径解析基准（bash cwd / 提示词 [工作目录] 同源） */
  readonly workdir: string;
  /** 全部允许根（workdir + allowedPaths 展开） */
  readonly allowedRoots: string[];
  /** 沙箱解析：越界 / 命中黑名单抛错（错误消息面向模型可读） */
  resolve(p: string): string;
  /** 目标是否落在允许根内（不检查黑名单） */
  isAllowed(target: string): boolean;
  /** 目标是否命中黑名单（内置 + 追加） */
  isDenied(target: string): boolean;
}

/** workspace 服务的最小结构面（ac-workspace 沙箱面；结构化注入保持纯库零 cordis 依赖） */
export interface SandboxWorkdirSource {
  sandboxWorkdir(id?: string): string | undefined;
  /**
   * 会话感知的允许根并出面（settings['security'].allowedPaths ∪ singles
   * 会话挂载工作区根，经 workspace 合成——工具行基线端到端消费）。
   * conversationId 随工具执行身份透传：同 Agent 不同会话（挂/未挂工作区）
   * 得到不同授予集，缓存键随 granted 集自然分桶。可选面：源未实现 = 无附加授予根。
   */
  sandboxAllowedPaths?(id?: string, conversationId?: string): string[];
  /**
   * Agent 专用空间面（写侧对齐读侧，2026-10 裁决）：ac-memory 注入 /
   * ac-archive 概要读取 / ac-skill 专属技能等读侧服务都锚
   * workspace.agentWorkdir——显式 settings['security'].workdir 使沙箱
   * 基准与其分叉时，专用空间经 agentSpaceRoots 自动并入允许根（Agent
   * 经绝对路径维护记忆/概要可达）。可选面：源未实现 = 不扩面。
   */
  agentWorkdir?(id?: string): string | undefined;
}

/**
 * 写侧对齐读侧——Agent 专用空间自动并根（2026-10 裁决）：
 * 读侧服务（ac-memory 注入 / ac-archive 概要 / ac-skill 专属技能）锚定
 * agentWorkdir，而 fs 工具相对路径按沙箱基准（sandboxWorkdir）解析——
 * 显式 settings['security'].workdir 使两者分叉时，hint 相对路径会写错
 * 位置、绝对路径又会越界，记忆维护"无路可走"。本函数在基准分叉时把
 * 专用空间并入允许根（调用方 = 工具行基线缓存 + ac-security 复检，两处
 * 同源防漂移）：
 *   · 基准与专用空间相等（常规 Agent = files/<id>、预设 = 根）→ 空数组
 *     （不扩面，缓存键与旧版同形）；
 *   · 基准不可知（sandboxWorkdir undefined——未知/虚拟端）或源未实现
 *     agentWorkdir 面 → 空数组（行为与旧版一致，fail-closed）。
 * 黑名单（denyPatterns）仍优先于允许根——并根不放行敏感文件。
 */
export function agentSpaceRoots(
  ws: Pick<SandboxWorkdirSource, 'agentWorkdir'> | undefined,
  agentId: string | undefined,
  base: string | undefined,
): string[] {
  if (ws === undefined || agentId === undefined || base === undefined) return [];
  const dir = ws.agentWorkdir?.(agentId);
  if (dir === undefined || !dir) return [];
  return path.resolve(dir) === path.resolve(base) ? [] : [dir];
}

/**
 * 判断目标路径是否命中黑名单。
 * 支持模式：`**` 斜杠前缀 = 文件名模式（任意目录层级，如 `.env`、`*.pem`、`id_rsa*`）、
 *           `~` = 家目录展开、其余为绝对路径前缀。
 */
export function isDeniedPath(patterns: string[], target: string): boolean {
  const norm = target.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  for (const raw of patterns) {
    if (!raw) continue;
    // 模式分隔符归一化（Windows 反斜杠绝对路径模式与归一化目标同形可比）
    const pattern = raw.replace(/\\/g, '/');
    if (pattern.startsWith('**/')) {
      // 文件名模式（任意目录层级）
      const p = pattern.slice(3);
      if (p.startsWith('*') && p.length > 1) {
        if (base.endsWith(p.slice(1))) return true;
      } else if (p.endsWith('*') && p.length > 1) {
        if (base.startsWith(p.slice(0, -1))) return true;
      } else if (base === p) {
        return true;
      }
    } else if (pattern.startsWith('~')) {
      // 家目录展开 + 前缀匹配
      const home = os.homedir().replace(/\\/g, '/');
      const p = home + pattern.slice(1);
      if (norm === p || norm.startsWith(p + '/')) return true;
    } else if (norm === pattern || norm.startsWith(pattern + '/')) {
      // 绝对路径前缀
      return true;
    }
  }
  return false;
}

/**
 * 构建沙箱路径解析器。
 * resolve 语义（src resolveSafePath 原样）：
 *   · 相对路径以 workdir 为基准解析
 *   · 目标必须 === 某允许根，或落在某允许根之下（startsWith root + sep）
 *   · 黑名单优先于 allow
 * @throws 越界 / 命中黑名单抛错
 */
export function createSandboxResolver(options: SandboxResolverOptions = {}): SandboxResolver {
  const workdir = options.workdir ? path.resolve(options.workdir) : process.cwd();
  // 允许根统一 resolve（绝对路径原样保留但归一化分隔符——Windows 上
  // 'E:/data' 与 path.resolve 产出的 'E:\data' 必须同形才能前缀匹配）
  const allowedRoots = [workdir, ...(options.allowedPaths ?? []).map((a) => path.resolve(workdir, a))];
  const denyPatterns = [...BUILTIN_DENY_PATTERNS, ...(options.denyPatterns ?? [])];

  const isAllowed = (target: string): boolean => {
    const t = path.resolve(target);
    return allowedRoots.some((r) => t === r || t.startsWith(r + path.sep));
  };
  const isDenied = (target: string): boolean => isDeniedPath(denyPatterns, target);

  return {
    workdir,
    allowedRoots,
    isAllowed,
    isDenied,
    resolve(p: string): string {
      const target = path.resolve(workdir, p);
      if (!isAllowed(target)) throw new Error(`路径越界（沙箱限制）：${p}`);
      if (isDenied(target)) throw new Error(`路径被沙箱拒绝（敏感文件黑名单）：${p}`);
      return target;
    },
  };
}

/**
 * per-Agent（× 会话）沙箱解析缓存（沙箱化工具行共用）：基准 =
 * workspace.sandboxWorkdir(agentId) ?? options.workdir，同基准不重建解析器。
 * 允许根 = 行配置 allowedPaths ∪ workspace.sandboxAllowedPaths(agentId,
 * conversationId)（settings['security'].allowedPaths ∪ singles 会话挂载
 * 工作区根，经 workspace 面并出——显式授予随基线端到端生效，不依赖
 * ac-security 行的 enabled 开关；conversationId 随工具执行身份透传，
 * 同 Agent 挂/未挂工作区的会话得到不同授予集，缓存键随 granted 集分桶）
 * ∪ Agent 专用空间（agentSpaceRoots：基准分叉时并根——写侧对齐读侧，见其注释）。
 * workspace 以 getter 注入（行内 `() => ctx.get('workspace')`）——无执行
 * 身份 / 未装 workspace 行 → 行缺省基准（M18 反馈 #3 语义原样收拢）。
 */
export function createAgentSandboxCache(
  options: SandboxResolverOptions,
  getWorkdirSource: () => SandboxWorkdirSource | undefined,
): (call: { agentId?: string; conversationId?: string }) => SandboxResolver {
  const resolvers = new Map<string, SandboxResolver>();
  return (call) => {
    const ws = getWorkdirSource();
    const base = ws?.sandboxWorkdir(call.agentId) ?? options.workdir;
    const granted = ws?.sandboxAllowedPaths?.(call.agentId, call.conversationId) ?? [];
    const agentSpace = agentSpaceRoots(ws, call.agentId, base);
    const allowedPaths = [...(options.allowedPaths ?? []), ...granted, ...agentSpace];
    const key = JSON.stringify([base ?? null, allowedPaths]);
    let r = resolvers.get(key);
    if (!r) {
      r = createSandboxResolver({
        ...options,
        ...(base !== undefined ? { workdir: base } : {}),
        ...(allowedPaths.length > 0 ? { allowedPaths } : {}),
      });
      resolvers.set(key, r);
    }
    return r;
  };
}
