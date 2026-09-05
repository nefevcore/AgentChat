// ============================================================
// api/skills.ts —— 技能目录读面（skills/list RPC；输入框 / 快捷输入）
//
// agentId/conversationId 均可选：给出 = listForAgent 合成口（全局白名单
// 过滤 + 本 Agent 专属 files/<agent>/skills + 会话工作区约定目录——
// .claude/skills、.github/skills 等，singles 会话挂载工作区即生效）；
// 缺省 = 全局目录。行未装（rpc error）由调用方归一为空清单——快捷输入
// 的技能区静默隐藏，不打断输入。
// ============================================================

import { wireRpc } from './wire.ts';

/** 技能清单条目（= ac-skill SkillManifest 线形） */
export interface SkillEntry {
  /** 技能名（kebab-case；插入 /<name> 供 Agent 经 load_skill 加载） */
  name: string;
  description: string;
  dirName: string;
  /** 仅工作区条目：约定目录相对路径（如 '.claude/skills'） */
  dir?: string;
  /** 仅工作区条目：位置前缀（<工作区根>/<dir>） */
  location?: string;
}

export interface SkillsResult {
  global: SkillEntry[];
  /** 本 Agent 专属技能（仅传 agentId 时非空） */
  own: SkillEntry[];
  /** 会话工作区技能（仅传 conversationId 且会话挂载工作区时非空） */
  workspace: SkillEntry[];
}

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

/** 拉取技能目录；失败归一为 null（调用方隐藏技能区） */
export async function fetchSkills(
  agentId?: string,
  conversationId?: string,
  rpc: Rpc = wireRpc,
): Promise<SkillsResult | null> {
  try {
    const r = await rpc.call<{
      skills?: { global?: SkillEntry[]; own?: SkillEntry[]; workspace?: SkillEntry[] };
    }>('skills/list', {
      ...(agentId ? { agentId } : {}),
      ...(conversationId ? { conversationId } : {}),
    });
    return {
      global: r.skills?.global ?? [],
      own: r.skills?.own ?? [],
      workspace: r.skills?.workspace ?? [],
    };
  } catch {
    return null;
  }
}
