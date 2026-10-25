// ============================================================
//（M28 P1 自 conversation 随域迁入 ui-skill——T3 数据面跟域走）
//（M27.2-2 conversation 视图半边随件迁：ChatInput / 快捷输入）
//
// skills/list RPC：agentId/conversationId 均可选——给出 = listForAgent
// 合成口（全局白名单过滤 + 本 Agent 专属 + 会话工作区约定目录）；
// 缺省 = 全局目录。行未装（rpc error）由调用方归一为空清单——技能区
// 静默隐藏。rpc 必传（契约面）；原 webui api/skills.ts 门面已退役〔M28 §4.2〕。
// ============================================================
import type { RpcClientFace } from 'ac-client-runtime';

type Rpc = Pick<RpcClientFace, 'call'>;

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

/** 拉取技能目录；失败归一为 null（调用方隐藏技能区） */
export async function fetchSkills(
  agentId: string | undefined,
  conversationId: string | undefined,
  rpc: Rpc,
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
