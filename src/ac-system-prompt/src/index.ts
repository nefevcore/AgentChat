// ============================================================
// ac-system-prompt —— 系统提示词分块装配器（v3 重构 2026-09-02）
//
// 装配为分块拼装（KV cache 友好顺序：静态在前、动态在后——资产 #12）：
//
//   [override 路径] override 文本（完全替换下列静态块）+ 对话信息块
//   [默认路径] 系统环境 → 术语约定（协作工具门控）→
//              指引（条目级工具门控）→ 对话信息（信封
//              sender/conversationId，群场景经可选 ctx.group 解析成员表；
//              对话对象行 `[当前对话对象] <id> - <显示名>` 格式）
//
// v3 变更（docs/system-prompt-optimization-plan.md，用户逐块裁决）：
//   · framework 块退役（loop 协议句随之移除——需要者由 persona 作者
//     承载；行 Config.framework / settings.framework 随块删除）
//   · 指引 dsh 句式重构：每条 = 动作 + 理由/边界，工具结果响应纪律
//     （命令执行）与流程闭环（后台任务）并入指引条目
//   · 独立"后台任务"块并入指引（条目级门控 bash∥job，对齐 dsh
//     "每工具一段、无独立章节"的事实形态）
//   · 旧轨回归：主动安排（timer）/ 系统管理（system_restart）——
//     audit 明判"框架级行为策略"保留项，重写中遗失后回归
//
// 与 ac-persona 的组合语义：角色块前置（persona 行）、静态块追加
// （本行）——两种注册顺序收敛到同一结构（ADR-7 顺序无关收敛）。
//
// 配置双层：
//   · settings['system-prompt']（per-Agent，M24 A1 经 settingsOf 合成
//     全局默认层）：{ enabled?, guidelines?, systemEnv?,
//     conversationPartner?, override? }——override 完全替换静态块
//     （src SYSTEM.md 覆盖语义；对话信息块仍追加）；布尔项缺省 true。
// ============================================================
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-agent-loop'; // LoopSender（经 LoopRunRequest 传入，仅文档引用）
import { displayNameOf } from 'ac-agents'; // 显示名单源解析（值导入连带 ctx.agents 类型增强）
import type {} from 'ac-group'; // ctx.group 可选能力类型（type-only）
import type {} from 'ac-tools'; // ctx.tools 可选能力类型（type-only）
import type {} from 'ac-workspace'; // ctx.workspace 可选能力类型（type-only）

// KV Cache effect（M21/D9 声明纪律）: Prefix-stable —— 分块拼装确定性
// （装配输入不变则 system 字节不变，M2a）。显式失效：静态块文本/对话
// 对象/工作目录等输入变化 = invalidate-from-0（该桶一次 system 重置，
// §4.4）。静态块文本只随代码发布变更（v3 framework 退役 = 部署期一次
// 失效，之后零抖动）。

export const name = 'ac-system-prompt';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'system-prompt',
  label: '系统提示装配',
  description: '系统环境/术语约定/指引（条目级工具门控，含命令执行与后台任务条目）/对话信息分块装配（override 可全量覆盖）',
  fields: [
    { name: 'guidelines', type: 'boolean', default: true, description: '指引块开关——条目按生效工具集门控（文件/命令/后台/产出/协作/行为策略）' },
    { name: 'systemEnv', type: 'boolean', default: true, description: '系统环境块开关（[工作目录]/[路径规则]/白名单自动注入）' },
    { name: 'conversationPartner', type: 'boolean', default: true, description: '对话信息块开关（sender 三态解析 + 群成员表）' },
    { name: 'override', type: 'text', description: '整段替换文本——非空时替换全部静态块（对话信息仍追加）' },
    { name: 'enabled', type: 'boolean', default: true, description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
  ],
  listeners: [{ event: 'loop/before-run', role: '分块装配', description: 'Agent 循环启动前拦截（人格注入/预算控制/直接否决）', respectsEnabled: true }],
};

