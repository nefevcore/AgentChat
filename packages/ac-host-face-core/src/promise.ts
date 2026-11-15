// ============================================================
// ac-host-face-core/src/promise.ts —— host-face 静态承诺面（cr-1114 批1）
//
// 「boot 期承诺名与形，run 期兑现连与果」：宿主能力面在壳侧的静态投影。
// spec 双方同源——壳侧 boot 同步注册代理工具/远程段直取本常量（零 I/O、
// 零 ipc），宿主行 discover 回契约同源引用（单一事实源；execute 与段门控
// 语义仍各住实现面）。纯静态数据——不依赖宿主进程在场。
// ============================================================

import type { HostFaceToolSpec, HostFaceSectionSpec } from './contract.ts';

/**
 * 远程工具静态 spec（timer / update_agent_profile——cr-886 词面基线）。
 * 与注册面 ToolDefinition 同形（name/description/parameters/requiredTags/
 * needPermission）。requiredTags:['infra'] = 壳闸门禁面（capabilitySetOf
 * 门控消费——与本地行同闸）。
 */
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

/**
 * 承诺面段（cr-1114 批1）：壳内恒无本地 owner——boot 同步注册静态文本
 *（段内容是静态常量，与工具 spec 同批下沉）。
 */
export const HOST_FACE_PROMISE_SECTIONS: HostFaceSectionSpec[] = [
  {
    name: 'GUIDELINES_TIMER',
    text: '主动安排：发现值得持续跟进或适时提醒的事项时，主动用 timer(action="set") 安排，不必等用户指令。',
    gate: { toolsAny: ['timer'] }, // cr-944 C：去 notSingle（主动提醒恰在 singles 最有用）
  },
];

/**
 * 远程段静态 spec（cr-886 词面基线）。段主体文本与 owner 行同源（改措辞 =
 * 显式改测试）。门控声明式（toolsAll/toolsAny/notSingle）——壳侧 client
 * 展开。具名段位引用 SECTION_ORDER 键名（位次单源住壳 ac-agent-loop/sections.ts）。
 *
 * 注意：TERMINOLOGY / GUIDELINES_COLLAB 在壳内有本地 owner（ac-collab-tools
 * 同名段），宿主远程段是补位面（本地优先——行集不含 collab-tools 时兜底，
 * 由对账注册承载，不进 boot 承诺面——先装占位会反向饿死本地 owner 的
 * fail-loud 注册）。GUIDELINES_TIMER 壳内无 owner，恒由宿主提供（承诺面）。
 */
export const HOST_FACE_SECTIONS: HostFaceSectionSpec[] = [
  {
    name: 'TERMINOLOGY',
    text: '术语约定：Agent — 本系统中所有对话参与者的统称，包括普通 Agent（AI 实体）和虚拟 Agent（用户）。send_agent、list_agents、read_agent_info 均可操作任意 Agent；update_agent_profile 默认更新自己，具备 admin 能力可更新其他 Agent。',
    gate: {
      toolsAny: ['send_agent', 'list_agents', 'send_group', 'list_groups', 'list_tools', 'read_agent_info', 'update_agent_profile'],
      notSingle: true,
    },
  },
  {
    name: 'GUIDELINES_COLLAB',
    text: '多Agent协作：先 list_agents 找对象，再 send_agent 发消息。对端空闲时回复文本随结果直返（reply 字段）；对端正忙时消息注入或排队，回复会作为新消息到达。wait=true 用于明确要求对方忙时也排队独立 run 等回复。\n群聊协作：先 list_groups 查看所在群组，再 send_group 发消息。',
    gate: {
      toolsAll: ['list_agents', 'send_agent'],
      notSingle: true,
    },
  },
  ...HOST_FACE_PROMISE_SECTIONS,
];
