// ============================================================
// webui-kit/src/starColor.ts —— Agent 星色系统（M28 P3 自
// ac-client-ui-sidebar/client/starColor.ts 下沉——design-system §3.2
// 的纯函数；跨域消费面〔agents/singles/runview〕经 kit 直连）
// ============================================================

export type ThemeMode = 'nebula' | 'aurora';

/** 8 色星板（双主题）——马卡龙 × 星空色系（cr-122 语义分离重排）：
 *  薰衣草/蓝青/湖青/苔绿/橄榄/珊瑚/品红紫/暮蓝；
 *  暖端仅 2 位（珊瑚/橄榄），黄/玫红/绿三带让给语义色（ok/warn/err）。 */
const STAR_PALETTE: { nebula: string; aurora: string; label: string }[] = [
  { nebula: '#c9b8f0', aurora: '#5b4a9e', label: '薰衣草' },
  { nebula: '#a8c8e8', aurora: '#2a5a8a', label: '蓝青' },
  { nebula: '#9adbe0', aurora: '#1a6a6e', label: '湖青' },
  { nebula: '#b8e8a8', aurora: '#35702e', label: '苔绿' },
  { nebula: '#d9e8a0', aurora: '#55652a', label: '橄榄' },
  { nebula: '#f5c4a8', aurora: '#9c4a1e', label: '珊瑚' },
  { nebula: '#e0a8d4', aurora: '#8e3a75', label: '品红紫' },
  { nebula: '#b3b8e8', aurora: '#3d4499', label: '暮蓝' },
];

/** 用户（观察者）固定白金，不参与哈希 */
const USER_STAR = { nebula: '#e8eaf2', aurora: '#1b2130', label: '白金' };

/** 稳定字符串哈希 → 0..7（无主题分支，保证同一 Agent 恒同色） */
function hashAgentId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return h % STAR_PALETTE.length;
}

/**
 * hex → "r, g, b" 三元组（cr-32：tint 回退用——rgba(var(--x-rgb), α)）。
 * 星色是运行时注入的内联 --sc/--tc，无法由 CSS 侧派生三元组，故由组件
 * 同时注入伴随变量；非 hex 输入（如已传 var(--primary)）回落主色三元组。
 */
export function hexTriplet(color?: string | null): string {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color ?? '');
  if (!m) return 'var(--primary-rgb)';
  let h = m[1]!;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ');
}

/** 获取 Agent 星色（按主题） */
export function starColor(agentId: string, theme: ThemeMode): string {
  if (!agentId || agentId === 'user') return theme === 'aurora' ? USER_STAR.aurora : USER_STAR.nebula;
  const pal = STAR_PALETTE[hashAgentId(agentId)]!;
  return theme === 'aurora' ? pal.aurora : pal.nebula;
}