/** settings['system-prompt'] 配置形状（per-Agent；形状由本插件自定义） */
export interface SystemPromptSettings {
  /** 缺省 true；false = 本 Agent 软停用（ADR-4） */
  enabled?: boolean;
  /** 指引块开关（缺省 true；含命令执行/后台任务条目） */
  guidelines?: boolean;
  /** 系统环境块开关（缺省 true） */
  systemEnv?: boolean;
  /** 对话信息块开关（缺省 true） */
  conversationPartner?: boolean;
  /**
   * 完全覆盖文本（src SYSTEM.md 语义）：替换系统环境/术语约定/指引
   * 全部静态块；对话信息块仍追加（动态信息不丢）。
   */
  override?: string;
}

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
  /** Agent 显示名解析（ctx.agents 可选能力；description 即显示名） */
  labelOf?: (id: string) => string;
  /** settings['system-prompt']（per-Agent） */
  settings?: SystemPromptSettings;
  /** per-Agent 沙箱配置（settings['security']） */
  security?: EnvSecurityInput;
  /**
   * 会话挂载工作区根（singles → workspace.conversationWorkspaceRoot；
   * undefined = 非 singles/未挂/行未装）。挂载即授予：与
   * security.allowedPaths 同面并入 [路径穿透白名单] 展示——模型据此
   * 知道工作区目录可读写（沙箱允许根同源，见 ac-workspace）。
   */
  sessionWorkspace?: string;
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
  /**
   * 本 run 模型视觉能力（ctx.llm.visionOf 软查询；undefined = 注册面
   * 无能力元数据——不注入，零噪音）。注入 [模型能力] 行防"视觉模型
   * 自认纯文本"类幻觉（多模态链路）。
   */
  vision?: boolean | undefined;
  /** 本 run 模型名（[模型能力] 行展示；vision 给定才有意义） */
  model?: string;
}

function buildTerminologyBlock(): string {
  return [
    '## 术语约定',
    '',
    '- Agent — 本系统中所有对话参与者的统称，包括普通 Agent（AI 实体）和虚拟 Agent（用户）。send_agent、list_agents、grep_history/read_history、read_agent_info 均可操作任意 Agent；update_agent_profile 默认更新自己，具备 admin 能力可更新其他 Agent。',
    '',
  ].join('\n');
}

