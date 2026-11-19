// ============================================================
// ac-net-core —— 网络状态判定纯库（cr-1158，零 cordis 依赖）。
// NetworkInterfaceInfo 类型自 node:os 引用（NodeJS 命名空间形态随
// @types/node 版本漂移，os 侧类型是稳定单源）。
//
// 判定语义（用户裁决 2026-11-19）：网卡信号为主判据——有非内部
// IPv4/IPv6 地址即 online；DNS 探测【只服务离线判定的确认与恢复】，
// 在线期零探测（零流量、零耗时——不影响任何使用体验）。有网时
// DNS 快不快与本闸门无关；断网时用它区分「真断网」与「网卡正在
// 漫游/重配的瞬时无 IP」。
//
// 自适应降级（用户裁决：探测慢就别探了）：离线/疑似期 DNS 探测
// 延迟 EWMA > 1000ms 即 dnsDisabled——判定退回网卡单源，不再探测。
// 恢复 online 翻转时重置（换网环境常见，给新 DNS 一次机会）。
// ============================================================

/** 网卡分析结果（os.networkInterfaces() 的纯函数投影） */
export interface InterfaceSignal {
  /** 有有效地址（非内部、非链路本地）的接口名清单 */
  names: string[];
  /** 是否存在任一有效地址——online 的充分条件 */
  hasAddress: boolean;
}

const LINK_LOCAL_V4 = /^169\.254\./;

/**
 * 网卡信号分析：滤除 loopback（internal）、链路本地（169.254/fe80）、
 * 无地址接口。虚拟网卡（vEthernet/VMware 等）有地址时如实计入——
 * 它们确实承载可路由流量；宁可放行后失败重试，不可误杀在线调用。
 */
export function analyzeInterfaces(
  ifaces: Record<string, import('node:os').NetworkInterfaceInfo[] | undefined>,
): InterfaceSignal {
  const names: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    const valid = addrs.some((a) => {
      const fam = String(a.family); // Node ≥18 报 'IPv4'/'IPv6'；旧数字 4/6 兼容
      const v4 = fam === 'IPv4' || fam === '4';
      const v6 = fam === 'IPv6' || fam === '6';
      if (a.internal) return false;
      if (v4) return !LINK_LOCAL_V4.test(a.address);
      if (v6) return !a.address.toLowerCase().startsWith('fe80');
      return false;
    });
    if (valid) names.push(name);
  }
  return { names, hasAddress: names.length > 0 };
}

/**
 * DNS 探测（lookup 单 IP 形态——不经系统解析器搜索域串联，失败快）。
 * 返回耗时毫秒；失败 undefined。本函数只计时与吞噬错误（探测失败 =
 * 数据点，不是异常）；超限判定归调用方（服务侧 dnsTimeoutMs 事后
 * 比对——悬挂的 lookup 只推迟本轮 tick，自循环无重入风险）。
 */
export async function probeDns(
  host: string,
  lookup: (h: string) => Promise<unknown>,
): Promise<number | undefined> {
  const start = Date.now();
  try {
    await lookup(host);
    return Date.now() - start;
  } catch {
    return undefined;
  }
}

/** 网络状态机的跨轮记忆（在线/离线两态 + DNS 健康记账） */
export interface NetState {
  online: boolean;
  /** 状态翻转时刻（epoch 毫秒；由调用方注入时钟便于测试） */
  since: number;
  /** 连续「网卡无信号」轮数（offline 判定需 OFFLINE_CONFIRM 轮确认） */
  missStreak: number;
  /** DNS 探测延迟 EWMA（毫秒；仅成功样本累积）；undefined = 尚无样本 */
  dnsEwma?: number;
  /** DNS 辅助判定已停用（EWMA 超阈——退回网卡单源，不再探测） */
  dnsDisabled?: boolean;
}

/** 离线判定需要的连续无信号轮数（防 WiFi 漫游瞬时抖动误翻） */
export const OFFLINE_CONFIRM = 2;

/** DNS 延时停用阈（毫秒）——EWMA 超过即认为探测太慢，不再依赖 */
export const DNS_SLOW_MS = 1000;

/**
 * 一轮探测的状态推进（纯函数：时钟与探测结果经参数注入）。
 *
 * 规则（在线期零 DNS——裁决 3）：
 *   · 网卡有信号 → online（missStreak 清零；不探测）。
 *   · 网卡无信号（疑似期首轮起 wantDns=true，阈值轮有新鲜样本）：
 *     达 OFFLINE_CONFIRM 轮时，DNS 探测成功 → 维持在线（漫游窗口），
 *     失败或已停用 → offline。
 *   · 已 offline：每轮探测等恢复（未停用时）；网卡信号恢复 → 立即
 *     online 并重置 DNS 记账（换网环境给新 DNS 一次机会）。
 */
export function nextNetState(
  prev: NetState,
  iface: InterfaceSignal,
  dnsMs: number | undefined,
  now: number,
): NetState & { flipped: boolean; wantDns: boolean } {
  let dnsEwma = prev.dnsEwma;
  if (dnsMs !== undefined) {
    dnsEwma = prev.dnsEwma === undefined ? dnsMs : Math.round(prev.dnsEwma * 0.5 + dnsMs * 0.5);
  }
  const dnsDisabled = prev.dnsDisabled === true || dnsEwmaTooSlow(dnsEwma);
  const base = { ...(dnsEwma !== undefined ? { dnsEwma } : {}), ...(dnsDisabled ? { dnsDisabled: true } : {}) };

  if (iface.hasAddress) {
    if (prev.online) return { online: true, since: prev.since, missStreak: 0, ...base, flipped: false, wantDns: false };
    // 恢复翻转：DNS 记账重置（换网环境常见）
    return { online: true, since: now, missStreak: 0, flipped: true, wantDns: false };
  }

  const missStreak = prev.missStreak + 1;
  if (!prev.online) {
    // 已离线：维持 + 每轮探测等恢复
    return { online: false, since: prev.since, missStreak, ...base, flipped: false, wantDns: !dnsDisabled };
  }
  // 在线 → 疑似：首轮起请求 DNS 数据（下轮阈值判定用）
  if (missStreak >= OFFLINE_CONFIRM && (dnsDisabled || dnsMs === undefined)) {
    return { online: false, since: now, missStreak, ...base, flipped: true, wantDns: !dnsDisabled };
  }
  return { online: true, since: prev.since, missStreak, ...base, flipped: false, wantDns: true };
}

function dnsEwmaTooSlow(ewma: number | undefined): boolean {
  return ewma !== undefined && ewma > DNS_SLOW_MS;
}

/** 本地/私网端点判定（闸门豁免：本地 Ollama 等离线可用） */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false; // 解析不出按远程对待（豁免面收敛，闸门不漏）
  }
  const bare = host.replace(/\[|\]/g, ''); // URL.hostname 对 IPv6 字面量保留方括号
  if (LOCAL_HOSTS.has(bare)) return true;
  if (bare.includes(':')) {
    // IPv6——fe80 链路本地与 fc00::/7 ULA 视为本地
    return bare.startsWith('fe80') || /^f[cd]/.test(bare);
  }
  return PRIVATE_V4.some((re) => re.test(bare));
}

/** 初始状态（进程启动即假设在线——首轮探测即修正；缺省不阻塞调用） */
export function initialNetState(now: number): NetState {
  return { online: true, since: now, missStreak: 0 };
}