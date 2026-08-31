// ============================================================
// ac-collab-tools —— Agent 协作工具行（M14）
//
// src 轨道映射（agent-tools 七件，地图 §3.2）：
//   send_agent      → ctx.conversation.deliver(sender:'agent')——
//                     串行化门/steer 注入/next-run 链跑全由会话状态机
//                     承担（ADR-1）；wait=true = 等独立 run 拿回复
//   send_group      → ctx.group.send（可选能力：群行未装时报错）
//   list_agents     → ctx.agents.list（Agent 是数据）
//   list_groups     → ctx.group.listForAgent（执行身份定"自己"）
//   list_tools      → AgentConfig.tools 白名单 ?? 全部已注册工具
//   read_agent_info → ctx.agents.get（model/provider/settings 仅自查——
//                     查他人不暴露模型配置，src 脱敏语义）
//   update_agent_profile → ctx.agentStore 落盘（可选能力）+ ctx.agents
//                     覆盖注册；persona 写 Agent 目录 AGENT.md（文档
//                     唯一写口）并挂载人设装载；改他人需 admin 能力
//
// 形态差异（地图认可）：src 的"身份工厂烘焙"（from=config.agent_id）
// 被 M11 执行身份取代——工具体从 call.agentId 读身份；来源标签钩子族
// 被信封 sender + name 标注净删除。已知语义差：read_agent_info 不带
// "我对其印象"（preview 记忆键 = conversationId 会话桶，无 per-target
// 印象桶——M15 对账项）。
//
// M18 变更：send_agent 目标为虚拟 Agent（viewer）不再拒绝——放行投递，
// 返回明确引导"无自动回复，不要等待"。src 的拒绝语义是防幽灵会话
// （wait=true 会等一个永不存在的回复）；preview 等闲投放零成本、引导
// 直说，放行更贴合"掷骰随机选目标"等前端交互。
//
// M19 变更：会话键统一对桶 pairKey(from, to)——目标是虚拟端点时天然落
// viewer 对桶（与用户直答同桶，用户在与发送方的对话里看到），虚拟端点
// 分支只剩"无回复"提示语；ac-session 按说话人 name 标注入账。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import type { AgentConfig } from 'ac-agents';
import { resolveToolNames } from 'ac-agents';
import { pairKey } from 'ac-agent-loop';
import type {} from 'ac-conversation'; // ConversationOutcome（type-only）
import type {} from 'ac-agent-store'; // ctx.agentStore 可选能力类型（type-only）

/** update_agent_profile 允许修改的字段（白名单；其余拒绝） */
const PROFILE_ALLOWED_FIELDS = ['description', 'system', 'persona', 'tools', 'maxSteps', 'settings'] as const;

function err(message: string): ToolResult {
  return { ok: false, error: message };
}

/** admin 能力判定（M24 X4：tags 单源；settings.security.capabilities 为
 *  追加覆盖层——两处任一命中即可，与 ac-security 门禁同语义） */
function hasAdminCapability(ctx: Context, agent: AgentConfig | undefined): boolean {
  if (agent === undefined) return false;
  if ((agent.tags ?? []).includes('admin')) return true;
  const security = ctx.agents.settingsOf(agent.id, 'security');
  if (security !== undefined && security !== null && typeof security === 'object') {
    const caps = (security as { capabilities?: unknown }).capabilities;
    if (Array.isArray(caps)) return caps.includes('admin');
  }
  return false;
}

export const name = 'ac-collab-tools';

export const inject = ['tools', 'agents', 'conversation'];

