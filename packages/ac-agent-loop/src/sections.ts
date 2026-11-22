// ============================================================
// ac-agent-loop/src/sections.ts —— system prompt 段注册契约（cr-881；cr-944 动态化）
//
// PromptSection 注册制：system prompt 的次序从控制流挪进数据（排序键）。贡献方
// 注册具名段，agent-loop 在 run() 入口按 (order, name) 升序组装——排序确定性 =
// 字节确定性（KV cache 前缀稳定）。
//
// cr-944 裁决 A（2026-11-08）：动态注册机制——name 开放任意非空串、order 贡献方
// 自报，无词表审批（对齐「包即插件」——生态行教用法不再需要上游划区）。两条边界：
//   · order ∈ [0, 900)：900+ 为会话动态收尾区（CONVERSATION/DATETIME 核心保留）——
//     「日期翻只失效日期行自身」的 KV 不变量要求日期行居尾，此为技术边界。
//   · SECTION_ORDER 降级为核心行共用惯例表（单源防魔法数字漂移），不构成注册
//     白名单；生态段建议落 300-899 惯例带（指引 300-499 / 扩展 500+）。
//
// cr-944 裁决 D（判据 v2 认知信息分层，docs/design/platform/prompt-section-ecosystem-fix.md §8）：
// 身份（0-99）→ 词汇（100-199 聚簇）→ 世界模型（200-299）→ 行为指令（300-499）→
// 参考材料（450+，指令后动态前——字典式投影不吃 primacy 红利）→ 会话动态（900+）。
// PTC_SDK 150→450：数 KB 参考块让出认知链框架位；词汇层聚簇 110/114/118/122。
// SKILLS 30 位随 cr-1249 退役——<available_skills> 移出 system（before-run
// 指纹注入，datetime/env-pulse 同构），位号不回收不复用。
//
// 不引入（cr-881 延续）：complete 排他段、变量插值、PromptContext 快照化。
// ============================================================
import type { LoopRunRequest } from './contract.ts';

/** 核心段惯例位分配表（cr-944：闸门→惯例——核心行单源引用防魔法数字，
 * 不约束生态段注册。语义分组：身份（0-99）→ 词汇（100-199）→ 世界模型（200-299）
 * → 行为指令（300-499）→ 参考材料（450+）→ 会话动态（900+）。 */
export const SECTION_ORDER = {
  CALLER: 0, // request.system 初始值（调用方前缀——物化快照段名，无注册方）
  PERSONA: 10, // <persona> 人设块
  MEMORY: 20, // 记忆静态指引
  REFERENCE_FS: 110, // [引用约定] @路径（ac-fs-tools）
  REFERENCE_AGENT: 114, // @名称引用（ac-collab-tools）——组内 4 间隔留插入位
  REFERENCE_SESSION: 118, // #会话引用（位保留——read_history/grep_history 工具描述自带）
  TERMINOLOGY: 122, // 术语约定（cr-944 聚簇：词汇层连续成链，原 250 环境区归位）
  ENV_WORKDIR: 200, // [工作目录] + [路径穿透白名单]
  ENV_HOST: 210, // [宿主环境]
  ENV_MODEL: 220, // [模型能力]
  GUIDELINES_FS: 300, // 指引：文件操作
  GUIDELINES_SHELL: 310, // 指引：命令执行
  GUIDELINES_JOBS: 320, // 指引：后台任务
  GUIDELINES_WEB: 330, // 指引：网络结果防注入
  GUIDELINES_ARTIFACTS: 340, // 指引：产出物引用
  GUIDELINES_COLLAB: 350, // 指引：多Agent协作 + 群聊协作
  GROUP_CONTRACT: 355, // 群聊行为契约（cr-944 P3：纯行为规则静态化——群身份单源 CONVERSATION）
  GUIDELINES_TIMER: 360, // 指引：主动安排（远程段；cr-944 C singles 亦注入；cr-1164 哑触发层心智）
  GUIDELINES_ASK: 370, // 指引：不可逆操作前询问
  GUIDELINES_SUBAGENT: 380, // 指引：并行子任务
  GUIDELINES_GOAL: 390, // 指引：目标与待办（goal）
  GUIDELINES_TODO: 391, // 指引：目标与待办（todo）
  GUIDELINES_ISSUE: 400, // 指引：问题反馈
  CONDUCT: 410, // 专业客观
  PTC_SDK: 450, // run_code SDK 投影（cr-944 D：150→450 参考材料让出框架位）
  CONVERSATION: 900, // 对话信息块（会话动态）
  DATETIME: 910, // 日期行（绝对收尾）
} as const;

