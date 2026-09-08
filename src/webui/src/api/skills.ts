// ============================================================
// api/skills.ts —— 技能目录读面（skills/list RPC；输入框 / 快捷输入）
//
// owning = ac-client-ui-conversation/client/skillsApi.ts（M27.2-2
// 视图半边随件迁——ChatInput 数据源）；本模块薄包装维持旧签名
//（rpc 缺省 wireRpc）。
// ============================================================

import { wireRpc } from './wire.ts';
import { fetchSkills as pkgFetchSkills } from 'ac-client-ui-conversation/client/skillsApi.ts';

export type { SkillEntry, SkillsResult } from 'ac-client-ui-conversation/client/skillsApi.ts';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

/** 拉取技能目录；失败归一为 null（调用方隐藏技能区） */
export function fetchSkills(
  agentId?: string,
  conversationId?: string,
  rpc: Rpc = wireRpc,
): Promise<import('ac-client-ui-conversation/client/skillsApi.ts').SkillsResult | null> {
  return pkgFetchSkills(agentId, conversationId, rpc);
}
