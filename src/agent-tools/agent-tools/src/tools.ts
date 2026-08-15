// ============================================================
// src/plugins/builtin/tools/agent.ts —— Agent 协作工具
//
// 迁移自旧 mod 的 tools/{send_agent,send_group,list_agents,list_groups,
// list_tools,read_agent_info,update_agent_profile}，按领域聚合为一个文件。
//
// 身份（from=config.agent_id）工厂烘焙，替代旧 send_agent_from/send_group_from
// 拦截器；router 经 ToolContext 注入（替代旧 getAppState() 全局单例）。
//
// 依赖方向：仅依赖本层 shared + @agents/config + @core/types + define-tool + 本层 types + Node 内置。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { defineTool } from '@agentchat/toolkit';
import { collectToolNames } from '@agentchat/agent-config';
import { loadMemory } from '@agentchat/agent-memory';
import { chatDialogKey } from '@agentchat/tools';
import type { AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';

/** 发送消息给另一个 Agent（身份 from=config.agent_id 工厂烘焙） */
export function makeSendAgentTool(config: AgentConfig, services: ToolContext): Tool {
  const from = config.agent_id;
  return defineTool({
    name: 'send_agent', label: '发送给 Agent', requires: ['agent'],
    description: '向另一个 Agent 发送消息。默认异步投递（fire-and-forget，立即返回，不等待对方回复——对方回复时会作为新消息送达你）。设 wait=true 则阻塞等待对方回复后返回。适用于：委托任务、请教问题、协作分工。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标 Agent ID（用 list_agents 查看可用 Agent）' },
        message: { type: 'string', description: '要发送的消息内容' },
        wait: { type: 'boolean', description: '是否阻塞等待对方回复（默认 false=异步投递立即返回；true=等待回复）。异步模式下对方回复会作为新消息送达你，无需等待。' },
        no_wait: { type: 'boolean', description: '[旧名] 是否异步投递（默认 true）。与 wait 相反：no_wait=true 等价 wait=false。新代码请用 wait。' },
      },
      required: ['to', 'message'],
    },
    execute: async ({ to, message, wait, no_wait }) => {
      const router = services.router;
      if (!router) return '[send_agent] 错误：router 未注入 ToolContext';
      const msg = { from, to, type: 'request' as const, payload: message };
      // wait 为新规范参数；no_wait 为旧名别名（兼容：no_wait=false 亦表示等待）
      const shouldWait = wait === true || no_wait === false;
      if (shouldWait) return router.send(msg);
      return router.sendAsync(msg);
    },
    extractLabel: (args) => `${args.to || '?'}`,
  });
}

/** 发送消息到群组（触发其他参与者） */
export function makeSendGroupTool(config: AgentConfig, services: ToolContext): Tool {
  const from = config.agent_id;
  return defineTool({
    name: 'send_group', label: '发送到群组', requires: ['agent'],
    description: '向群组发送消息，群内其他参与者会自主判断是否回应。返回触发回应的参与者数量。需要先用 list_groups 查看自己所在群组。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '群组 ID（用 list_groups 查看）' },
        message: { type: 'string', description: '消息内容' },
      },
      required: ['group_id', 'message'],
    },
    execute: async ({ group_id, message }) => {
      const gm = services.router?.getGroupManager();
      if (!gm) return '[send_group] 错误：群组管理器不可用';
      const result = await gm.deliverGroupMessage({ from, to: '*', type: 'chat.send', payload: message, group_id });
      return `已投递到群组 ${group_id}，触发 ${result.triggered.length} 个参与者`;
    },
    extractLabel: (args) => `群:${args.group_id || '?'}`,
  });
}

/** 列出所有 Agent（经 router.getRegistry） */
export function makeListAgentsTool(services: ToolContext): Tool {
  return defineTool({
    name: 'list_agents', label: 'Agent 清单', requires: ['agent'],
    description: '列出所有可用 Agent 的 ID、名称和类型（虚拟/真实）。用于：找到可协作/求助的对象（配合 send_agent）、确认某个 Agent 是否存在。',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const registry = services.router?.getRegistry();
      if (!registry) return '[list_agents] 错误：router 未注入 ToolContext';
      const ids = registry.listIds();
      const list = ids
        .map(id => `- ${id}: ${registry.getAgentName(id)}（${registry.isVirtual(id) ? '虚拟' : 'Agent'}）`)
        .join('\n');
      return `共 ${ids.length} 个 Agent\n${list}`;
    },
  });
}

/** 列出当前 Agent 所在的所有群组（经 router.getGroupManager.listGroupsForAgent） */
export function makeListGroupsTool(config: AgentConfig, services: ToolContext): Tool {
  return defineTool({
    name: 'list_groups', label: '群组清单', requires: ['agent'],
    description: '列出当前 Agent 所在的全部群组及其参与者',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const gm = services.router?.getGroupManager();
      if (!gm) return '[list_groups] 错误：群组管理器不可用';
      const groups = gm.listGroupsForAgent(config.agent_id);
      const list = groups
        .map(g => `- ${g.group_id}（${g.name}）：${g.participants.join(', ')}`)
        .join('\n');
      return `共 ${groups.length} 个群组\n${list}`;
    },
  });
}