// ============================================================
// 指引块（v3：条目级工具门控 + dsh 句式）
//
// 分工红线：只放工具描述教不了的——何时用、结果怎么解读、何时停
// （旧轨 audit 实证：用法句与工具描述大面积冗余）。排序 = 执行类
// （文件/命令/后台）→ 产出 → 协作类 → 行为策略类。措辞基线由
// tests 按条目整段锁定（改措辞 = 显式改测试，防渐进膨胀）。
// ============================================================
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

  // ── 执行类 ──
  // 1. 文件工作流（跨工具编排 read→edit；对比句式：glob=找文件 /
  //    grep=搜内容 / bash=兜底；反推断护栏收编自 v3 framework 遗产）
  if (has('read', 'write', 'edit')) {
    add('文件操作：改现有文件用 edit，old_string 从 read 的输出中原样复制（自拟文本会匹配失败）；同一文件有多处独立修改时，并行发多个 edit 调用。write 是整文件覆盖，只用于新建文件。找文件用 glob，搜内容用 grep；不确定文件位置时先用 glob 确认，不要凭记忆拼路径。bash 只做文件工具办不到的事（组合命令、进程、环境）。');
  } else if (has('read', 'write') && !names.has('edit')) {
    add('文件操作：edit 不可用，修改文件需先 read 再用 write 写入完整内容。');
  }

  // 2. 命令执行（工具结果响应纪律：退出码协议 / 报错勿原样重发——
  //    v3 framework 遗产的 bash 门控落点 / 中断≠失败 / 截断出路）
  if (names.has('bash')) {
    add('命令执行：命令以非零退出码结束时，先读输出定位原因，修正后再继续（原样重跑大概率再次失败）；被中断的命令按已终止处理，不代表命令本身有错。长输出会被截断，需要完整输出时先重定向到文件再 read。');
  }

  // 3. 后台任务（生命周期闭环：记住 id → 通知到达不忙轮询 → 等待的
  //    对比出路 → 终答前收集 → kill 清理；v3 并入指引，独立块退役）
  if (names.has('job') || names.has('bash')) {
    add('后台任务：后台命令会返回 job_id，记住 id，任务完成时会收到通知，不要用 job list 忙轮询；确需等待完成时，用前台 bash 配合较长 timeout 更直接。给出最终回答前，先收集仍在运行的相关任务的结果；不再重要的任务用 job kill 及时清理，避免占用并发额度。');
  }

  // ── 产出 ──
  // 4. 产出物引用（有文件产出能力即适用；why 随行）
  if (names.has('write') || names.has('edit') || names.has('str_replace_editor') || names.has('bash')) {
    add('产出物引用：创建或修改文件后，最终回复中简要列出主要产出文件，路径用 markdown 行内代码格式；只说"已修改"而不给路径，用户无法定位文件。');
  }

  // ── 协作类 ──
  // 5/6. 跨工具编排 list→send；异步语义 + wait 边界
  if (has('list_agents', 'send_agent')) {
    add('多Agent协作：先 list_agents 找对象，再 send_agent 发消息。消息异步送达：发出后继续手头工作，回复会作为新消息到达；仅当下一步依赖对方结果时才设 wait=true。');
  }
  if (has('list_groups', 'send_group')) {
    add('群聊协作：先 list_groups 查看所在群组，再 send_group 发消息。');
  }

  // ── 行为策略类 ──
  // 7. 主动安排（旧轨回归：audit 明判框架级行为策略——"自主性"是
  //    工具描述不载的行为决策）
  if (names.has('timer')) {
    add('主动安排：发现值得持续跟进或适时提醒的事项时，主动用 timer(action="set") 安排，不必等用户指令。');
  }

  // 8. 不可逆操作前询问（"何时用"而非"怎么用"）
  if (names.has('ask_questions')) {
    add('不可逆操作前询问：删除、覆盖、花钱、对外发言等不可逆或涉及授权的操作，先 ask_questions 征求确认，不要擅自替用户决定。');
  }

  // 9. 并行子任务（多轮会话：续用优先/mode 决策/止损与清理；边界：依赖后续输出的任务不适合派出）
  if (names.has('subagent')) {
    add('并行子任务：独立、可并行的子任务用 subagent(action="spawn") 派出、await 收结果；后续补充指示或追问用 subagent(action="send") 续聊（保留上下文，优先续用而非新开），当场要回复加 mode=sync、纠正进行中的工作用 mode=steer；跑偏的 run 用 stop 及时止损，不再需要的用 delete 删除。若后续步骤依赖其输出，则不适合派出。');
  }

  // 10. 系统管理（旧轨回归：重启语义是工具描述不载的生效边界）
  if (names.has('system_restart')) {
    add('系统管理：修改 src/ 业务包源码后，需要 system_restart 重启才能生效（reload 只重读配置，不加载代码改动）；仅在确实需要时使用。');
  }

  // 11. 目标与待办（跨 run 连续性：goal 登记 → 宿主 goal-round 自动逐轮
  //     推进 / todo 维护当下清单——"何时用"是工具描述不载的行为决策）
  if (names.has('goal') || names.has('todo')) {
    add('目标与待办：承担跨会话的长期任务时，用 goal(action="create") 登记目标——登记后宿主自动逐轮推进直至完成/受阻；多步工作先写 todo(action="write") 清单，随做随更新状态（开工标 in_progress、完成即标）；达成即 goal(action="update", status="completed") 收口，确认无法推进则 status="blocked" 并给 blocked_reason。');
  }

  if (list.length === 0) return '';
  return `## 指引\n${list.map((g, i) => `${i + 1}. ${g}`).join('\n')}`;
}

