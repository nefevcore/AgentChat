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
//                     覆盖注册；persona 写 Agent 目录 AGENTS.md（文档
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
import { capabilitySetOf, displayNameOf, formDeniedBy, resolveToolNames, toolAllowedFor, widenToolsForGating } from 'ac-agents';
import { pairKey } from 'ac-agent-loop';
import type {} from 'ac-conversation'; // ConversationOutcome（type-only）
import type {} from 'ac-subagent'; // ctx.subagents 可选能力类型（type-only）
import type {} from 'ac-agent-store'; // ctx.agentStore 可选能力类型（type-only）

/** update_agent_profile 允许修改的字段（白名单；其余拒绝） */
const PROFILE_ALLOWED_FIELDS = ['name', 'description', 'system', 'persona', 'tools', 'maxSteps', 'settings'] as const;

function err(message: string): ToolResult {
  return { ok: false, error: message };
}

/** admin 能力判定（tags 单源——capabilities 覆盖层已随 access-tier §9.4 删除） */
function hasAdminCapability(agent: AgentConfig | undefined): boolean {
  if (agent === undefined) return false;
  return (agent.tags ?? []).includes('admin');
}

export const name = 'ac-collab-tools';

export const inject = ['tools', 'agents', 'conversation'];

/** @ 名称引用约定（@ 路径约定归 ac-fs-tools；此处为 Agent 对象语义）：
 *  list_agents/send_agent 的 owner 行教语法——条件安装（生效工具集同时含
 *  解析与投递两工具才注入）；只依赖工具集 → KV 前缀稳定。 */
const AGENT_MENTION_GUIDE =
  '[引用约定] 用户消息中的 @<名称>（非路径形态）是用户提到的其他 Agent：'
  + '用 list_agents 按名称解析出 id 后可经 send_agent 联系；解析不到时如实说明，不要虚构。';

/** wait=true 限时等待缺省（语法糖口径：常规对端 run 分钟级内；宿主墙钟兜底失控） */
const WAIT_TIMEOUT_MS = 60_000;

/**
 * 迟到回复薄通知（2026-09-23 send_agent 收敛；2026-12 修复回投目标）：
 * wait 超时后对端 run 跑完时，经 deliver（sender=owner、source=event
 * ——会话水位提权继承/MAX_AUTO_WAKES 防自激全走既有机制）唤醒发起方。
 * 回投目标 = 调用会话（call.conversationId——工具在哪个会话里执行，通知
 * 就回到哪个会话：用户在 user⇄a 会话里让 a 发起的等待，通知回到 user⇄a
 * 而非 a⇄b 委托桶，否则通知混进双方对话流、用户侧发起会话永远收不到
 * 唤醒）；无会话键（宿主直调 / 子 Agent run——其 run 不带 conversationId）
 * 回退 owner 自会话桶。对桶里已有回复正文（session 落账）——通知只指路
 * 不搬运，防双记录（job-wakeup followup notice 同款形态）。
 */
function notifyLateReply(
  ctx: Context,
  owner: string,
  convKey: string | undefined,
  to: string,
  failed?: string,
): Promise<unknown> {
  const notice = failed !== undefined
    ? '[系统通知] 你此前 send_agent(wait) 等待超时后，对方 "' + to + '" 执行失败（' + failed
      + '）——委托未达成，可另寻方案或稍后重试，不要原地空等。'
    : '[系统通知] 你此前 send_agent(wait) 等待超时后，对方已完成处理：回复已在与 "'
      + to + '" 的会话记录中，需要时查看该会话继续你的任务，不要重发消息。';
  const conversation = ctx.get('conversation', false) as
    | { deliver(agentId: string, message: string, options?: Record<string, unknown>): Promise<unknown> }
    | undefined;
  if (conversation === undefined) return Promise.resolve();
  return conversation.deliver(owner, notice, {
    sender: owner,
    source: 'event',
    ...(convKey !== undefined ? { conversationId: convKey } : {}),
  }).catch((err: unknown) => {
    ctx.logger.warn(`[collab-tools] 迟到回复通知 ${owner}（${convKey ?? owner + ' 自会话桶'}）失败: ${String(err)}`);
  });
}

