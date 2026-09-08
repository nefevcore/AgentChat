// ============================================================
// webui-kit/src/starColor.ts —— Agent 星色系统（M28 P3 自
// ac-client-ui-sidebar/client/starColor.ts 下沉——design-system §3.2
// 的纯函数；跨域消费面〔agents/singles/runview〕经 kit 直连）
// ============================================================

export type ThemeMode = 'nebula' | 'aurora';

/** 8 色星板（双主题） */
const STAR_PALETTE: { nebula: string; aurora: string; label: string }[] = [
  { nebula: '#a78bfa', aurora: '#7c3aed', label: '靛紫' },
  { nebula: '#60a5fa', aurora: '#2563eb', label: '青蓝' },
  { nebula: '#22d3ee', aurora: '#0891b2', label: '青' },
  { nebula: '#34d399', aurora: '#059669', label: '绿' },
  { nebula: '#fbbf24', aurora: '#d97706', label: '琥珀' },
  { nebula: '#fb923c', aurora: '#ea580c', label: '橙红' },
  { nebula: '#f472b6', aurora: '#db2777', label: '玫粉' },
  { nebula: '#f87171', aurora: '#dc2626', label: '紫红' },
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

/** 获取 Agent 星色（按主题） */
export function starColor(agentId: string, theme: ThemeMode): string {
  if (!agentId || agentId === 'user') return theme === 'aurora' ? USER_STAR.aurora : USER_STAR.nebula;
  const pal = STAR_PALETTE[hashAgentId(agentId)]!;
  return theme === 'aurora' ? pal.aurora : pal.nebula;
}
