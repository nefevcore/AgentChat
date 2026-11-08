// ============================================================
// client/onboardingState.ts —— 首启标记 + 步骤状态机（纯逻辑半边）
//（first-run-onboarding-plan §3.3/§3.4）
//
// 首启标记：localStorage 单键 agentchat.onboarding，值
// { version: 1, completedAt }——无键 = 首启该弹；走完全程或跳过（含
// 确认后仍跳过）即写。version 只作未来显式决策的锚，不是自动重弹
// 理由。不写后端 config：config/save 是白名单域 replace 语义，为
// 「首启一次」扩白名单不值当（§4.4——代价：换浏览器各弹一次，已接受）。
//
// 跳过确认判定（§3.4/D5）：正要跳过且一个 llmProviders 连接都没有
// → 拦一次（弹确认）；确认后不再拦。已配模型不弹。
// ============================================================

/** 首启标记持久化键 */
export const ONBOARDING_KEY = 'agentchat.onboarding';

/** 标记值形态（version = 未来显式决策锚，不驱动重弹） */
export interface OnboardingMark {
  version: number;
  completedAt: string;
}

type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; };

/** 读标记（缺键/坏值 → null = 首启） */
export function readMark(storage: StorageLike): OnboardingMark | null {
  try {
    const raw = storage.getItem(ONBOARDING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<OnboardingMark>;
    return typeof v.completedAt === 'string' && v.completedAt ? { version: 1, completedAt: v.completedAt } : null;
  } catch {
    return null;
  }
}

/** 写标记（走完全程或跳过时调用——completedAt = ISO 时间） */
export function writeMark(storage: StorageLike): void {
  try {
    storage.setItem(ONBOARDING_KEY, JSON.stringify({ version: 1, completedAt: new Date().toISOString() } satisfies OnboardingMark));
  } catch {
    /* 存储不可用（隐私模式等）不阻塞——本次会话不再弹即可 */
  }
}

// ── 步骤状态机 ──

export const ONBOARDING_STEPS = ['profile', 'llm', 'search', 'agent', 'tour'] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/** 步骤元数据（标题 + 侧栏副标题 + 导语）——序 = ONBOARDING_STEPS */
export const STEP_META: Record<OnboardingStepId, { title: string; sub: string; lead: string }> = {
  profile: { title: '用户设置', sub: '虚拟 Agent user', lead: '先把自己立起来——会话气泡、群聊转录、活动栏署名都用它。' },
  llm: { title: '模型设置', sub: '模型连接', lead: '没有可用的模型连接，Agent 一句话也说不出来。这是最关键的一步。' },
  search: { title: '搜索设置', sub: '搜索引擎连接', lead: '检索类工具（联网搜索）依赖搜索引擎连接；不配也能用，这是最该跳过的一步。' },
  agent: { title: 'Agent 设置', sub: '创建第一个 Agent', lead: '创建你的第一个 Agent：给它起名、选模型、写人格。' },
  tour: { title: '界面导览', sub: '开始使用', lead: '一张地图讲清整个界面——之后随时可以在「更多」菜单重播本引导。' },
};

/** 跳过确认判定（§3.4）：无任何 llm 连接时才拦；确认过（或已配）不再拦 */
export function shouldConfirmSkip(llmPoolCount: number, confirmedOnce: boolean): boolean {
  return llmPoolCount === 0 && !confirmedOnce;
}
