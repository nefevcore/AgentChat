// ============================================================
// profile-face.ts —— 宿主能力面贡献行：update_agent_profile（cr-1121）
//
// cr-886 时执行面住 ac-host-face/tools.ts（写死清单）；cr-1121 真动态化
// 拆出：本行向 hostFaceRegistry 自报 update_agent_profile 工具 spec +
// 执行器（自 ac-collab-tools 搬家语义原样——注册表写口收敛宿主，
// agents-core 纯库读改写盘，与宿主编辑面同源）。TERMINOLOGY /
// GUIDELINES_COLLAB 段与 collab 工具面语义耦合（壳内本地 owner =
// ac-collab-tools），宿主贡献行不搬——壳内对账补位语义退役（本地
// owner 在场时由本地行供给，见 host-shell-decisions）。
// 双闸：壳闸 = 代理注册面 requiredTags 门禁；宿主闸 = 执行器内 admin 复查。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context, Plugin } from '@agentchat/cordis';
import { readAgentConfig, writeAgentConfig, isPresetId, type AgentConfig } from 'ac-agents-core';
import type { HostFaceContribution } from './index.ts';

export const name = 'ac-host-rows/profile-face';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'profile-face',
  label: '宿主能力面：档案写口',
  description: 'update_agent_profile 远程工具贡献行（host-face 契约注册面；agents 树读改写与宿主编辑面同源）',
  automatic: true,
};

const err = (msg: string): { ok: false; error: string } => ({ ok: false, error: msg });

/** 档案字段白名单（与壳侧 PROFILE_ALLOWED_FIELDS 同源词表） */
const PROFILE_ALLOWED_FIELDS = ['name', 'description', 'system', 'persona', 'tools', 'maxSteps', 'settings'] as const;

/** update_agent_profile 执行器（cr-886 起语义原样——tools.ts executeProfile 搬家） */
function executeProfile(
  dataRoot: string,
  args: Record<string, unknown>,
  identity: { agentId?: string; conversationId?: string },
): { ok: boolean; result?: unknown; error?: string } {
  const selfId = identity.agentId;
  if (selfId === undefined) return err('缺少执行身份（agentId）');
  const targetId = typeof args.agent_id === 'string' && args.agent_id.trim() ? args.agent_id.trim() : selfId;
  const fields = (args.fields ?? {}) as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length === 0) return err('fields 参数不能为空');
  const invalid = keys.filter((k) => !(PROFILE_ALLOWED_FIELDS as readonly string[]).includes(k));
  if (invalid.length > 0) {
    return err(`不允许修改：${invalid.join(', ')}。只能修改：${PROFILE_ALLOWED_FIELDS.join(', ')}。`);
  }
  const current = readAgentConfig(dataRoot, targetId);
  if (current === null) return err(`Agent "${targetId}" 未找到`);
  if (isPresetId(targetId)) return err(`Agent "${targetId}" 是预设身份（不可经 update_agent_profile 修改）`);
  // 宿主闸：admin 复查（壳闸只管 collab 可见性——越权在此拦）。cr-953：
  // admin 判定换轨 levels.collab（tags 退役；settings.collab.admin 回滚兼容）
  if (targetId !== selfId) {
    const self = readAgentConfig(dataRoot, selfId);
    if (self?.levels?.collab === 'admin' || self?.levels?.collab === true
      || (self?.settings as { collab?: { admin?: unknown } } | undefined)?.collab?.admin === true) {
      // admin 在场
    } else {
      return err(`仅具备 admin 能力的 Agent 可修改他人档案（目标 "${targetId}"）`);
    }
  }

  const next: AgentConfig = { ...current };
  const changed: string[] = [];
  if (fields.name !== undefined) {
    const name = String(fields.name).trim();
    if (!name) delete next.name;
    else next.name = name;
    changed.push('name');
  }
  if (fields.description !== undefined) {
    next.description = String(fields.description);
    changed.push('description');
  }
  if (fields.system !== undefined) {
    next.system = String(fields.system);
    changed.push('system');
  }
  if (fields.persona !== undefined) {
    const persona = String(fields.persona ?? '').trim();
    if (!persona) return err('persona 不能为空');
    const docPath = path.join(dataRoot, 'agents', targetId, 'AGENTS.md');
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, `# 人物设定\n\n${persona}\n`, 'utf-8');
    const settings = { ...(next.settings ?? {}) };
    const existing = settings['persona'];
    settings['persona'] = {
      ...(existing !== undefined && existing !== null && typeof existing === 'object' ? existing as Record<string, unknown> : {}),
      file: 'AGENTS.md',
    };
    next.settings = settings;
    changed.push('persona');
  }
  if (fields.tools !== undefined) {
    // cr-692：AgentConfig 键已更名 tools→rows（参数名保持 tools——模型面词汇兼容）
    const tools = Array.isArray(fields.tools) ? fields.tools.filter((t): t is string => typeof t === 'string') : undefined;
    if (tools === undefined) return err('tools 字段须为字符串数组');
    if (tools.length === 0) delete next.rows;
    else next.rows = tools;
    changed.push('tools');
  }
  if (fields.maxSteps !== undefined) {
    const maxSteps = Number(fields.maxSteps);
    if (!Number.isFinite(maxSteps) || maxSteps < 0) return err('maxSteps 须为非负整数');
    if (maxSteps === 0) delete next.maxSteps;
    else next.maxSteps = Math.floor(maxSteps);
    changed.push('maxSteps');
  }
  if (fields.settings !== undefined) {
    if (fields.settings === null || typeof fields.settings !== 'object' || Array.isArray(fields.settings)) {
      return err('settings 字段须为对象（settings[具名] 配置）');
    }
    // cr-1262 授权工件键禁写：settings.security（沙箱 allowedPaths——自写即
    // 自扩磁盘边界）与 settings['permission-gate']（审批链第二层——自写
    // onAsk 即自批）是授权工件，工具面恒禁写（cr-1217 面2 同款语义；运营者
    // 写口 = 手编文件/宿主编辑面，不经本函数）。mathematician 实证：经本口
    // 写 security.allowedPaths 成功且立即生效——受管对象自授权，fail-loud。
    const blocked = Object.keys(fields.settings).filter((k) => k === 'security' || k === 'permission-gate');
    if (blocked.length > 0) {
      return err(`settings 键 ${blocked.join('/')} 是授权工件（沙箱边界/审批裁决），不得经 update_agent_profile 写入——运营者请直接编辑 agents/<id>/ 对应文件`);
    }
    next.settings = { ...(current.settings ?? {}), ...(fields.settings as Record<string, unknown>) };
    changed.push('settings');
  }

  writeAgentConfig(dataRoot, next); // 归一写口（tree.ts——与宿主编辑面同源）
  return { ok: true, result: { agent_id: targetId, changed, persisted: true } };
}

