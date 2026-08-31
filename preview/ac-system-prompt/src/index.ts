// ============================================================
// ac-system-prompt —— 系统提示词分块装配器（M14 升级）
//
// src 轨道映射：agent-prompt 的 build-system-prompt 装配链 →
// preview 的 loop/before-run waterfall。装配为分块拼装（KV cache
// 友好顺序：静态在前、动态在后——资产 #12）：
//
//   [override 路径] override 文本（完全替换下列静态块）+ 对话信息块
//   [默认路径] 框架块（无标签包裹——<persona> 标签归 ac-persona 专用）→
//              系统环境 → 术语约定（协作工具门控）→
//              指引（工具门控读 request.tools）→ 后台任务（job/bash
//              门控）→ 对话信息（信封 sender/conversationId，群场景
//              经可选 ctx.group 解析成员表；对话对象行对齐 src 轨道
//              `[当前对话对象] <id> - <显示名>` 格式）
//
// 与 ac-persona 的组合语义：角色块前置（persona 行）、框架块追加
// （本行）——两种注册顺序收敛到同一结构（ADR-7 顺序无关收敛）。
//
// 配置双层：
//   · 行 Config { framework? }：框架块缺省文本（行组合级）
//   · settings['system-prompt']（per-Agent，M24 A1 经 settingsOf 合成
//     全局默认层）：
//     { enabled?, framework?, guidelines?, systemEnv?, conversationPartner?, override? }
//     —— framework 字符串覆盖行缺省；override 完全替换静态块（src
//     SYSTEM.md 覆盖语义；对话信息块仍追加）；布尔项缺省 true。
// ============================================================
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import z from '@agentchat/schemastery';
import type {} from 'ac-agent-loop'; // LoopSender（经 LoopRunRequest 传入，仅文档引用）
import type {} from 'ac-agents'; // ctx.agents 服务类型增强（type-only）
import type {} from 'ac-group'; // ctx.group 可选能力类型（type-only）
import type {} from 'ac-tools'; // ctx.tools 可选能力类型（type-only）
import type {} from 'ac-workspace'; // ctx.workspace 可选能力类型（type-only）

// KV Cache effect（M21/D9 声明纪律）: Prefix-stable —— 分块拼装确定性
// （装配输入不变则 system 字节不变，M2a）。显式失效：框架块/对话对象/
// 工作目录等输入变化 = invalidate-from-0（该桶一次 system 重置，§4.4）。

export const name = 'ac-system-prompt';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'system-prompt',
  label: '系统提示装配',
  description: 'framework/系统环境/术语约定/指引/后台任务/对话信息分块装配（override 可全量覆盖）',
  fields: [
    { name: 'framework', description: 'framework 块正文——留空用内置默认' },
    { name: 'guidelines', description: '指引块正文（协作约定/文件工作流指引）' },
    { name: 'systemEnv', description: '系统环境块附加说明（workdir/allowedPaths 自动注入，此处为补充文字）' },
    { name: 'conversationPartner', description: '对话对象行显示名（缺省用端点注册表显示名）' },
    { name: 'override', description: 'SYSTEM.md 覆盖语义——true 时替换全部静态块（对话信息仍追加）' },
    { name: 'enabled', description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
  ],
  listeners: [{ event: 'loop/before-run', role: '分块装配', description: 'Agent 循环启动前拦截（人格注入/预算控制/直接否决）', respectsEnabled: true }],
};


export interface Config {
  /** 框架块内容（缺省用内置模板；settings['system-prompt'].framework 可 per-Agent 覆盖） */
  framework?: string;
}

export const Config: z<Config> = z.object({
  framework: z.string(),
}) as z<Config>;

/** settings['system-prompt'] 配置形状（per-Agent；形状由本插件自定义） */
export interface SystemPromptSettings {
  /** 缺省 true；false = 本 Agent 软停用（ADR-4） */
  enabled?: boolean;
  /** per-Agent 框架块文本（覆盖行缺省） */
  framework?: string;
  /** 指引块开关（缺省 true） */
  guidelines?: boolean;
  /** 系统环境块开关（缺省 true） */
  systemEnv?: boolean;
  /** 对话信息块开关（缺省 true） */
  conversationPartner?: boolean;
  /**
   * 完全覆盖文本（src SYSTEM.md 语义）：替换 framework/系统环境/术语
   * 约定/指引/后台任务全部静态块；对话信息块仍追加（动态信息不丢）。
   */
  override?: string;
}