/** 列出当前 Agent 实际启用的工具（services.tools = resolveTools 完整结果，含 requires 自动注入） */
export function makeListToolsTool(config: AgentConfig, services: ToolContext): Tool {
  return defineTool({
    name: 'list_tools', label: '工具清单', requires: ['agent'],
    description: '列出当前 Agent 实际启用的全部工具及简短说明（含 requires 自动注入的协作/平台工具）。用于回顾自己有哪些能力、判断某任务用哪个工具。',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      // services.tools 由 L5 每次投递时写入 resolveTools 完整结果（自动注入 + 显式声明）
      const map = services.tools;
      if (map && map.size > 0) {
        const names = [...map.keys()].sort();
        const lines = names.map(n => {
          const tool = map.get(n);
          const label = tool?.label ? `${tool.label}` : '';
          const desc = tool?.description ? tool.description.split('\n')[0].slice(0, 60) : '';
          return `- ${n}${label ? `（${label}）` : ''}${desc ? `: ${desc}` : ''}`;
        });
        return `当前启用 ${lines.length} 个工具：\n${lines.join('\n')}`;
      }
      const names = config.tools ?? (collectToolNames(config.plugins) ?? []);
      return `当前启用 ${names.length} 个工具：\n${names.map(n => `- ${n}`).join('\n')}`;
    },
  });
}

/** 读取 Agent 公开信息（经 router.getRegistry；不传 agent_id 读自己） */
export function makeReadAgentInfoTool(config: AgentConfig, services: ToolContext): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'read_agent_info', label: '读取 Agent 信息', requires: ['agent'],
    description: '读取指定 Agent 的公开信息（名称/类型/标签/LLM）；不传 agent_id 读取自己的档案。查他人额外返回你对该 Agent 的印象（记忆）',
    parameters: {
      type: 'object',
      properties: { agent_id: { type: 'string', description: '目标 Agent ID（可选，默认自己）' } },
    },
    execute: async ({ agent_id }) => {
      const registry = services.router?.getRegistry();
      if (!registry) return '[read_agent_info] 错误：router 未注入 ToolContext';
      const target = (agent_id as string) ?? selfId;
      const info = registry.get(target);
      if (!info) return `[read_agent_info] Agent "${target}" 未找到`;
      const llmDesc = typeof info.llm === 'string' ? info.llm : (info.llm?.provider ?? '未配置');
      const isSelf = target === selfId;
      const lines = [
        `agent_id: ${info.agent_id}`,
        `name: ${info.name}`,
        `type: ${info.virtual ? '虚拟' : 'Agent'}`,
        `tags: ${(info.tags ?? []).join(', ') || '(无)'}`,
      ];
      // llm：仅查自己返回（脱敏由 registry 配置承载）；查他人不暴露对方模型配置
      if (isSelf) lines.push(`llm: ${llmDesc}`);

      // 查他人：附加"我"对该 Agent 的印象（集中记忆 files/<self>/memory/<target>.memory.md）
      if (!isSelf) {
        const impression = loadMemory(chatDialogKey(selfId, target), selfId);
        lines.push(`印象: ${impression ? impression.replace(/\n/g, ' | ') : '(尚无印象记录)'}`);
      }
      return lines.join('\n');
    },
    extractLabel: (args) => (args.agent_id as string) ?? selfId,
  });
}