/** 核心段名（SECTION_ORDER 键；cr-944 后仅为惯例表类型，注册面见 SectionName） */
export type CoreSectionName = keyof typeof SECTION_ORDER;

/** 会话动态收尾区下界（注册期硬边界：order ∈ [0, 900)——护「日期行居尾」KV 不变量） */
export const DYNAMIC_ORDER_FLOOR = 900;

/** 900+ 动态区核心保留名的 owner 白名单（生态不得注册——防撞名后以任意
 * order 落入动态区语义；核心 owner 行不受限）。 */
const RESERVED_SECTION_OWNERS: Record<string, string | undefined> = {
  CONVERSATION: 'ac-conversation',
  DATETIME: 'ac-datetime',
};

/** 核心保留名集合（owner 白名单键面——注册面豁免 900 上界用） */
export const RESERVED_SECTION_NAMES: ReadonlySet<string> = new Set(Object.keys(RESERVED_SECTION_OWNERS));

/** 段名校验（注册入口唯一通道）：非空串；核心保留名仅限对应 owner。 */
export function validateSectionName(name: string, owner?: string): string {
  if (name === '' || name.trim() !== name) throw new Error('[prompt-section] 段名非法（空或首尾空白）: ' + JSON.stringify(name));
  const reservedOwner = RESERVED_SECTION_OWNERS[name];
  if (reservedOwner !== undefined && owner !== reservedOwner) {
    throw new Error('[prompt-section] 段名为 900+ 动态区核心保留名（仅 ' + reservedOwner + ' 可注册）: ' + name);
  }
  return name;
}

/** order 校验（注册入口唯一通道）：[0, 900)——生态段永不越过会话动态收尾区。
 * reserved=true（核心保留名 owner——CONVERSATION/DATETIME）豁免上界：其位
 * 由 SECTION_ORDER 惯例表单源（900/910），非生态自报。 */
export function validateSectionOrder(order: number, reserved = false): number {
  if (!Number.isInteger(order) || order < 0 || (!reserved && order >= DYNAMIC_ORDER_FLOOR)) {
    throw new Error(`[prompt-section] order 越界（须整数 ∈ [0, ${DYNAMIC_ORDER_FLOOR})）: ${order}`);
  }
  return order;
}

/** 核心段惯例位解析（核心行单源引用；cr-944 前的未知名抛错闸随动态化退役） */
export function sectionOrder(name: CoreSectionName): number {
  return SECTION_ORDER[name];
}

/** 一条 system prompt 段贡献（注册输入）。text 为静态串或 per-run provider；
 * provider 返回空串 = 本 run 不贡献。KV 纪律（cr-944 §8 判据）：自报段 text 须
 * per-run 稳定；会话动态内容不进自报段（900+ 区或 context 行是正位）。 */
export interface SectionContribution {
  /** 段名（生态任意非空串，建议 行名-前缀 防撞；CONVERSATION/DATETIME 保留） */
  name: string;
  /** 段位（自报；[0,900)——按判据 v2 分层选位。核心惯例名（SECTION_ORDER 键）
   *  可缺省回落表值；动态段必填 */
  order?: number;
  /** 静态文本或 per-run 求值（门控/环境信息收集住此） */
  text: string | ((request: LoopRunRequest) => string);
  /** 自述（治理 UI / 诊断） */
  description?: string;
}

/** 段注册表条目（name 唯一性由注册方校验） */
export interface RegisteredSection {
  name: string;
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