// ============================================================
// ac-system-prompt —— 系统提示词分块装配器（v3 重构 2026-09-02）
//
// 装配为分块拼装（KV cache 友好顺序：静态在前、动态在后——资产 #12）：
//
//   [override 路径] override 文本（完全替换下列静态块）+ 对话信息块
//   [默认路径] 系统环境 → 术语约定（协作工具门控）→
//              指引（条目级工具门控）——以上静态块落 loop/before-run 主档；
//              对话信息（信封 sender/conversationId，群场景经可选 ctx.group
//              解析成员表；对话对象行 `[当前对话对象] <id> - <显示名>` 格式）
//              落 loop/before-run-last 尾档（2026-09-05 收尾档位化：静态在
//              前、会话动态信息收尾——尾档内 prepend 恒 unshift，先于恒
//              push 的 ac-datetime 日期行（ADR-7 收敛式，注册时序无关））
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
//
// 形态门控（2026-12）：独立会话（singles）= 用户与单 Agent 的专注对话
// ——多 Agent 会话知识（术语约定块 + 多Agent协作/群聊协作指引条目）不
// 注入；主动安排（timer）与系统管理（system_restart）条目同受形态门控
// （前者：独立会话有后台任务反馈即可；后者：工具已随形态面裁剪出生效
// 集〔ToolDefinition.excludeForms → router〕，双保险锁定）。工具面不
// 裁剪协作/计时工具（显式配置仍可用），只是不教。
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
  description: '系统环境/术语约定/指引（条目级工具门控；独立会话形态不注入多 Agent 协作知识）/对话信息分块装配（override 可全量覆盖）',
  fields: [
    { name: 'guidelines', type: 'boolean', default: true, description: '指引块开关——条目按生效工具集门控（文件/命令/后台/产出/协作/行为策略）；协作、主动安排（timer）与系统管理（system_restart）条目另受形态门控（独立会话不注入）' },
    { name: 'systemEnv', type: 'boolean', default: true, description: '系统环境块开关（[工作目录]/[宿主环境]/[模型能力]/白名单自动注入）' },
    { name: 'conversationPartner', type: 'boolean', default: true, description: '对话信息块开关（sender 三态解析 + 群成员表）' },
    { name: 'override', type: 'text', description: '整段替换文本——非空时替换全部静态块（对话信息仍追加）' },
    { name: 'enabled', type: 'boolean', default: true, description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
  ],
  listeners: [
    { event: 'loop/before-run', role: '静态块装配', description: '系统环境/术语约定/指引分块装配（override 可全量覆盖静态块）', respectsEnabled: true },
    { event: 'loop/before-run-last', role: '对话信息块（尾档·prepend）', description: '信封 sender/群成员表装配；prepend 恒 unshift——先于尾档 push 住户（ac-datetime 日期行），静态在前、会话动态收尾', respectsEnabled: true },
  ],
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
  'read_agent_info',
  'update_agent_profile',
];

/** Agent 显示名（agents 可选能力缺位时回退 id） */
const fallbackLabel = (id: string): string => id;