/** 更新 Agent 档案（fields 形态；persona 写 AGENT.md；配置字段同步落盘 config.json） */
export function makeUpdateAgentProfileTool(config: AgentConfig, services: ToolContext): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'update_agent_profile', label: '更新个人档案', requires: ['agent'],
    description: '更新 Agent 档案与能力清单：name/description/persona/avatar/tags/presets/tools/hooks。默认更新自己的档案；admin（含 admin 标签）可传 agent_id 更新其他 Agent。非管理员不能给自己打 admin 标签。presets=启用插件（cordis 插件名列表）；tools=显式工具名；hooks=七类钩子顺序表（顺序即执行顺序）。',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: '目标 Agent ID（可选）。默认更新自己；仅 admin 可指定其他 Agent' },
        fields: {
          type: 'object',
          description: '要更新的字段键值对。支持：name, description, persona, avatar, tags, presets, tools, hooks。agent_id 不能修改；非管理员不能给自己打 admin 标签。',
          properties: {
            name: { type: 'string', description: 'Agent 的昵称/显示名称' },
            description: { type: 'string', description: 'Agent 的简短描述' },
            persona: { type: 'string', description: 'Agent 的人物设定/性格描述（写入 AGENT.md）' },
            avatar: { type: 'string', description: 'Agent 的头像文件名/URL' },
            tags: { type: 'array', items: { type: 'string' }, description: '能力标签列表（如 dev/qa/conductor）。非管理员不能打 admin 标签。' },
            presets: { type: 'array', items: { type: 'string' }, description: '启用插件列表（cordis 插件 name = preset id，如 agentchat-fs-tools）；顺序无意义' },
            tools: { type: 'array', items: { type: 'string' }, description: '显式工具名追加（requires 为空的工具只能在此启用）' },
            hooks: { type: 'object', description: '七类钩子顺序表：{ runStart?: string[], runEnd?: string[], turnStart?: string[], turnEnd?: string[], toolExecutionStart?: string[], toolExecutionEnd?: string[], fallback?: string[] }；数组顺序即执行顺序' },
          },
        },
      },
      required: ['fields'],
    },
    execute: async (args) => {
      const registry = services.router?.getRegistry();
      if (!registry) return '[update_agent_profile] 错误：router 未注入 ToolContext';
      const targetId = (args.agent_id as string | undefined) ?? selfId;
      const fields = args.fields as Record<string, any> | undefined;
      if (!fields || Object.keys(fields).length === 0) {
        return '[update_agent_profile] 错误：fields 参数不能为空。';
      }

      // 允许的字段（新契约 presets/tools/hooks；system_prompt 不允许 Agent 改）
      const allowed = ['name', 'description', 'persona', 'avatar', 'tags', 'presets', 'tools', 'hooks'];
      const invalid = Object.keys(fields).filter(k => !allowed.includes(k));
      if (invalid.length > 0) {
        return `[update_agent_profile] 错误：不允许修改以下字段：${invalid.join(', ')}。只能修改：${allowed.join(', ')}。`;
      }

      const cur = registry.get(targetId);
      if (!cur) return `[update_agent_profile] Agent "${targetId}" 未找到`;

      // 定位 Agent 目录（persona 与配置落盘都需要）
      const agentsDir = services.agentsDir ?? '';
      let agentDir: string | null = null;
      if (agentsDir) {
        for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const cfgPath = path.join(agentsDir, entry.name, 'config.json');
          if (!fs.existsSync(cfgPath)) continue;
          try {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            if (cfg.agent_id === targetId) { agentDir = path.join(agentsDir, entry.name); break; }
          } catch { /* skip */ }
        }
      }

      const changed: string[] = [];

      // ── 更新 registry 内存配置（config.json 字段）──
      const configFields = Object.entries(fields).filter(([k]) => k !== 'persona');
      for (const [key, value] of configFields) {
        const oldVal = JSON.stringify((cur as any)[key]);
        const newVal = JSON.stringify(value);
        if (oldVal !== newVal) {
          (cur as any)[key] = value;
          changed.push(key);
        }
      }

      // ── 配置字段落盘 config.json（差异配置原文合并，不依赖 global base）──
      if (configFields.length > 0) {
        if (!agentDir) {
          return `[update_agent_profile] 未找到 Agent "${targetId}" 的目录，配置落盘失败（内存已更新但重启后丢失）。`;
        }
        const cfgPath = path.join(agentDir, 'config.json');
        try {
          const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, any>;
          for (const [key, value] of configFields) disk[key] = value;
          fs.writeFileSync(cfgPath, JSON.stringify(disk, null, 2) + '\n', 'utf-8');
        } catch (err: any) {
          return `[update_agent_profile] 配置落盘失败: ${err?.message ?? String(err)}`;
        }
      }

      // ── persona → AGENT.md ──
      if (fields.persona !== undefined) {
        if (!agentDir) {
          return `[update_agent_profile] 未找到 Agent "${targetId}" 的目录，persona 更新失败（其余字段已更新）。`;
        }
        const mdPath = path.join(agentDir, 'AGENT.md');
        const title = fs.existsSync(mdPath) ? (fs.readFileSync(mdPath, 'utf-8').split('\n')[0] || '# 人物设定') : '# 人物设定';
        const body = String(fields.persona).trim();
        if (!body) return '[update_agent_profile] 错误：persona 不能为空。';
        fs.writeFileSync(mdPath, `${title}\n\n${body}\n`, 'utf-8');
        changed.push('persona');
      }

      if (changed.length === 0) {
        return '[update_agent_profile] 没有字段发生变化，档案无需更新。';
      }
      const who = targetId === selfId ? '自己' : targetId;
      return `已更新 ${who} 的档案。修改字段：${changed.join(', ')}。`;
    },
    extractLabel: () => '档案',
  });
}

/** Agent 协作工具工厂（per-Agent 烘焙身份 + 运行时服务） */
export function makeAgentTools(config: AgentConfig, services: ToolContext): Tool[] {
  return [
    makeSendAgentTool(config, services),
    makeSendGroupTool(config, services),
    makeListAgentsTool(services),
    makeListGroupsTool(config, services),
    makeListToolsTool(config, services),
    makeReadAgentInfoTool(config, services),
    makeUpdateAgentProfileTool(config, services),
  ];
}