// 框架块：不包裹标签（<persona> 标签归 ac-persona 的角色块专用；框架
// 块作为 system 的开头文本直接呈现）。
const DEFAULT_FRAMEWORK = ['你是 AgentChat 中的智能体，通过工具完成任务。', '· 一次只做一步， tool_calls 与最终文本二选一。', '· 工具结果返回后继续推理，直到能给出最终回答。'].join('\n');

/** 协作工具清单（术语约定块的注入门槛） */
const COLLAB_TOOLS = [
  'send_agent',
  'list_agents',
  'send_group',
  'list_groups',
  'list_tools',
  'grep_history',
  'read_history',
  'read_agent_info',
  'update_agent_profile',
];

/** Agent 显示名（agents 可选能力缺位时回退 id） */
const fallbackLabel = (id: string): string => id;

// ============================================================
// 纯装配函数（单测友好；apply 只负责收集输入）
// ============================================================

/** 环境块输入（来自 settings['security'] 的 per-Agent 沙箱配置） */
export interface EnvSecurityInput {
  workdir?: string;
  allowedPaths?: string[];
}

/** 群信息（ctx.group 可选能力解析的简化形状） */
export interface ConversationGroupInput {
  name: string;
  members: string[];
  description?: string;
}

/** 装配输入（apply 收集；纯函数消费） */
export interface AssembleInput {
  /** 本 run 有效工具名清单（门控依据；request.tools ?? 全部已注册工具） */
  toolNames: string[];
  /**
   * 信封：发送方端点 id（M19 身份/拓扑分离）——对话对象行的标注依据
   * （viewer 虚拟 Agent id / 委托方 Agent id / 机制触发 = 目标自身）。
   */
  sender?: string;
  /** 信封：发送方拓扑类（'user' / 'agent' / 'event'） */
  source?: string;
  /** 信封：会话键 */
  conversationId?: string;
  /** 本 run 的 Agent id（自查/自己对话判定） */
  agentId?: string;
  /** Agent 显示名解析（ctx.agents 可选能力；description 即显示名） */
  labelOf?: (id: string) => string;
  /** settings['system-prompt']（per-Agent） */
  settings?: SystemPromptSettings;
  /** 行 Config.framework（缺省框架文本） */
  rowFramework?: string;
  /** per-Agent 沙箱配置（settings['security']） */
  security?: EnvSecurityInput;
  /**
   * Agent 专用空间缺省（<wsRoot>/files/<agentId>；ac-workspace.agentWorkdir
   * 推导——M18 反馈 #3：常规 Agent 工作目录不再展示工作区根）。
   * 显式 security.workdir 仍最优先；预设 Agent 传回 wsRoot（无个人空间）。
   */
  agentWorkdir?: string;
  /** 工作区根（可选能力 ctx.workspace；无则按 './' 展示） */
  wsRoot?: string;
  /** 群信息（conversationId 命中群时） */
  group?: ConversationGroupInput | null;
}

function buildTerminologyBlock(): string {
  return [
    '## 术语约定',
    '',
    '- Agent — 本系统中所有对话参与者的统称，包括普通 Agent（AI 实体）和虚拟 Agent（用户）。send_agent、list_agents、grep_history/read_history、read_agent_info 均可操作任意 Agent；update_agent_profile 默认更新自己，具备 admin 能力可更新其他 Agent。',
    '',
  ].join('\n');
}

function buildGuidelinesBlock(toolNames: string[]): string {
  const names = new Set(toolNames);
  const has = (...required: string[]) => required.every((n) => names.has(n));
  const list: string[] = [];
  const seen = new Set<string>();
  const add = (g: string): void => {
    if (seen.has(g)) return;
    seen.add(g);
    list.push(g);
  };

  // 1. 文件工作流（跨工具编排：read→edit，bash 兜底）
  if (has('read', 'write', 'edit')) {
    add('文件操作：修改现有文件用 edit（old_string/new_string 文本匹配，原文直接从 read 输出复制；多处修改并行发多个 edit 调用）；改现有文件勿用 write 覆盖（write 适合新建）；探索文件系统优先 read/glob，复杂操作才用 bash。');
  } else if (has('read', 'write') && !names.has('edit')) {
    add('文件操作：edit 不可用，修改文件需先 read 再用 write 写入完整内容。');
  }

  // 2. 产出物引用（有文件产出能力即适用：markdown 行内代码列路径）
  if (names.has('write') || names.has('edit') || names.has('str_replace_editor') || names.has('bash')) {
    add('产出物引用：创建或修改文件后，最终回复中简要列出主要产出文件，路径用 markdown 行内代码格式，不要省略路径或用自然语言描述代替。');
  }

  // 3. 多 Agent 协作流（跨工具编排：list→send）
  if (has('list_agents', 'send_agent')) {
    add('多Agent协作：先 list_agents 找对象，再 send_agent 发消息；对方回复会作为新消息送达，无需等待（需要立即拿结果时设 wait=true）。');
  }
  if (has('list_groups', 'send_group')) {
    add('群聊协作：先 list_groups 查看所在群组，再 send_group 发消息。');
  }

  // 4. 行为准则（"何时用"而非"怎么用"）
  if (names.has('ask_questions')) {
    add('不可逆操作前询问：涉及用户决策/确认/授权（删除、覆盖、花钱、对外发言等）先 ask_questions，不要擅自替用户决定。');
  }
  if (names.has('subagent')) {
    add('并行子任务：独立、可并行的子任务用 subagent(action="spawn") 派出执行，完成后用 subagent(action="await") 取结果，不要把可并行的活串行做。');
  }

  if (list.length === 0) return '';
  return `## 指引\n${list.map((g, i) => `${i + 1}. ${g}`).join('\n')}`;
}