/** singles 可选能力形状（ctx.get('singles', false)——形态识别面：get 命中即独立会话） */
interface SinglesLike {
  get(sid: string): unknown;
}

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
   * undefined = 非 singles/未挂/行未装）。挂载即基准：会话工作目录指向
   * 工作区根（[工作目录] 行；与沙箱基准 sandboxWorkdir 同源，见
   * ac-workspace）——不再并入 [路径穿透白名单]（白名单形态会让模型
   * 误判主战场仍在 Agent 专用空间）。
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
   * 独立会话（singles）形态标志（conversationId 命中 singles 注册表）。
   * 形态化装配：独立会话是用户与单 Agent 的专注对话——多 Agent 会话
   * 知识不注入（术语约定块 + 多Agent协作/群聊协作指引条目）；主动安排
   * （timer——后台任务反馈已覆盖）与系统管理（system_restart——工具已
   * 随形态面裁剪，双保险）同受门控。协作/计时工具面不裁剪（显式配置
   * 仍可用），只是不教。
   */
  single?: boolean;
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
    '- Agent — 本系统中所有对话参与者的统称，包括普通 Agent（AI 实体）和虚拟 Agent（用户）。send_agent、list_agents、read_agent_info 均可操作任意 Agent；update_agent_profile 默认更新自己，具备 admin 能力可更新其他 Agent。',
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
function buildGuidelinesBlock(toolNames: string[], single = false): string {
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
    add('文件操作：改现有文件用 edit，old_string 从 read 的输出中原样复制（自拟文本会匹配失败；连续编辑同一文件段落时必须重新 read 获取——上次编辑的产物 ≠ 记忆中的文本）；同一文件有多处独立修改时，并行发多个 edit 调用。write 是整文件覆盖，只用于新建文件。找文件用 glob，搜内容用 grep；不确定文件位置时先用 glob 确认，不要凭记忆拼路径。文件存在重复/相似文本块时优先用 pwsh/write 整段重写而非 edit。');
  } else if (has('read', 'write') && !names.has('edit')) {
    add('文件操作：edit 不可用，修改文件需先 read 再用 write 写入完整内容。');
  }

  // 2. 命令执行（工具结果响应纪律：退出码协议 / 报错勿原样重发——
  //    v3 framework 遗产的命令工具门控落点 / 中断≠失败 / 截断出路）。
  //    2026-09-16 工具拆分：bash → pwsh（Windows）/ bash（Unix）双名，
  //    任一在场即注入本条；进程清理纪律与 PowerShell 平台提示同日上移
  //    系统环境块 [宿主环境] 行（宿主事实归环境块，指引只留响应纪律）
  if (names.has('bash') || names.has('pwsh')) {
    add('命令执行：命令以非零退出码结束时，先读输出定位原因，修正后再继续（原样重跑大概率再次失败）；被中断的命令按已终止处理，不代表命令本身有错。长输出会被截断，需要完整输出时先重定向到文件再 read。');
  }

  // 3. 后台任务（生命周期闭环：记住 id → 等通知不轮询 → 等待的对比
  //    出路 → 终答前收集 → kill 清理；v3 并入指引，独立块退役）
  if (names.has('job') || names.has('bash') || names.has('pwsh')) {
    add('后台任务：后台命令会返回 job_id，记住 id 即可，任务完成时通知会自动送达，无需反复查询任务状态；确需等待完成时，用前台命令工具配合较长 timeout 更直接。给出最终回答前，先收集仍在运行的相关任务的结果；不再重要的任务用 job kill 及时清理，避免占用并发额度。');
  }

  // ── 产出 ──
  // 4. 产出物引用（有文件产出能力即适用）
  if (names.has('write') || names.has('edit') || names.has('str_replace_editor') || names.has('bash') || names.has('pwsh')) {
    add('产出物引用：创建或修改文件后，最终回复中简要列出主要产出文件，路径用 markdown 行内代码格式。');
  }

  // ── 协作类（形态门控：独立会话不注入——用户↔单 Agent 专注对话，
  //    多 Agent 会话知识是噪音；工具面不裁剪，仅不教用法）──
  // 5/6. 跨工具编排 list→send；投递语义（空闲直达回复直返 / 忙态注入）
  if (!single) {
    if (has('list_agents', 'send_agent')) {
      add('多Agent协作：先 list_agents 找对象，再 send_agent 发消息。对端空闲时回复文本随结果直返（reply 字段）；对端正忙时消息注入或排队，回复会作为新消息到达。wait=true 用于明确要求对方忙时也排队独立 run 等回复。');
    }
    if (has('list_groups', 'send_group')) {
      add('群聊协作：先 list_groups 查看所在群组，再 send_group 发消息。');
    }
  }

  // ── 行为策略类 ──
  // 7. 主动安排（旧轨回归：audit 明判框架级行为策略——"自主性"是
  //    工具描述不载的行为决策；形态门控：独立会话不注入——后台任务
  //    反馈已覆盖"记住等通知"模式，2026-12 裁决；工具面不裁剪）
  if (!single && names.has('timer')) {
    add('主动安排：发现值得持续跟进或适时提醒的事项时，主动用 timer(action="set") 安排，不必等用户指令。');
  }

  // 8. 不可逆操作前询问（"何时用"而非"怎么用"）
  if (names.has('ask_questions')) {
    add('不可逆操作前询问：删除、覆盖、花钱、对外发言等不可逆或涉及授权的操作，先 ask_questions 征求确认，不要擅自替用户决定。');
  }

  // 9. 并行子任务（多轮会话：派发克制/续用优先/mode 决策/止损与清理；边界：
  //    依赖后续输出的任务不适合派出。派发克制 = 2026-12 追加：实测 Agent
  //    倾向一轮铺开多个 subagent，结果收集与纠偏成本陡增——少量试探、
  //    看清进展再补派）
  if (names.has('subagent')) {
    add('并行子任务：独立、可并行的子任务用 subagent(action="spawn") 派出、await 收结果；同时活跃的子 Agent 保持少数（先派一个看质量与进度，确有需要再逐步补派），不要一次性铺开多个；后续补充指示或追问用 subagent(action="send") 续聊（保留上下文，优先续用而非新开），当场要回复加 mode=sync、纠正进行中的工作用 mode=steer；跑偏的 run 用 stop 及时止损，不再需要的用 delete 删除。若后续步骤依赖其输出，则不适合派出。');
  }

  // 10. 系统管理（旧轨回归：重启语义是工具描述不载的生效边界；形态
  //     门控：独立会话不注入——system_restart 已随形态面裁剪出生效工具集
  //     〔router 形态轴，ToolDefinition.excludeForms〕，此处双保险锁定）
  if (!single && names.has('system_restart')) {
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

/**
 * [宿主环境] 行（shell 命令工具的宿主事实；shell 工具在场才注入——
 * 不出现未分配的命令工具名，防 Agent 困惑）。前身三处散落（2026-09-16
 * 收拢）：指引"命令执行"条目的进程清理纪律（当日事故：Agent 用
 * Stop-Process -Name node 清理测试进程，把后端宿主连带杀掉）、指引
 * "PowerShell 平台"条目（宿主平台事实）、"文件操作"条目尾句（命令
 * 工具职责分工）。按本 run 有效工具集单写：pwsh 在场 = Windows 宿主
 * （Unix→PS 翻译是 fail-closed 的，但覆盖面有限——复杂命令直接写
 * PowerShell 原生更可靠）；bash 在场 = Unix 宿主。
 */
function hostEnvLine(shellTool: 'pwsh' | 'bash' | undefined): string | undefined {
  if (shellTool === 'pwsh') {
    return '[宿主环境] 命令实际由 PowerShell 执行；简单 Unix 命令（ls/cat/grep/head/tail 等）会自动翻译为等价写法（结果里的 translated_command 字段是实际执行的命令），复杂或不确定的命令直接写 PowerShell 原生语法（Get-ChildItem / Select-String / Get-Content 等）最可靠。命令工具（pwsh）只做文件工具办不到的事（组合命令、进程、环境）。路径分隔符用 \\ 或 / 均可。清理进程请勿终止宿主进程——即 AgentChat 后端本身（承载所有会话，含当前对话；它同为 node 进程，按进程名杀 node/pnpm 会将其连带终止）。';
  }
  if (shellTool === 'bash') {
    return '[宿主环境] 命令实际由 bash 执行。命令工具（bash）只做文件工具办不到的事（组合命令、进程、环境）。清理进程请勿终止宿主进程——即 AgentChat 后端本身（承载所有会话，含当前对话；它同为 node 进程，按进程名杀 node/pnpm 会将其连带终止）。';
  }
  return undefined;
}

function buildEnvBlock(
  security: EnvSecurityInput | undefined,
  wsRoot: string | undefined,
  agentWorkdir: string | undefined,
  vision: boolean | undefined,
  model: string | undefined,
  sessionWorkspace: string | undefined,
  shellTool: 'pwsh' | 'bash' | undefined,
): string {
  const lines: string[] = [];
  lines.push('## 系统环境');

  // 工作目录：恒完整路径展示（不给相对形态——模型无需换算基准）。
  // 相对输入（security.workdir）经 path.resolve 具体化，锚点 process.cwd()
  // 与沙箱真实解析同源（ac-sandbox-core createSandboxResolver 同款）。
  // 基准优先级：会话挂载工作区（singles，2026-12 裁决——工作目录指向
  // 工作区根，与沙箱基准 sandboxWorkdir 同源）> 显式 security.workdir >
  // Agent 专用空间 files/<id> > 工作区根 > process.cwd()（'./' 兜底即
  // 沙箱缺省基准）。
  const base = sessionWorkspace ?? security?.workdir ?? agentWorkdir ?? wsRoot ?? './';
  lines.push(`[工作目录] ${path.resolve(base)}`);
  // 宿主环境（shell 命令工具的宿主事实；shell 工具在场才注入）
  const hostEnv = hostEnvLine(shellTool);
  if (hostEnv) lines.push(hostEnv);
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
  // shell 工具判定（[宿主环境] 行的注入依据）：按有效工具集取单平台名
  // （Windows 双注册等异常面 pwsh 优先——与 ac-shell-tools 单平台注册
  // 对齐；两个都不在 = 无命令工具，不注入）
  const shellTool = toolNames.includes('pwsh')
    ? 'pwsh' as const
    : toolNames.includes('bash')
      ? 'bash' as const
      : undefined;

  const blocks: string[] = [];
  if (typeof settings.override === 'string' && settings.override.trim()) {
    blocks.push(settings.override.trim());
  } else {
    if (settings.systemEnv !== false) {
      blocks.push(buildEnvBlock(input.security, input.wsRoot, input.agentWorkdir, input.vision, input.model, input.sessionWorkspace, shellTool));
    }
    if (hasCollab && input.single !== true) {
      blocks.push(buildTerminologyBlock());
    }
    if (settings.guidelines !== false) {
      const block = buildGuidelinesBlock(toolNames, input.single === true);
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
// apply：主档静态块装配 + 尾档对话信息块（2026-09-05 收尾档位化拆分）
// ============================================================

/** settings['system-prompt'] 读取（agents 可选能力缺位 = 缺省装配）；null = enabled=false 软停用 */
function readSettings(ctx: Context, agentId: string | undefined): SystemPromptSettings | null {
  const agents = ctx.get('agents');
  const cfg = agentId && agents ? agents.settingsOf(agentId, 'system-prompt') : undefined;
  if (cfg !== undefined && cfg !== null && typeof cfg === 'object' && (cfg as SystemPromptSettings).enabled === false) {
    return null;
  }
  return cfg !== undefined && cfg !== null && typeof cfg === 'object' ? (cfg as SystemPromptSettings) : {};
}

export function apply(ctx: Context) {
  // ── 主档：静态块（override / 系统环境 / 术语约定 / 指引）──
  // 信封输入不进 assembleBlocks（对话信息块由尾档装配）。
  ctx.on('loop/before-run', (call, next) => {
    const request = call.request;
    const agentId = request.agent;
    const settings = readSettings(ctx, agentId);
    if (settings === null) return next();

    // 有效工具名：request.tools 白名单 ?? 全部已注册工具（门控依据）
    const tools = ctx.get('tools');
    const toolNames =
      request.tools ?? (tools ? tools.list().map((t) => t.name) : []);

    // 可选能力：工作区根（环境块的工作目录基准）+ Agent 专用空间推导
    // （agentWorkdir：常规 Agent = files/<id>；预设 = 工作区根——M18 #3）
    // + 会话挂载工作区根（singles → 挂载即基准，[工作目录] 指向工作区根，
    // 与沙箱基准同源）
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

    const agents = ctx.get('agents');
    const security = agentId && agents ? agents.settingsOf(agentId, 'security') : undefined;
    // 可选能力：独立会话形态（singles 注册表命中 → 多 Agent 协作知识、
    // 主动安排（timer）与系统管理（system_restart——工具已随形态面裁剪）
    // 条目不注入。协作/计时工具面不裁剪，仅不教）
    const singles = ctx.get('singles', false) as SinglesLike | undefined;
    const single = !!(
      request.conversationId &&
      singles &&
      singles.get(request.conversationId)
    );
    const blocks = assembleBlocks({
      toolNames,
      settings,
      security:
        security !== undefined && security !== null && typeof security === 'object'
          ? (security as EnvSecurityInput)
          : undefined,
      ...(agentId && workspace ? { agentWorkdir: workspace.agentWorkdir(agentId) } : {}),
      wsRoot: workspace?.root,
      ...(workspace?.conversationWorkspaceRoot?.(request.conversationId)
        ? { sessionWorkspace: workspace.conversationWorkspaceRoot(request.conversationId)! }
        : {}),
      ...(single ? { single: true } : {}),
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
  }, { description: 'system prompt 静态块装配（系统环境/术语/指引）' });

  // ── 尾档：对话信息块（prepend 恒 unshift）──
  // 2026-09-05 收尾档位化：会话动态信息收尾（静态在前）。prepend 收敛式
  // （ADR-7 同款）：本行恒 unshift、ac-datetime 日期行恒 push——两种注册
  // 时序收敛到同一链序（对话信息 → 日期行），不依赖激活顺序。
  ctx.on('loop/before-run-last', (call, next) => {
    const request = call.request;
    const settings = readSettings(ctx, request.agent);
    if (settings === null) return next();
    if (settings.conversationPartner === false) return next();

    // 可选能力：群信息（conversationId 命中群 → 群成员表块）
    const group = ctx.get('group');
    const convId = request.conversationId;
    const groupInfo = group && convId ? group.get(convId) : undefined;
    // 信封全空（子 Agent / loop 直连）：无信息可报，不注入
    if (request.sender === undefined && convId === undefined && !groupInfo) return next();

    // 显示名解析：displayNameOf（name ?? description 单源——ac-agents
    // 导出；未注册/无显示名回退端点 id）
    const agents = ctx.get('agents');
    const labelOf = agents
      ? (id: string) => displayNameOf(agents.get(id)) ?? id
      : fallbackLabel;
    const block = buildConversationBlock({
      toolNames: [],
      sender: request.sender,
      source: request.source,
      conversationId: convId,
      labelOf,
      group: groupInfo ?? null,
    });
    call.request = {
      ...call.request,
      system: call.request.system ? `${call.request.system}\n\n${block}` : block,
    };
    return next();
  }, { prepend: true, description: 'system prompt 对话信息块（尾档·prepend 居前）' });
}
