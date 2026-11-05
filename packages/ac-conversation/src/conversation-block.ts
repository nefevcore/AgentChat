// ============================================================
// ac-conversation/src/conversation-block.ts —— CONVERSATION 段（cr-881，
// 自 ac-system-prompt 尾档对话信息块整体迁移——逻辑原样：sender 三态解析、
// 群成员表（user 隐式成员首位并入）、自会话对角线「机制触发」标注、
// 群场景不渲染 1v1 对话对象行（M26）。尾档 prepend 收敛式随段注册制退役，
// 次序由 CONVERSATION 具名位（900）承载——先于 DATETIME（910）恒定。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { displayNameOf } from 'ac-agents';

/** 群信息简化形状（ctx.group 可选能力解析） */
export interface ConversationGroupInput {
  name: string;
  members: string[];
  description?: string;
}

/** 对话信息块装配输入 */
interface ConversationBlockInput {
  sender?: string;
  source?: string;
  conversationId?: string;
  labelOf: (id: string) => string;
  group?: ConversationGroupInput | null;
}

/** 自会话对角线判定（conversationId = a~a）：「机制触发·自会话」标注的唯一适用面 */
function isSelfPairConversation(conversationId: string | undefined): boolean {
  if (!conversationId || !conversationId.includes('~')) return false;
  const [a, b] = conversationId.split('~');
  return a === b;
}

function buildConversationBlock(input: ConversationBlockInput): string {
  const lines: string[] = [];
  // 对话对象（方向句：`[当前对话对象] 你正在与 <显示名>（<id>）对话<注>`——
  // cr-808 方向句锚定「你」= 本 Agent，对端只剩一个实体）
  if (input.group) {
    // 群场景不渲染 1v1 对象行（M26）：群内 sender 逐消息变化 ≠ 对话对象；
    // 发言人由 <msg> 包装承载，群块给全貌
  } else if (input.sender !== undefined && input.sender !== '') {
    const shown = input.labelOf(input.sender);
    if (input.source === 'event' && isSelfPairConversation(input.conversationId)) {
      lines.push(`[当前对话对象] 你正在与 ${shown}（${input.sender}）对话（机制触发·自会话）`);
    } else {
      lines.push(`[当前对话对象] 你正在与 ${shown}（${input.sender}）对话`);
    }
  } else if (input.conversationId !== undefined) {
    lines.push(`[当前会话] ${input.conversationId}`);
  }

  const group = input.group;
  if (group) {
    lines.push(`[当前群聊] ${group.name}（${input.conversationId ?? ''}）`);
    // user 是隐式成员（永不入册）：成员表首位并入，展示面与发言面一致
    const members = group.members.includes('user') ? group.members : ['user', ...group.members];
    lines.push(`[群聊成员] ${members.map((m) => {
      const label = input.labelOf(m);
      return label !== m ? `${label} (${m})` : m;
    }).join('、')}`);
    if (group.description) lines.push(`[群聊简介] ${group.description}`);
    // 称呼引导：明示用名字称呼可抵消模型默认拿 id 指代成员的习惯
    lines.push('[群聊称呼] 与成员交流或提及成员时使用其显示名（成员表中的名字），不要用成员 id 指代。');
  }

  return lines.join('\n');
}

/** CONVERSATION 段注册（信封全空 = 子 Agent / loop 直连：无信息可报，不贡献） */
export function registerConversationSection(ctx: Context): void {
  ctx.agentLoop.registerPromptSection({
    name: 'CONVERSATION',
    text: (request) => {
      const convId = request.conversationId;
      // 可选能力：群信息（conversationId 命中群 → 群成员表）
      const groupSvc = ctx.get('group', false) as
        | { get(id: string): ConversationGroupInput | undefined }
        | undefined;
      const groupInfo = groupSvc && convId ? groupSvc.get(convId) : undefined;
      if (request.sender === undefined && convId === undefined && !groupInfo) return '';
      // 显示名单源 = 注册表（name ?? description——ac-agents 导出；回退端点 id）
      const agents = ctx.get('agents');
      const labelOf = agents
        ? (id: string) => displayNameOf(agents.get(id)) ?? id
        : (id: string) => id;
      return buildConversationBlock({
        sender: request.sender,
        source: request.source,
        conversationId: convId,
        labelOf,
        group: groupInfo ?? null,
      });
    },
  }, 'ac-conversation');
}