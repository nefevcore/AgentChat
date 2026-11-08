// ============================================================
// ac-host-face/src/tools.ts —— 远程工具清单 + 宿主执行面（cr-886）
//
// timer（新建）：HostTimersService 的 LLM 面——排程/唤醒执行全在宿主，
//   壳侧只见代理。update_agent_profile（自 ac-collab-tools 搬家）：注册表
//   写口收敛宿主（agents-core 纯库读改写盘——与宿主编辑面同源；壳侧
//   双写者竞态面消失）。
// 双闸：壳闸 = 代理注册面 requiredTags 门禁（可见性）；宿主闸 = execute
//   帧处理内复查（admin 判定/服务在场在宿主执行面重走）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import { readAgentConfig, writeAgentConfig, isPresetId, type AgentConfig } from 'ac-agents-core';
import { parseInterval, validateTimerEntries, type TimerEntry } from 'ac-timer-core';
import type { HostFaceToolSpec } from 'ac-host-face-core';

/** 档案字段白名单（与壳侧 PROFILE_ALLOWED_FIELDS 同源词表） */
const PROFILE_ALLOWED_FIELDS = ['name', 'description', 'system', 'persona', 'tools', 'maxSteps', 'settings'] as const;

export const HOST_FACE_TOOLS: HostFaceToolSpec[] = [
  {
    name: 'timer',
    description:
      '管理定时任务：set 安排一条提醒/延时任务（到点以新消息唤醒你并携带 hint）、list 查看自己的条目、cancel 按 id 取消。会话维度：在哪个会话设置就回哪个会话；时间串支持 HH:mm（每天）/ YYYY-MM-DDTHH:mm（一次）/ 周日 12:00（每周）/ 间隔（30m、1h）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'list', 'cancel'], description: '操作' },
        hint: { type: 'string', description: '[set] 触发时携带的提示词（到点唤醒你时看到的指令——写清楚要做什么）' },
        time: { type: 'string', description: '[set] 时间串：HH:mm 每天定点 / YYYY-MM-DDTHH:mm 指定时刻 / 周日 12:00 每周 / 30m 间隔延时' },
        entry_id: { type: 'string', description: '[cancel] 条目 id（list 可见）' },
      },
      required: ['action'],
    },
  },
  {
    name: 'update_agent_profile',
    description:
      '更新 Agent 档案（name/description/system/persona/tools/maxSteps/settings）。默认改自己，具备 admin 能力可改他人；name 是显示名称（名册/群聊展示），description 是一句话简介（不影响显示名）；persona 写入 Agent 目录 AGENTS.md。',
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
  },
];

const err = (msg: string): { ok: false; error: string } => ({ ok: false, error: msg });

/** timers 服务最小面（HostTimersService——宿主 timers 行在场即有） */
interface TimersFace {
  entries(owner: string): TimerEntry[];
  save(owner: string, entries: TimerEntry[]): void;
}

/** 宿主执行面（双闸之宿主闸）：身份复查 + 真执行 */
export function executeHostTool(
  ctx: Context,
  dataRoot: string,
  tool: string,
  args: Record<string, unknown>,
  identity: { agentId?: string; conversationId?: string },
): { ok: boolean; result?: unknown; error?: string } {
  if (tool === 'timer') return executeTimer(ctx, args, identity);
  if (tool === 'update_agent_profile') return executeProfile(dataRoot, args, identity);
  return err('未知远程工具: ' + tool);
}

/** timer：HostTimersService 的 LLM 面 */
function executeTimer(
  ctx: Context,
  args: Record<string, unknown>,
  identity: { agentId?: string; conversationId?: string },
): { ok: boolean; result?: unknown; error?: string } {
  const timers = ctx.get('timers', false) as TimersFace | undefined;
  if (timers === undefined) return err('timers 服务未装配（宿主行集无 timers 行）——定时工具不可用');
  const owner = identity.agentId;
  if (owner === undefined) return err('缺少执行身份（agentId）——timer 需在 Agent run 内调用');
  const action = String(args.action ?? '');
  if (action === 'list') {
    return {
      ok: true,
      result: {
        entries: timers.entries(owner).map((e) => ({
          id: e.id, mode: e.mode,
          time: e.time ?? e.delay ?? (e.delayMin !== undefined || e.delayMax !== undefined ? `${e.delayMin ?? '?'}-${e.delayMax ?? '?'}` : undefined),
          hint: e.hint, enabled: e.enabled,
        })),
      },
    };
  }
  if (action === 'cancel') {
    const id = String(args.entry_id ?? '');
    if (!id) return err('cancel 需要 entry_id');
    const current = timers.entries(owner);
    const next = current.filter((e) => e.id !== id);
    if (next.length === current.length) return err('条目不存在: ' + id);
    timers.save(owner, validateTimerEntries(next));
    return { ok: true, result: { cancelled: id } };
  }
  if (action === 'set') {
    const hint = String(args.hint ?? '').trim();
    const time = String(args.time ?? '').trim();
    if (!hint) return err('set 需要 hint（触发时携带的提示词）');
    if (!time) return err('set 需要 time（时间串）');
    const entry = parseTimerEntry(time, hint, identity.conversationId);
    if (entry === null) return err('无法解析时间串: ' + time + '（支持 HH:mm / YYYY-MM-DDTHH:mm / 周日 12:00 / 30m 间隔）');
    timers.save(owner, validateTimerEntries([...timers.entries(owner), entry]));
    return { ok: true, result: { entry_id: entry.id, mode: entry.mode, time: entry.time ?? entry.delay ?? undefined } };
  }
  return err('未知 action: ' + action);
}

/** 时间串 → 条目（词形与 ac-timer-core 同源；id = t-<随机>） */
function parseTimerEntry(time: string, hint: string, conversationId: string | undefined): TimerEntry | null {
  const id = 't-' + Math.random().toString(36).slice(2, 8);
  const base = { id, enabled: true, hint, ...(conversationId !== undefined ? { conversationId } : {}) } as Partial<TimerEntry>;
  if (/^\d+[smh]$/i.test(time)) {
    if (parseInterval(time) === null) return null;
    return { ...base, mode: 'delay', delay: time } as TimerEntry;
  }
  const weekly = time.match(/^(周一|周二|周三|周四|周五|周六|周日)\s*(\d{1,2}:\d{2})$/);
  if (weekly !== null) return { ...base, mode: 'time', time: `${weekly[1]} ${weekly[2]}` } as TimerEntry;
  if (/^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}$/.test(time)) return { ...base, mode: 'time', time } as TimerEntry;
  if (/^\d{1,2}:\d{2}$/.test(time)) return { ...base, mode: 'time', time } as TimerEntry;
  return null;
}

/** update_agent_profile：agents 树读改写（agents-core 纯库——与宿主编辑面同源） */
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
    next.settings = { ...(current.settings ?? {}), ...(fields.settings as Record<string, unknown>) };
    changed.push('settings');
  }

  writeAgentConfig(dataRoot, next); // 归一写口（tree.ts——与宿主编辑面同源）
  return { ok: true, result: { agent_id: targetId, changed, persisted: true } };
}