function buildEnvBlock(
  security: EnvSecurityInput | undefined,
  wsRoot: string | undefined,
  agentWorkdir: string | undefined,
  vision: boolean | undefined,
  model: string | undefined,
  sessionWorkspace: string | undefined,
): string {
  const lines: string[] = [];
  lines.push('## 系统环境');

  // 工作目录：恒完整路径展示（不给相对形态——模型无需换算基准）。
  // 相对输入（security.workdir）经 path.resolve 具体化，锚点 process.cwd()
  // 与沙箱真实解析同源（ac-sandbox-core createSandboxResolver 同款）。
  // 基准优先级：显式 security.workdir > Agent 专用空间 files/<id> > 工作区根
  // > process.cwd()（'./' 兜底即沙箱缺省基准）。
  const base = security?.workdir ?? agentWorkdir ?? wsRoot ?? './';
  lines.push(`[工作目录] ${path.resolve(base)}`);
  // 路径规则一句话（2026-09-02 反馈：Agent 在 bash 吃过"绝对路径越界"拦截后
  // 行为泛化成"绝对路径不可用"——实际拦截原因是越界而非绝对形态）
  lines.push('[路径规则] 工作目录与白名单内绝对/相对路径均可；沙箱越界一律拦截');
  // 模型能力（多模态）：注册面可判定才注入——视觉模型自认"看不了图"、
  // 文本模型硬猜图片内容都是实测高频幻觉；undefined（无元数据）零噪音
  if (vision === true) {
    lines.push(`[模型能力] 当前对话模型 ${model ?? ''} 支持图片输入（多模态）——用户消息中的附件图片会直接送达，请直接基于图片内容回答，不要声称无法查看图片`);
  } else if (vision === false) {
    lines.push(`[模型能力] 当前对话模型 ${model ?? ''} 为纯文本模型——附件以 [附件] 路径行提供，图片内容不可见（read 工具可读文本类附件）；涉及图片内容时如实说明这一限制，不要猜测或虚构图片`);
  }

  const extras = (security?.allowedPaths ?? [])
    .map((a) => (path.isAbsolute(a) || !wsRoot ? a : path.resolve(wsRoot, a)))
    .filter((a) => a !== base);
  // 会话挂载工作区（singles）：挂载即授予——并入白名单展示（沙箱允许根
  // 同源，ac-workspace.conversationWorkspaceRoot；去重/base 相同不重复列）
  if (sessionWorkspace && !extras.includes(sessionWorkspace) && sessionWorkspace !== base) {
    extras.push(sessionWorkspace);
  }
  if (extras.length > 0) {
    lines.push(`[路径穿透白名单] ${extras.join('；')} — 工作目录之外允许读写的额外路径`);
  }

  return lines.join('\n');
}

/**
 * 自会话对角线判定（conversationId = a~a）：「机制触发·自会话」标注的
 * 唯一适用面（M19/D2 本义——机制触发归自会话桶）。用户可见桶内的
 * event 轮不标注：与该 sender 的普通轮同渲染，前缀缓存不翻转。
 */
function isSelfPairConversation(conversationId: string | undefined): boolean {
  if (!conversationId || !conversationId.includes('~')) return false;
  const [a, b] = conversationId.split('~');
  return a === b;
}