function buildJobProtocolBlock(): string {
  return [
    '## 后台任务',
    '',
    '- 后台任务用 job 工具按 id 管理（bash 后台模式返回 job_id）。启动后记住 id，任务完成时你会收到通知——不要用 job list 忙轮询。',
    '- job logs 读取输出（需要等待完成时用 bash 前台命令并配合较长 timeout 更直接）；不再重要的任务用 job kill 及时清理，避免占用并发额度。',
    '',
  ].join('\n');
}

function buildEnvBlock(
  security: EnvSecurityInput | undefined,
  wsRoot: string | undefined,
  agentWorkdir: string | undefined,
): string {
  const lines: string[] = [];
  lines.push('## 系统环境');

  // 工作目录：具体化展示（绝对路径必给；工作区内相对形态附注）。
  // 基准优先级：显式 security.workdir > Agent 专用空间 files/<id> > 工作区根。
  const base = security?.workdir ?? agentWorkdir ?? wsRoot ?? './';
  if (wsRoot && base !== wsRoot) {
    const rel = path.relative(wsRoot, base);
    const display =
      rel && !rel.startsWith('..') && !path.isAbsolute(rel)
        ? `./${rel.split(path.sep).join('/')}（${base}）`
        : base;
    lines.push(`[工作目录] ${display}`);
  } else if (base !== './') {
    lines.push(`[工作目录] ${base}`);
  } else {
    lines.push('[工作目录] ./');
  }

  const extras = (security?.allowedPaths ?? [])
    .map((a) => (path.isAbsolute(a) || !wsRoot ? a : path.resolve(wsRoot, a)))
    .filter((a) => a !== base);
  if (extras.length > 0) {
    lines.push(`[路径穿透白名单] ${extras.join('；')} — 工作目录之外允许读写的额外路径`);
  }

  return lines.join('\n');
}

function buildConversationBlock(input: AssembleInput): string {
  const lines: string[] = [];
  lines.push('## 对话信息');

  // 对话对象（src 轨道格式：`[当前对话对象] <id> - <显示名><注>`）。
  // M19：sender 携带端点 id（委托方身份缺失顺带修复）——
  //   · source='user'（直答/独立会话）→ 对象 = viewer 虚拟 Agent
  //     （显示名取注册表 description——用户配置的名字（如"风栗"）如实展示）；
  //   · source='agent'（委托）→ 对象 = 委托方 Agent（id + 显示名）；
  //   · source='event'（机制触发，D2 自会话语义）→ 对象 = 自己（标注机制触发）；
  //   · sender 缺省（loop 直连等）→ 无法判定对象，仅报会话键。
  const labelOf = input.labelOf ?? ((id: string) => id);
  if (input.sender !== undefined && input.sender !== '') {
    // 显示名单源 = 注册表（ac-workspace 恒注册 viewer 虚拟 Agent 带描述；
    // 缺注册时如实展示端点 id——无 user 专属路径）
    const shown = labelOf(input.sender);
    if (input.source === 'event') {
      lines.push(`[当前对话对象] ${input.sender} - ${shown}（机制触发·自会话）`);
    } else {
      lines.push(`[当前对话对象] ${input.sender} - ${shown}`);
    }
  } else if (input.conversationId !== undefined) {
    lines.push(`[当前会话] ${input.conversationId}`);
  }

  const group = input.group;
  if (group) {
    lines.push(`[当前群聊] ${group.name}（${input.conversationId ?? ''}）`);
    lines.push(`[群聊成员] ${group.members.map((m) => {
      const label = labelOf(m);
      return label !== m ? `${label} (${m})` : m;
    }).join('、')}`);
    if (group.description) lines.push(`[群聊简介] ${group.description}`);
  }

  return lines.join('\n');
}

