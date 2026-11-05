// ============================================================
// ac-agent-loop/src/sections.ts —— system prompt 段注册契约（cr-881）
//
// PromptSection 注册制（dsh 适配版）：system prompt 的次序从控制流
//（三档装配链 + 各收敛式 hack）挪进数据（排序键）。贡献方注册具名段，
// agent-loop 在 run() 入口按 (order, name) 升序组装——排序确定性 =
// 字节确定性（KV cache 前缀稳定）。
//
// 设计裁决（docs/design/system-prompt-decentralization-plan.md）：
//   · SECTION_ORDER 具名分配——数值单源在本表，贡献方不写裸数字；
//     未知名注册抛错（fail-loud 防拼错名静默落错位）。
//   · text 可为静态串或 per-run provider（门控逻辑住 provider 内，
//     空串不贡献——dsh "Empty text contributes nothing"）。
//   · 不引入 dsh 的 complete 排他段（override 语义已废弃）、变量插值、
//     PromptContext 快照化。
// ============================================================
import type { LoopRunRequest } from './contract.ts';

/** system prompt 段的具名 order 分配表（数值单源；升序拼装）。
 * 语义分组：人格/知识（0-99）→ 引用/投影（100-199）→ 环境（200-299）→
 * 指引（300-499）→ 会话动态（900+，静态在前、动态收尾——KV 前缀友好）。 */
export const SECTION_ORDER = {
  CALLER: 0, // request.system 初始值（调用方前缀）
  PERSONA: 10, // <persona> 人设块
  MEMORY: 20, // 记忆静态指引
  SKILLS: 30, // <available_skills> 技能目录
  REFERENCE_FS: 110, // [引用约定] @路径（ac-fs-tools）
  REFERENCE_AGENT: 111, // @名称引用（ac-collab-tools）
  REFERENCE_SESSION: 112, // #会话引用（ac-agents）
  PTC_SDK: 150, // run_code 程序化 SDK 投影段
  ENV_WORKDIR: 200, // [工作目录] + [路径穿透白名单]
  ENV_HOST: 210, // [宿主环境]
  ENV_MODEL: 220, // [模型能力]
  TERMINOLOGY: 250, // 术语约定
  GUIDELINES_FS: 300, // 指引：文件操作
  GUIDELINES_SHELL: 310, // 指引：命令执行
  GUIDELINES_JOBS: 320, // 指引：后台任务
  GUIDELINES_WEB: 330, // 指引：网络结果防注入
  GUIDELINES_ARTIFACTS: 340, // 指引：产出物引用
  GUIDELINES_COLLAB: 350, // 指引：多Agent协作 + 群聊协作
  GROUP_CONTRACT: 355, // 群聊行为契约（会话动态：群名 + 回复走 send_group）
  GUIDELINES_TIMER: 360, // 指引：主动安排
  GUIDELINES_ASK: 370, // 指引：不可逆操作前询问
  GUIDELINES_SUBAGENT: 380, // 指引：并行子任务
  GUIDELINES_GOAL: 390, // 指引：目标与待办（goal）
  GUIDELINES_TODO: 391, // 指引：目标与待办（todo）
  GUIDELINES_ISSUE: 400, // 指引：问题反馈
  CONDUCT: 410, // 专业客观
  CONVERSATION: 900, // 对话信息块（会话动态）
  DATETIME: 910, // 日期行（绝对收尾）
} as const;

export type SectionName = keyof typeof SECTION_ORDER;

/** 具名 order 解析（注册入口唯一通道）。未知名在类型层已排除（SectionName
 * 即表键）；as never 绕过类型时经 Record 查表兜底（值缺失 = 表与类型漂移）。 */
const ORDER_TABLE: Record<string, number | undefined> = SECTION_ORDER;

export function sectionOrder(name: SectionName): number {
  const v = ORDER_TABLE[name];
  if (v === undefined) throw new Error('[prompt-section] 未知的段名: ' + String(name));
  return v;
}

/** 一条 system prompt 段贡献（注册输入）。text 为静态串或 per-run
 * provider；provider 返回空串 = 本 run 不贡献。 */
export interface SectionContribution {
  /** 具名段位（SECTION_ORDER 键）——次序数据化，贡献方不写裸数字 */
  name: SectionName;
  /** 静态文本或 per-run 求值（门控/环境信息收集住此） */
  text: string | ((request: LoopRunRequest) => string);
  /** 自述（治理 UI / 诊断） */
  description?: string;
}

/** 段注册表条目（name 唯一性由注册方校验） */
export interface RegisteredSection {
  name: SectionName;
  order: number;
  text: string | ((request: LoopRunRequest) => string);
  description?: string;
  owner: string;
}

/** 组装输入的最小段形状（cr-888：物化快照段同形——text 恒静态串；
 * 注册面条目 RegisteredSection 结构兼容，两类输入共用组装纯函数）。 */
export interface AssembleSection {
  name: string;
  order: number;
  text: string | ((request: LoopRunRequest) => string);
  /** 注册面条目透传字段（组装面忽略——结构兼容 RegisteredSection） */
  owner?: string;
  description?: string;
}

/** 组装纯函数：(order, name) 升序 join，request.system 初始值作前缀。
 * 供 run() 入口与 previewSystemPrompt（含 cr-888 快照段）共用（同一事实源）。 */
export function assembleSystemPrompt(
  sections: Iterable<AssembleSection>,
  initial: string | undefined,
  request: LoopRunRequest,
): string | undefined {
  const parts: string[] = [];
  if (initial !== undefined && initial !== '') parts.push(initial);
  const sorted = [...sections].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const s of sorted) {
    const text = typeof s.text === 'function' ? s.text(request) : s.text;
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}