function buildConversationBlock(input: AssembleInput): string {
  const lines: string[] = [];
  lines.push('## 对话信息');

  // 对话对象（src 轨道格式：`[当前对话对象] <id> - <显示名><注>`）。
  // M19：sender 携带端点 id（委托方身份缺失顺带修复）——
  //   · **群场景（input.group）→ 不渲染对象行（M26）**：群内 sender 逐
  //     消息变化（上一条发言者 ≠ 对话对象），渲染 = 诱导模型把群聊当
  //     1v1；群块给全貌，发言人由 <msg> 包装承载；
  //   · source='user'（直答/独立会话）→ 对象 = viewer 虚拟 Agent
  //     （显示名取注册表 description——用户配置的名字（如"风栗"）如实展示）；
  //   · source='agent'（委托）→ 对象 = 委托方 Agent（id + 显示名）；
  //   · source='event'（机制触发）→ 对象 = sender；**「机制触发·自会话」
  //     标注仅限自会话对角线桶（a~a，D2 本义）**——用户可见桶（1v1/群/
  //     singles）内的机制触发轮（goal-round / job 通知等）与该 sender 的
  //     普通轮渲染**完全一致**：[system] 跨轮字节稳定，事件轮与用户轮
  //     交替不翻转 KV 前缀缓存（2026-09-03 goal-round 实测：标注随
  //     source 翻转曾致每边界 ~94k 全量 miss）；
  //   · sender 缺省（loop 直连等）→ 无法判定对象，仅报会话键。
  const labelOf = input.labelOf ?? ((id: string) => id);
  if (input.group) {
    // 群场景不渲染 1v1 对话对象行（M26 行为对齐）：群内 sender 逐消息
    // 变化（= 上一条发言者，≠ 对话对象）——渲染它会让模型把群聊误判为
    // 与 sender 的 1v1（实测：Agent 推理出现 "current conversation
    // target is neko"）。发言人身份由 <msg from name group> 包装承载；
    // 群块（下方）给群名/成员表全貌。
  } else if (input.sender !== undefined && input.sender !== '') {
    // 显示名单源 = 注册表（ac-workspace 恒注册 viewer 虚拟 Agent 带描述；
    // 缺注册时如实展示端点 id——无 user 专属路径）
    const shown = labelOf(input.sender);
    if (input.source === 'event' && isSelfPairConversation(input.conversationId)) {
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

  const blocks: string[] = [];
  if (typeof settings.override === 'string' && settings.override.trim()) {
    blocks.push(settings.override.trim());
  } else {
    if (settings.systemEnv !== false) {
      blocks.push(buildEnvBlock(input.security, input.wsRoot, input.agentWorkdir, input.vision, input.model, input.sessionWorkspace));
    }
    if (hasCollab) {
      blocks.push(buildTerminologyBlock());
    }
    if (settings.guidelines !== false) {
      const block = buildGuidelinesBlock(toolNames);
      if (block) blocks.push(block);
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

export function apply(ctx: Context) {
  ctx.on('loop/before-run', (call, next) => {
    const request = call.request;
    const agentId = request.agent;
    // 可选能力：agents 未装时无 per-Agent settings，按缺省装配
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
    // + 会话挂载工作区根（singles → 挂载即授予，白名单展示与沙箱同源）
    const workspace = ctx.get('workspace') as
      | { root: string; agentWorkdir(id: string): string; conversationWorkspaceRoot?(cid?: string): string | null }
      | undefined;

    // 可选能力：模型视觉能力（ctx.llm.visionOf——注册面有效清单判定；
    // 无 llm 行/无能力元数据 = undefined → 不注入 [模型能力] 行）
    const llm = ctx.get('llm', false) as
      | { visionOf?(model: string, provider?: string): boolean | undefined }
      | undefined;
    const vision = request.model && typeof llm?.visionOf === 'function'
      ? llm.visionOf(request.model, request.provider)
      : undefined;

    const security = agentId && agents ? agents.settingsOf(agentId, 'security') : undefined;
    const blocks = assembleBlocks({
      toolNames,
      sender: request.sender,
      source: request.source,
      conversationId: convId,
      // 显示名解析：displayNameOf（name ?? description 单源——ac-agents
      // 导出；未注册/无显示名回退端点 id）
      labelOf: agents
        ? (id: string) => displayNameOf(agents.get(id)) ?? id
        : fallbackLabel,
      settings,
      security:
        security !== undefined && security !== null && typeof security === 'object'
          ? (security as EnvSecurityInput)
          : undefined,
      ...(agentId && workspace ? { agentWorkdir: workspace.agentWorkdir(agentId) } : {}),
      wsRoot: workspace?.root,
      ...(workspace?.conversationWorkspaceRoot?.(convId)
        ? { sessionWorkspace: workspace.conversationWorkspaceRoot(convId)! }
        : {}),
      group: groupInfo ?? null,
      ...(vision !== undefined ? { vision } : {}),
      ...(request.model ? { model: request.model } : {}),
    });

    if (blocks.length > 0) {
      const suffix = blocks.join('\n\n');
      call.request = {
        ...call.request,
        system: call.request.system ? `${call.request.system}\n\n${suffix}` : suffix,
      };
    }
    return next();
  }, { description: 'system prompt 分块装配（系统环境/术语/指引/对话信息）' });
}