export function apply(ctx: Context) {
  // ---- @ 名称引用指引（list_agents/send_agent 的 owner 行条件注入）----
  ctx.on('loop/before-run', (call, next) => {
    // PTC 门控面（widenToolsForGating 单源）：程序化 run 的 request.tools
    // 已收窄成 ['run_code']——按能力面展开判协作工具在场
    const names = new Set(widenToolsForGating(ctx, call.request.agent, call.request.conversationId, call.request.tools));
    if (names.has('list_agents') && names.has('send_agent')) {
      call.request = {
        ...call.request,
        system: call.request.system ? `${call.request.system}\n${AGENT_MENTION_GUIDE}` : AGENT_MENTION_GUIDE,
      };
    }
    return next();
  }, { description: '注入 @ 名称引用约定（Agent 有 list_agents+send_agent 时）' });

  // ---- send_agent：投递消息给另一 Agent（经会话状态机） ----
  // collab 标签（2026-09-16 全量标签化）：多 Agent 协作族门禁
  ctx.tools.register({
    name: 'send_agent',
    requiredTags: ['collab'],
    description:
      '给另一个 Agent（或自己）发消息。默认异步发出即返回（对方回复会作为新消息送达）；wait=true 是异步发送的语法糖——发起后最多等 timeout_ms 拿回复，超时不影响对方的处理（对方继续跑完，回复迟到时以系统通知注入会话）。虚拟 Agent（如 user）也可投递：消息直达用户本人，无自动回复。已 spawn 的子 Agent id（sub_ 前缀）也可作为目标：消息作为任务消息进入该子 Agent 的会话（限其父投递）。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标 Agent ID（含虚拟端点如 user；已 spawn 子 Agent 的 sub_ id 亦可）' },
        message: { type: 'string', description: '消息内容' },
        wait: { type: 'boolean', description: '是否等待回复（默认 false）。语法糖：发起后限时等待（timeout_ms，缺省 60s），超时即返回超时说明——不中断对方的处理，回复迟到会以系统通知送达（含对方执行失败的情形）。对端空闲直跑时随结果带回回复文本（reply 字段）；对端正忙时受理即返（steered/queued），不进入限时等待。' },
        timeout_ms: { type: 'number', description: '[wait=true] 等待上限毫秒（缺省 60000；超时返回引导说明，不中断对方——其回复迟到时以系统通知送达）。仅对端空闲直跑时生效；对端忙（受理即返）不适用', minimum: 0 },
      },
      required: ['to', 'message'],
    },
    async execute(args, call): Promise<ToolResult> {
      try {
        const to = String(args.to ?? '').trim();
        const message = String(args.message ?? '');
        const from = call.agentId;
        if (from === undefined) return err('缺少执行身份（agentId）——send_agent 需在 Agent run 内调用');
        if (!to) return err('缺少 to 参数');
        if (!message.trim()) return err('缺少 message 参数');
        if (!ctx.agents.has(to)) return err(`Agent "${to}" 未注册`);

        // ---- 子 Agent 发信身份归一（2026-12 修复）----
        // 执行身份 = sub_*（子 Agent 自己在 send_agent）时：对桶
        // pairKey(sub, to) 会造出"子 ⇄ 对端"幽灵会话——用户视角该对话
        // 不可见（UI 会话列表按父口径），回复也进不了子的任务收件箱
        // （子的上下文源 = subagents/<subId>.jsonl + inbox，非 session 桶）。
        // 归一：会话归属落到**父的口径**——普通 Agent 对桶 = pairKey(parent,
        // to)（用户在父⇄to 的既有会话里直接看到子的发言，行的 agent_id
        // 仍是 sub——中性入账认得出说话人）；虚拟端点（user 等）= 父的
        // 直答对桶（与用户本人的对话）。from（信封 sender）不变——事实
        // 说话人仍是 sub。
        const subagents = ctx.get('subagents');
        const fromSub = subagents !== undefined && from.startsWith('sub_') ? subagents.get(from) : undefined;
        const fromForPair = fromSub !== undefined ? fromSub.parentId : from;

        // ---- 子 Agent 直投分支（2026-09-16 news 事故复盘）----
        // to = 已 spawn 的子 Agent id（sub_*）：不经会话状态机，转投其任务
        // 收件箱（ctx.subagents.send——忙时排队/空闲开跑，回执经 job-wakeup
        // 回到发起会话）。父自投走原路径以外的一切 Agent 照旧 deliver。
        // 发信方也是子 Agent（sub → sub）时投递权限按其父判定（归一后
        // fromForPair = 发信子的父）。
        if (subagents !== undefined && to.startsWith('sub_')) {
          const info = subagents.get(to);
          if (info !== undefined) {
            if (info.parentId !== fromForPair) {
              return err(`"${to}" 是 Agent "${info.parentId}" 的子 Agent，只接收其父（或经父的 subagent 工具）的任务消息`);
            }
            try {
              const r = subagents.send(to, {
                parentId: fromForPair,
                text: message,
                // 回执直达发起会话（无会话键则回 owner 自会话桶——job-wakeup 缺省）
                ...(call.conversationId ? { conversationId: call.conversationId } : {}),
                ...(call.elevation === 'sandbox-access' || call.elevation === 'full-access' ? { elevation: call.elevation } : {}),
              });
              const hints: Record<string, string> = {
                started: '已作为新任务消息投递并启动 run——完成回执会回到本会话；正文与结果用 subagent(action="await", subagent_id) 查看',
                steered: '该子 Agent 正在执行——消息已注入其当前 run 的下一步',
                queued: '该子 Agent 正在执行——消息已排队（当前 run 收束后自动消费）',
              };
              return {
                ok: true,
                output: {
                  to,
                  subagent: true,
                  delivered: r.delivered,
                  message: hints[r.delivered],
                },
              };
            } catch (e: unknown) {
              return err(e instanceof Error ? e.message : String(e));
            }
          }
          // sub_ 前缀但注册表无此子 Agent：落入下方常规注册校验（报错口径
          // 统一为"未注册"，避免双份文案）
        }

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
            conversationId: pairKey(fromForPair, to),
          });
          return {
            ok: true,
            output: {
              to,
              virtual: true,
              message:
                `已投递给 "${to}"（虚拟端点 = 用户本人）：消息会出现在用户与${fromSub !== undefined ? `"${fromSub.parentId}"（你代表的团队/发起方）` : '你'}的对话中，` +
                '用户会看到但不会有自动回复——不要等待或重试，可在后续回复中继续说明。',
            },
          };
        }
        // 预设 Agent（__standard__ 等）是独立会话的路由目标，不是协作对象
        // （src 防幽灵会话语义——send_agent 委托会制造无主 pair 会话）
        if (target?.preset) return err(`Agent "${to}" 是预设 Agent（独立会话路由目标，不接收协作消息）`);

        // 委托对会话键（agent⇄agent 共享桶，双方视角同键）：pairKey 排序
        // 双向一致——发送方/接收方在会话流与用量弦图里对得上。
        // 发信方是子 Agent 时对桶归一到父（见上方归一注释）。
        const convKey = pairKey(fromForPair, to);
        // 历史播种：委托会话的此前消息（ac-session 回放；无 session 行 = 空）。
        // viewer=目标 Agent（M21/D1）：回放按读者投影——自己的话 assistant、
        // 对端的话 user（修 a⇄b 桶视角颠倒）
        const session = ctx.get('session');
        const history = session ? await session.history(convKey, { viewer: to }) : undefined;
        // 投递语义（2026-09-23 收敛）：wait=false 默认 steer（忙时注入活跃
        // run，受理即返回）；wait=true = placement next-run（等对端独立
        // run）+ 限时语法糖——超时即返回引导说明，**不中断对方**（不透传
        // signal：对端 run 由对端域的钟管辖，发起方不跨域代管）。
        const waitMs = args.wait === true ? Math.max(0, Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : WAIT_TIMEOUT_MS) : 0;
        const outcomeP = ctx.conversation.deliver(to, message, {
          sender: from,
          source: 'agent',
          conversationId: convKey,
          ...(history && history.length > 0 ? { history } : {}),
          ...(args.wait === true ? { placement: 'next-run' } : {}),
        });

        if (args.wait === true) {
          // 异步语法糖：限时等待对端 run 收束。超时不取消投递（deliver promise
          // 继续在后台完成）——回复迟到时以薄通知注入发起方会话（下方 then 分支）。
          const outcome = await Promise.race([
            outcomeP,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs)),
          ]);
          if (outcome === null) {
            // 超时：对方继续跑完（不中断）；回复迟到 → 薄通知唤醒（对桶已有
            // 回复正文，通知只指路不搬运——防双记录）。回投 = 调用会话
            // （call.conversationId；无会话键回退 owner 自会话桶）——不是
            // 委托桶 convKey：发起方的唤醒要落在发起地，否则通知混进
            // a⇄b 双方对话流、用户侧发起会话收不到。
            const wakeKey = call.conversationId ?? pairKey(from, from);
            void outcomeP.then((late) => {
              if (late === null || late === undefined || late.kind !== 'run') return;
              // 正常收束 → 指路通知；error 收束 → 失败通知（发起方不再空等，
              // 委托未达成的事实要送达——error 文本随通知，对桶另有完整记录）
              if (late.result.finish === 'error') {
                void notifyLateReply(ctx, from, wakeKey, to, late.result.error ?? '未知错误');
              } else {
                void notifyLateReply(ctx, from, wakeKey, to);
              }
            }).catch(() => { /* 投递失败静默——超时路径已收束 */ });
            return {
              ok: true,
              output: {
                to,
                wait: true,
                timed_out: true,
                message: `已投递并等待 ${waitMs}ms 未见回复（对方仍在处理，未受影响）。不要重发或重复等待：对方的回复会出现在会话中（迟到时以系统通知唤醒你），你现在可以继续其他工作或先给出阶段性结论。`,
              },
            };
          }
          if (outcome.kind === 'run') {
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
          // 忙态/排队等 outcome（steered/queued/timeout）——落入下方通用返回
        }
        const outcome = await outcomeP;
        // wait=false 空闲直达（2026-12 修复）：deliver 在对端空闲时本就
        // await 其完整 run 并随 outcome 携带回复——此前被丢弃并对调用方
        // 撒谎"回复会作为新消息送达"。子 Agent（sub_*）场景这是唯一回
        // 收通道（其上下文源是任务收件箱，非 session 对桶——对桶里 b 的
        // 回复永远不会以"新消息"形态回到子）；普通 Agent 场景回复文本
        // 直返也更诚实。忙态（steered/queued/timeout）语义不变。
        if (args.wait !== true && outcome.kind === 'run') {
          const run = outcome.result;
          if (run.finish === 'error') {
            return err(`对方执行失败: ${run.error ?? '未知错误'}`);
          }
          return {
            ok: true,
            output: {
              to,
              wait: false,
              reply: run.text,
              finish: run.finish,
              steps: run.steps.length,
              message: run.text
                ? '已投递并收到对方回复（见 reply 字段）。'
                : '已投递，对方未产生文本回复（可能仅执行了工具动作）。',
            },
          };
        }
        // 忙态受理即返（steered/queued）+ wait=true：限时等待未启用——对端在忙
        // 无法承诺回复时机，返回受理事实（回复照常作为新消息送达，别重发）。
        const waited = args.wait === true;
        return {
          ok: true,
          output: {
            to,
            wait: waited,
            outcome: outcome.kind,
            message:
              outcome.kind === 'steered'
                ? '对方正忙，消息已注入其当前 run 的下一步。'
                  + (waited ? '（忙态不进入限时等待：对方回复会作为新消息送达，不要重发或轮询等待）' : '')
                : outcome.kind === 'queued'
                  ? '对方正忙，消息已入队（当前 run 结束后处理）。'
                    + (waited ? '（忙态不进入限时等待：对方回复会作为新消息送达，不要重发或轮询等待）' : '')
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
    requiredTags: ['collab'],
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
        // 回执带群名与触发者显示名：模型下一轮引用成员时手边就有
        // id↔name 对照（不用回翻上下文找 <msg> 包装）
        const g = group.get(gid);
        const who = result.triggered.map((m) => {
          const label = displayNameOf(ctx.agents.get(m));
          return label !== undefined && label !== m ? `${label} (${m})` : m;
        });
        return {
          ok: true,
          output: {
            group_id: gid,
            group_name: g?.name ?? gid,
            triggered: result.triggered,
            message: `已投递到群「${g?.name ?? gid}」，触发 ${result.triggered.length} 个参与者：${who.join('、')}。`,
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
    requiredTags: ['collab'],
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
            ...(a.name ? { name: a.name } : {}),
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
    requiredTags: ['collab'],
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
              // 完整参与面（含隐式成员 user）+ 显示名对照——提及成员
              // 用显示名，勿用 id 指代（用户视角自然称呼）
              members: group.membersWithUser(g.id).map((m) => {
                const label = displayNameOf(ctx.agents.get(m));
                return label !== undefined && label !== m ? { id: m, name: label } : { id: m };
              }),
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
  // infra 标签：自省工具属会话基础设施（不挂 collab——单 Agent 也需要
  // 查自己的工具面，挂 collab 会让无协作标签的 Agent 失去自省能力）
  ctx.tools.register({
    name: 'list_tools',
    requiredTags: ['infra'],
    description: '列出自己可用的全部工具。',
    parameters: { type: 'object', properties: {} },
    async execute(args, call): Promise<ToolResult> {
      const self = call.agentId ? ctx.agents.get(call.agentId) : undefined;
      // 可见面与 router 信封同口径（2026-09-02 反馈 #1）：能力门禁
      // （requiredTags 缺标签不可见）+ mode 工具排除（injection 轴——
      // 不进常规面）+ 交互面（requiresInteraction——self 会话排除，
      // formDeniedBy 单源）先过滤，再按 AgentConfig.tools 解析
      const caps = capabilitySetOf(ctx, call.agentId);
      const all = ctx.tools.list().filter(
        (t) => t.injection !== 'mode' && toolAllowedFor(t, caps) && !formDeniedBy(ctx, t, call.conversationId),
      );
      // 解析传 defs（tag 引用 'tag:<tag>' 展开——与 router 同口径）
      const effectiveNames = resolveToolNames(self?.tools, all);
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
    requiredTags: ['collab'],
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
        ...(info.name ? { name: info.name } : {}),
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
    requiredTags: ['collab'],
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
        // 预设/派生身份不可编辑（与 send_agent 拒投预设同口径）：子 Agent
        // 派生条目（preset:true）若可自助改 tags 加回 delegation/admin，
        // 会突破 spawn 时的剥减防线（递归 spawn / 宿主级动作）。
        if (current.preset) return err(`Agent "${targetId}" 是预设/派生身份（运行时物化），不可经 update_agent_profile 修改`);
        if (targetId !== selfId && !hasAdminCapability(ctx.agents.get(selfId))) {
          return err(`仅具备 admin 能力的 Agent 可修改他人档案（目标 "${targetId}"）`);
        }

        const store = ctx.get('agentStore');
        const persisted = store ? store.getAgent(targetId) : undefined;

        // 合并目标配置：持久化态（全量）优先，否则内存态
        const base: AgentConfig = persisted ?? { ...current };
        const next: AgentConfig = { ...base };
        const changed: string[] = [];

        if (fields.name !== undefined) {
          const name = String(fields.name).trim();
          // 清空 = 回落显示链 description ?? id（与 description 可独立清除）
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

        // persona：写 Agent 目录 AGENTS.md（文档唯一写口；2026-11 对齐生态
        // 事实标准 AGENTS.md——ac-persona 装载侧读 AGENTS.md 优先、AGENT.md
        // 存量回退，旧名文档不遮蔽新写内容）+ 挂载人设装载
        if (fields.persona !== undefined) {
          const persona = String(fields.persona ?? '').trim();
          if (!persona) return err('persona 不能为空');
          if (!store) return err('持久化档案更新需要 ac-agent-store 行（persona 写 AGENTS.md）');
          store.saveDoc(targetId, 'AGENTS.md', `# 人物设定\n\n${persona}\n`);
          const settings = { ...(next.settings ?? {}) };
          const existing = settings['persona'];
          const shape =
            existing !== undefined && existing !== null && typeof existing === 'object'
              ? (existing as Record<string, unknown>)
              : {};
          settings['persona'] = { ...shape, file: 'AGENTS.md' };
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