export function apply(ctx: Context) {
  // ---- send_agent：投递消息给另一 Agent（经会话状态机） ----
  ctx.tools.register({
    name: 'send_agent',
    description:
      '给另一个 Agent（或自己）发消息。默认异步发出即返回（对方回复会作为新消息送达）；wait=true 等待对方独立回复。虚拟 Agent（如 user）也可投递：消息直达用户本人，无自动回复。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标 Agent ID' },
        message: { type: 'string', description: '消息内容' },
        wait: { type: 'boolean', description: '是否等待回复（默认 false；等待时对方忙则排队独立 run）' },
      },
      required: ['to', 'message'],
    },
    async execute(args, call): Promise<ToolResult> {
      try {
        const to = String(args.to ?? '').trim();
        const message = String(args.message ?? '');
        if (!to) return err('缺少 to 参数');
        if (!message.trim()) return err('缺少 message 参数');
        if (!ctx.agents.has(to)) return err(`Agent "${to}" 未注册`);

        const from = call.agentId;
        if (from === undefined) return err('缺少执行身份（agentId）——send_agent 需在 Agent run 内调用');

        const target = ctx.agents.get(to);
        // 虚拟端点（viewer 等会话端点）：允许投递（M18 前端反馈 #9——
        // 随机选目标掷到 viewer 不应整单失败）。M19 统一 pairKey(from, to)：
        // to 是虚拟端点时天然落 viewer 对桶（与用户直答同桶），仅剩
        // "无回复"提示语按 target.virtual 生成。虚拟端点无 LLM——不
        // 回复是正常态。
        if (target?.virtual) {
          await ctx.conversation.deliver(to, message, {
            sender: from,
            source: 'agent',
            conversationId: pairKey(from, to),
          });
          return {
            ok: true,
            output: {
              to,
              virtual: true,
              message:
                `已投递给 "${to}"（虚拟端点 = 用户本人）：消息会出现在用户与你的对话中，` +
                '用户会看到但不会有自动回复——不要等待或重试，可在后续回复中继续说明。',
            },
          };
        }
        // 预设 Agent（__standard__ 等）是独立会话的路由目标，不是协作对象
        // （src 防幽灵会话语义——send_agent 委托会制造无主 pair 会话）
        if (target?.preset) return err(`Agent "${to}" 是预设 Agent（独立会话路由目标，不接收协作消息）`);

        // 委托对会话键（agent⇄agent 共享桶，双方视角同键）：pairKey 排序
        // 双向一致——发送方/接收方在会话流与用量弦图里对得上。
        const convKey = pairKey(from, to);
        // 历史播种：委托会话的此前消息（ac-session 回放；无 session 行 = 空）。
        // viewer=目标 Agent（M21/D1）：回放按读者投影——自己的话 assistant、
        // 对端的话 user（修 a⇄b 桶视角颠倒）
        const session = ctx.get('session');
        const history = session ? await session.history(convKey, { viewer: to }) : undefined;
        // wait=true：等独立 run（placement next-run：对方忙则等空闲，
        // 回复文本随 outcome 返回）；wait=false：默认 steer（忙时注入
        // 活跃 run，受理即返回——对齐 src 异步语义）
        const outcome = await ctx.conversation.deliver(to, message, {
          sender: from,
          source: 'agent',
          conversationId: convKey,
          ...(history && history.length > 0 ? { history } : {}),
          ...(args.wait === true ? { placement: 'next-run' } : {}),
        });

        if (args.wait === true && outcome.kind === 'run') {
          const run = outcome.result;
          if (run.finish === 'error') return err(`对方执行失败: ${run.error ?? '未知错误'}`);
          return {
            ok: true,
            output: {
              to,
              wait: true,
              reply: run.text,
              finish: run.finish,
              steps: run.steps.length,
            },
          };
        }
        return {
          ok: true,
          output: {
            to,
            wait: false,
            outcome: outcome.kind,
            message:
              outcome.kind === 'steered'
                ? '对方正忙，消息已注入其当前 run 的下一步。'
                : outcome.kind === 'queued'
                  ? '对方正忙，消息已入队（当前 run 结束后处理）。'
                  : outcome.kind === 'timeout'
                    ? '对方持续繁忙，等待空闲超时——消息未投递。'
                    : '已投递，对方回复会作为新消息送达。',
          },
        };
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ---- send_group：群内发言（可选 ctx.group） ----
  ctx.tools.register({
    name: 'send_group',
    description: '在群组里发消息，群内其他成员会自主决定是否回应。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '群组 ID' },
        message: { type: 'string', description: '消息内容' },
      },
      required: ['group_id', 'message'],
    },
    async execute(args, call): Promise<ToolResult> {
      try {
        const group = ctx.get('group');
        if (!group) return err('群服务（ac-group 行）未装载——send_group 不可用');
        const from = call.agentId;
        if (from === undefined) return err('缺少执行身份（agentId）——send_group 需在 Agent run 内调用');
        const gid = String(args.group_id ?? '').trim();
        const message = String(args.message ?? '');
        if (!gid) return err('缺少 group_id 参数');
        if (!message.trim()) return err('缺少 message 参数');
        if (!group.isMember(gid, from)) return err(`你不是群 "${gid}" 的成员（先确认 group_id）`);
        const result = await group.send(gid, from, message);
        return {
          ok: true,
          output: {
            group_id: gid,
            triggered: result.triggered,
            message: `已投递到群 ${gid}，触发 ${result.triggered.length} 个参与者。`,
          },
        };
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ---- list_agents：Agent 清单 ----
  ctx.tools.register({
    name: 'list_agents',
    description: '列出所有 Agent（含虚拟 Agent 标注）。',
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      // 预设 Agent 不进协作清单（单会话路由目标，不是协作对象——src 同款过滤）
      const list = ctx.agents.list().filter((a) => a.preset !== true);
      return {
        ok: true,
        output: {
          count: list.length,
          agents: list.map((a) => ({
            id: a.id,
            ...(a.description ? { description: a.description } : {}),
            ...(a.virtual ? { virtual: true } : {}),
          })),
        },
      };
    },
  });

  // ---- list_groups：自己所在的群 ----
  ctx.tools.register({
    name: 'list_groups',
    description: '列出自己所在的群组。',
    parameters: { type: 'object', properties: {} },
    async execute(args, call): Promise<ToolResult> {
      try {
        const group = ctx.get('group');
        if (!group) return err('群服务（ac-group 行）未装载——list_groups 不可用');
        const self = call.agentId;
        if (self === undefined) return err('缺少执行身份（agentId）');
        const groups = group.listForAgent(self);
        return {
          ok: true,
          output: {
            count: groups.length,
            groups: groups.map((g) => ({
              id: g.id,
              name: g.name,
              members: g.members,
              ...(g.description ? { description: g.description } : {}),
            })),
          },
        };
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ---- list_tools：自己实际可用的工具 ----
  ctx.tools.register({
    name: 'list_tools',
    description: '列出自己可用的全部工具。',
    parameters: { type: 'object', properties: {} },
    async execute(args, call): Promise<ToolResult> {
      const self = call.agentId ? ctx.agents.get(call.agentId) : undefined;
      const all = ctx.tools.list();
      // 生效集解析（M15：与 router 信封构建同一函数——含 include/exclude 合并）
      const effectiveNames = resolveToolNames(self?.tools, all.map((t) => t.name));
      const effective =
        effectiveNames === undefined ? all : all.filter((t) => effectiveNames.includes(t.name));
      return {
        ok: true,
        output: {
          count: effective.length,
          ...(effectiveNames !== undefined ? { note: '按 AgentConfig.tools 解析的生效集' } : {}),
          tools: effective.map((t) => ({
            name: t.name,
            ...(t.description ? { description: String(t.description).split('\n')[0].slice(0, 80) } : {}),
          })),
        },
      };
    },
  });

  // ---- read_agent_info：读取 Agent 资料（不传 agent_id 看自己） ----
  ctx.tools.register({
    name: 'read_agent_info',
    description: '查看一个 Agent 的资料（不传 agent_id 看自己；模型配置仅自查可见）。',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: '目标 Agent ID（可选，默认自己）' },
      },
    },
    async execute(args, call): Promise<ToolResult> {
      const selfId = call.agentId;
      const targetId = typeof args.agent_id === 'string' && args.agent_id.trim() ? args.agent_id.trim() : selfId;
      if (!targetId) return err('缺少 agent_id 参数且无执行身份');
      const info = ctx.agents.get(targetId);
      if (!info) return err(`Agent "${targetId}" 未找到`);

      const isSelf = targetId === selfId;
      const output: Record<string, unknown> = {
        agent_id: info.id,
        type: info.virtual ? '虚拟 Agent' : 'Agent',
        ...(info.description ? { description: info.description } : {}),
      };
      // 模型/工具/settings 配置仅自查返回（查他人不暴露——src 脱敏语义）
      if (isSelf) {
        output.model = info.model ?? '(未配置)';
        if (info.provider) output.provider = info.provider;
        if (info.tools) output.tools = info.tools;
        if (info.maxSteps != null) output.max_steps = info.maxSteps;
        if (info.settings) output.settings_keys = Object.keys(info.settings);
      }
      return { ok: true, output };
    },
  });

  // ---- update_agent_profile：更新档案（admin 可改他人） ----
  ctx.tools.register({
    name: 'update_agent_profile',
    description:
      '更新 Agent 档案（description/system/persona/tools/maxSteps/settings）。默认改自己，具备 admin 能力可改他人；persona 写入 Agent 目录 AGENT.md。',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: '目标 Agent（默认自己；仅 admin 可改他人）' },
        fields: {
          type: 'object',
          description: '要更新的字段',
          properties: {
            description: { type: 'string', description: '简短描述' },
            system: { type: 'string', description: '基础系统提示词' },
            persona: { type: 'string', description: '人物设定（写入 Agent 目录 AGENT.md 并挂载 persona 装载）' },
            tools: { type: 'array', items: { type: 'string' }, description: '工具白名单（空数组/缺省 = 全部）' },
            maxSteps: { type: 'number', description: '步数预算（0 = 不限）' },
            settings: { type: 'object', description: '具名扩展设置（settings[具名]——已装插件在该 Agent 的行为）' },
          },
        },
      },
      required: ['fields'],
    },
    async execute(args, call): Promise<ToolResult> {
      try {
        const selfId = call.agentId;
        if (selfId === undefined) return err('缺少执行身份（agentId）');
        const targetId =
          typeof args.agent_id === 'string' && args.agent_id.trim() ? args.agent_id.trim() : selfId;
        const fields = (args.fields ?? {}) as Record<string, unknown>;
        const keys = Object.keys(fields);
        if (keys.length === 0) return err('fields 参数不能为空');

        const invalid = keys.filter((k) => !(PROFILE_ALLOWED_FIELDS as readonly string[]).includes(k));
        if (invalid.length > 0) {
          return err(
            `不允许修改：${invalid.join(', ')}。只能修改：${PROFILE_ALLOWED_FIELDS.join(', ')}。`,
          );
        }

        const current = ctx.agents.get(targetId);
        if (!current) return err(`Agent "${targetId}" 未找到`);
        if (targetId !== selfId && !hasAdminCapability(ctx, ctx.agents.get(selfId))) {
          return err(`仅具备 admin 能力的 Agent 可修改他人档案（目标 "${targetId}"）`);
        }

        const store = ctx.get('agentStore');
        const persisted = store ? store.getAgent(targetId) : undefined;

        // 合并目标配置：持久化态（全量）优先，否则内存态
        const base: AgentConfig = persisted ?? { ...current };
        const next: AgentConfig = { ...base };
        const changed: string[] = [];

        if (fields.description !== undefined) {
          next.description = String(fields.description);
          changed.push('description');
        }
        if (fields.system !== undefined) {
          next.system = String(fields.system);
          changed.push('system');
        }
        if (fields.tools !== undefined) {
          const tools = Array.isArray(fields.tools)
            ? fields.tools.filter((t): t is string => typeof t === 'string')
            : undefined;
          if (tools === undefined) return err('tools 字段须为字符串数组');
          if (tools.length === 0) delete next.tools;
          else next.tools = tools;
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
          next.settings = { ...(base.settings ?? {}), ...(fields.settings as Record<string, unknown>) };
          changed.push('settings');
        }

        // persona：写 Agent 目录 AGENT.md（文档唯一写口）+ 挂载人设装载
        if (fields.persona !== undefined) {
          const persona = String(fields.persona ?? '').trim();
          if (!persona) return err('persona 不能为空');
          if (!store) return err('持久化档案更新需要 ac-agent-store 行（persona 写 AGENT.md）');
          store.saveDoc(targetId, 'AGENT.md', `# 人物设定\n\n${persona}\n`);
          const settings = { ...(next.settings ?? {}) };
          const existing = settings['persona'];
          const shape =
            existing !== undefined && existing !== null && typeof existing === 'object'
              ? (existing as Record<string, unknown>)
              : {};
          settings['persona'] = { ...shape, file: 'AGENT.md' };
          next.settings = settings;
          changed.push('persona');
        }

        // 落盘（持久化 Agent）+ 内存覆盖注册（M15：reassign——不挂本行 fiber，
        // 改档案的生命周期归持久化数据，不随工具行卸载连带删除）
        if (store && persisted) store.saveAgent(next);
        ctx.agents.reassign(next);

        return {
          ok: true,
          output: {
            agent_id: targetId,
            changed,
            persisted: Boolean(store && persisted),
            ...(store && persisted ? {} : { note: '该 Agent 无持久化目录——仅内存生效（重启丢失）' }),
          },
        };
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
}
