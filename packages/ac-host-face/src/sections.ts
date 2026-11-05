// ============================================================
// ac-host-face/src/sections.ts —— 远程段清单（cr-886）
//
// 段主体文本自 cr-881 各 owner 行同源（措辞基线不动——改措辞 = 显式改测试）。
// 门控声明式（toolsAll/toolsAny/notSingle），壳侧 client 展开。
// 具名段位引用 SECTION_ORDER 键名——位次单源住壳 ac-agent-loop/sections.ts。
//
// 注意：壳侧 ac-collab-tools 行仍注册 TERMINOLOGY/GUIDELINES_COLLAB/
// REFERENCE_AGENT/GROUP_CONTRACT 段（本地段优先）——宿主远程段是**补位面**：
// 壳行缺位（行集不含 collab-tools）或未装时的同源兜底。timer 段壳内无 owner，
// 仅宿主提供。
// ============================================================
import type { HostFaceSectionSpec } from 'ac-host-face-core';

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
  {
    name: 'GUIDELINES_TIMER',
    text: '主动安排：发现值得持续跟进或适时提醒的事项时，主动用 timer(action="set") 安排，不必等用户指令。',
    gate: { toolsAny: ['timer'], notSingle: true },
  },
];