export function makeProfileFaceRow(options: { dataRoot: string }): Plugin {
  return {
    name: 'ac-host-rows/profile-face',
    inject: ['hostFaceRegistry'],
    apply(ctx: Context) {
      const dataRoot = options.dataRoot;
      const contribution: HostFaceContribution = {
        tools: [{
          name: 'update_agent_profile',
          description:
            '更新 Agent 档案（name/description/system/persona/tools/maxSteps/settings）。默认改自己，具备 admin 能力可改他人；name 是显示名称（名册/群聊展示），description 是一句话简介（不影响显示名）；persona 写入 Agent 目录 AGENTS.md。settings 禁写授权工件键（security / permission-gate——授权由运营者配置，Agent 不得自授）。',

          parameters: {
            type: 'object',
            properties: {
              agent_id: { type: 'string', description: '目标 Agent（默认自己；仅 admin 可改他人）' },
              fields: {
                type: 'object',
                description: '要更新的字段',
                properties: {
                  name: { type: 'string', description: '显示名称（名册/群聊展示；空串 = 清除，回落简介/id）' },
                  description: { type: 'string', description: '一句话简介（其他 Agent 与用户可见；不是显示名）' },
                  system: { type: 'string', description: '基础系统提示词' },
                  persona: { type: 'string', description: '人物设定（写入 Agent 目录 AGENTS.md 并挂载 persona 装载）' },
                  tools: { type: 'array', items: { type: 'string' }, description: '工具白名单（空数组/缺省 = 全部）' },
                  maxSteps: { type: 'number', description: '步数预算（0 = 不限）' },
                  settings: { type: 'object', description: '具名扩展设置（settings[具名]——已装插件在该 Agent 的行为）' },
                },
              },
            },
            required: ['fields'],
          },
        }],
        sections: [],
        executor: (_ctx, args, identity) => executeProfile(dataRoot, args, identity),
      };
      ctx.get('hostFaceRegistry')!.contribute(ctx, 'profile-face', contribution);
    },
  } satisfies Plugin;
}