/**
 * 分块装配（纯函数）。返回块文本数组（apply 依序追加进 system）。
 * override 路径：静态块整体替换为 override 文本，对话信息块仍追加。
 */
export function assembleBlocks(input: AssembleInput): string[] {
  const settings = input.settings ?? {};
  const toolNames = input.toolNames;
  const hasCollab = COLLAB_TOOLS.some((n) => toolNames.includes(n));
  const hasJob = toolNames.includes('job') || toolNames.includes('bash');

  const blocks: string[] = [];
  if (typeof settings.override === 'string' && settings.override.trim()) {
    blocks.push(settings.override.trim());
  } else {
    blocks.push(settings.framework ?? input.rowFramework ?? DEFAULT_FRAMEWORK);
    if (settings.systemEnv !== false) {
      blocks.push(buildEnvBlock(input.security, input.wsRoot, input.agentWorkdir));
    }
    if (hasCollab) {
      blocks.push(buildTerminologyBlock());
    }
    if (settings.guidelines !== false) {
      const block = buildGuidelinesBlock(toolNames);
      if (block) blocks.push(block);
    }    if (hasJob) {
      blocks.push(buildJobProtocolBlock());
    }
  }
  if (settings.conversationPartner !== false) {
    const block = buildConversationBlock(input);
    // 信封全空（子 Agent / loop 直连）：无信息可报，不注入
    if (input.sender !== undefined || input.conversationId !== undefined || input.group) {
      blocks.push(block);
    }
  }
  return blocks;
}

// ============================================================
// apply：收集输入（agents settings / 可选 group·workspace·tools）→ 追加
// ============================================================

export function apply(ctx: Context, config: Config = {}) {
  ctx.on('loop/before-run', (call, next) => {
    const request = call.request;
    const agentId = request.agent;
    // 可选能力：agents 未装时无 per-Agent settings，按行缺省装配
    const agents = ctx.get('agents');
    const settingsCfg = agentId && agents ? agents.settingsOf(agentId, 'system-prompt') : undefined;
    if (
      settingsCfg !== undefined &&
      settingsCfg !== null &&
      typeof settingsCfg === 'object' &&
      (settingsCfg as SystemPromptSettings).enabled === false
    ) {
      return next();
    }
    const settings =
      settingsCfg !== undefined && settingsCfg !== null && typeof settingsCfg === 'object'
        ? (settingsCfg as SystemPromptSettings)
        : {};

    // 有效工具名：request.tools 白名单 ?? 全部已注册工具（门控依据）
    const tools = ctx.get('tools');
    const toolNames =
      request.tools ?? (tools ? tools.list().map((t) => t.name) : []);

    // 可选能力：群信息（conversationId 命中群 → 群成员表块）
    const group = ctx.get('group');
    const convId = request.conversationId;
    const groupInfo = group && convId ? group.get(convId) : undefined;

    // 可选能力：工作区根（环境块的工作目录基准）+ Agent 专用空间推导
    // （agentWorkdir：常规 Agent = files/<id>；预设 = 工作区根——M18 #3）
    const workspace = ctx.get('workspace') as
      | { root: string; agentWorkdir(id: string): string }
      | undefined;

    const security = agentId && agents ? agents.settingsOf(agentId, 'security') : undefined;
    const blocks = assembleBlocks({
      toolNames,
      sender: request.sender,
      source: request.source,
      conversationId: convId,
      agentId,
      // 显示名解析：AgentConfig.description ?? 端点 id（注册表是显示名唯一
      // 事实源——viewer 虚拟 Agent 由 ac-workspace 注册时带描述，M18 #4）
      labelOf: agents
        ? (id: string) => agents.get(id)?.description ?? id
        : fallbackLabel,
      settings,
      rowFramework: config.framework,
      security:
        security !== undefined && security !== null && typeof security === 'object'
          ? (security as EnvSecurityInput)
          : undefined,
      ...(agentId && workspace ? { agentWorkdir: workspace.agentWorkdir(agentId) } : {}),
      wsRoot: workspace?.root,
      group: groupInfo ?? null,
    });

    if (blocks.length > 0) {
      const suffix = blocks.join('\n\n');
      call.request = {
        ...call.request,
        system: call.request.system ? `${call.request.system}\n\n${suffix}` : suffix,
      };
    }
    return next();
  }, { description: 'system prompt 分块装配（framework/环境/指引/对话信息）' });
}
