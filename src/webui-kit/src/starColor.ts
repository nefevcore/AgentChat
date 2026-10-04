// ============================================================
// webui-kit/src/starColor.ts —— Agent 星色系统（M28 P3 自
// ac-client-ui-sidebar/client/starColor.ts 下沉——design-system §3.2
// 的纯函数；跨域消费面〔agents/singles/runview〕经 kit 直连）
// ============================================================

export type ThemeMode = 'nebula' | 'aurora';

/** 9 色星板（双主题）——社区 Agent 身份色（cr-151/152 重排）：九档均匀色环
 *  35/70/105/175/210/245/275/305/320°（绿/黄/玫红语义带让位 ok/warn/err）；
 *  原板（马卡龙×星空 → cr-151 活力版）五分之四色挤在蓝紫红三带——均匀化后
 *  同屏多 Agent 才真正「各自异色」（cr-122 语义分离格局保留）：
 *  薰衣草/蓝青/湖青/苔绿/橄榄/珊瑚/品红紫/暮蓝；
 *  暖端仅 2 位（珊瑚/橄榄），黄/玫红/绿三带让给语义色（ok/warn/err）。
 *  cr-151 活力版重定档：星色 = 社区 Agent 身份色（鲜活个性、色相拉开——
 *  Slack/Discord 用户色板语义），非「星空氛围色」（统一低调马卡龙）。
 *  nebula = 果汁软糖档（S 拉满、L 亮）；aurora = 社区徽章档（600-800 活力色）。
 *  双 tint 锁（星色 0.14 / 标签 0.08）全过 4.5。 olive/coral 命名承旧（色相已
 *  移向暖金/暖橙——身份连续性优先于名字）。 */
const STAR_PALETTE: { nebula: string; aurora: string; label: string }[] = [
  { nebula: '#d199fa', aurora: '#8d0ce9', label: '薰衣草' },
  { nebula: '#7ebdfc', aurora: '#0a63bd', label: '蓝青' },
  { nebula: '#7efcf1', aurora: '#066f67', label: '湖青' },
  { nebula: '#9dfc7e', aurora: '#296f06', label: '苔绿' },
  { nebula: '#e7fc7e', aurora: '#5a6b06', label: '橄榄' },
  { nebula: '#fcc77e', aurora: '#965408', label: '珊瑚' },
  { nebula: '#fc83f2', aurora: '#ae09a1', label: '品红紫' },
  { nebula: '#fc88d5', aurora: '#b30989', label: '玫瑰' },
  { nebula: '#b0abed', aurora: '#4c3df5', label: '暮蓝' },
];

/** 用户（观察者）固定白金，不参与哈希 */
const USER_STAR = { nebula: '#F5E0B0', aurora: '#78350F', label: '白金' };

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
