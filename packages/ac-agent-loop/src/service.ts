// ============================================================
// ac-agent-loop/src/service.ts —— ReAct 循环服务（cordis Service）
//
// 本包同时是循环域契约的 owning package：域类型见 ./contract.ts，
// loop/* 事件目录见 ./events.ts（谁 emit 谁声明）；跨域词汇
// （LlmMessage 等）type-import 自 owning 包 ac-llm / ac-tools。
//
// ctx.agentLoop.run(request)：能力调用（有返回值、依赖由 inject 保证）。
// ctx.agentLoop.steer(handle, message)：向活跃 run 注入消息（ADR-1；
//   handle = runAddress(agent, conversationId)，ac-conversation 的串行化门
//   与本方法共用同一寻址词汇）。
// 边界全部事件化（./events.ts）：
//   · loop/before-run（waterfall；cr-881 三档退役后为唯一 run 前事件——
//     通用 run 边界 seam：veto/预算/messages 改写/懒准备；系统提示词
//     装配走 PromptSection 注册制（./sections.ts），run() 入口按具名
//     order 组装，先于本链）—— 改写请求 / veto / 包裹观察
//   · loop/run-started（emit）—— run 开始通知（三档全过后）
//   · loop/after-run（emit）—— 持久化/审计/指标订阅
//   · loop/before-step（waterfall）—— 改写本步消息
//   · loop/step-started（emit）—— step 开始通知（before-step 通过后）
//   · loop/after-step（emit）—— 步级订阅
//   · loop/run-idle（waterfall，2026-02-00）—— 自然停点拦截：领域行可注入
//     材料续走同 run（ask_questions 答案等待）；全体空手 → 收束照旧
// 工具执行走 ctx.tools.execute → 自动获得 tool/before-execute
// 拦截链（veto/改写）与 tool/after-execute 通知 —— 循环不重新实现拦截。
// 中断（ADR-2 最小方案）：request.signal 在 step 边界检查 →
//   finish='interrupted' + interruptReason。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { sessionCapsOf, toolAllowedFor } from 'ac-agents';
import { describeError } from 'ac-error-core';
// run 寻址/工具规范化——cr-318 下沉 ac-core-utils 的词汇（本包仍是协议
// owning，单源住纯库；其余三词汇包内无使用、不在本包导出）
import { normalizeToolSpecs, runAddress } from 'ac-core-utils';
import type { LlmMessage, LlmToolCall, LlmToolSpec, LlmUsage } from 'ac-llm';
import type {
  FrozenPromptSection,
  LoopInterruptReason,
  LoopRunCall,
  LoopRunRequest,
  LoopRunResult,
  LoopRunTransform,
  LoopRunUsage,
  LoopStepCall,
  LoopStepRecord,
  LoopStepTransform,
} from './contract.ts';
import {
  assembleSystemPrompt,
  RESERVED_SECTION_NAMES,
  SECTION_ORDER,
  validateSectionName,
  validateSectionOrder,
  type RegisteredSection,
  type SectionContribution,
} from './sections.ts';

/** 工具调用 arguments（JSON 字符串）→ 参数对象；解析失败透传原文 */
function parseArgs(tc: LlmToolCall): Record<string, unknown> {
  if (!tc.arguments) return {};
  try {
    const parsed = JSON.parse(tc.arguments);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { __raw: tc.arguments };
  } catch {
    return { __raw: tc.arguments };
  }
}

/** signal.reason → 可读文本 */
function abortText(signal: AbortSignal): string | undefined {
  const r = signal.reason;
  if (r instanceof Error) return r.message;
  if (typeof r === 'string' && r) return r;
  return undefined;
}

/**
 * 有界并发映射（对齐 src mapLimit(5)：同一步的多个工具调用并发执行，
 * 结果按输入序回填——OpenAI 多工具调用语义要求 tool 消息与
 * tool_calls 顺序一致）。limit=1 即串行。
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 合并单步用量到 run 统计（双轨制，src accumulateUsage 语义原样）：
 *   prompt/total → 覆盖为最新值（当次上下文大小，供归档阈值判断）；
 *   promptAccumulated/totalAccumulated/completion/cache → 累加（展示总用量）；
 *   steps → 每次供给 +1（react_steps）。
 */
function mergeUsage(
  acc: LoopRunUsage | undefined,
  usage: LlmUsage,
  elapsedMs: number | undefined,
): LoopRunUsage {
  if (!acc) {
    return {
      prompt: usage.prompt,
      completion: usage.completion,
      ...(usage.total != null ? { total: usage.total } : {}),
      promptAccumulated: usage.prompt,
      ...(usage.total != null ? { totalAccumulated: usage.total } : {}),
      ...(usage.cacheHit != null ? { cacheHit: usage.cacheHit } : {}),
      ...(usage.cacheMiss != null ? { cacheMiss: usage.cacheMiss } : {}),
      steps: 1,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    };
  }
  const out: LoopRunUsage = {
    ...acc,
    prompt: usage.prompt, // 覆盖轨：当次上下文
    completion: acc.completion + usage.completion,
    promptAccumulated: acc.promptAccumulated + usage.prompt,
    steps: acc.steps + 1,
    ...(elapsedMs !== undefined ? { elapsedMs: (acc.elapsedMs ?? 0) + elapsedMs } : {}),
  };
  if (usage.total != null) {
    out.total = usage.total; // 覆盖轨
    out.totalAccumulated = (acc.totalAccumulated ?? 0) + usage.total;
  }
  if (usage.cacheHit != null) out.cacheHit = (acc.cacheHit ?? 0) + usage.cacheHit;
  if (usage.cacheMiss != null) out.cacheMiss = (acc.cacheMiss ?? 0) + usage.cacheMiss;
  return out;
}

// runAddress / pairKey / ARCHIVE_REVIEW_META / isArchiveReviewRun /
// normalizeToolSpecs 已下沉 ac-core-utils（cr-318：跨行协议词汇单源，
// 8+ 包值导入免拉插件行）——本包 import 自用，protocol 注释见彼处。

/**
 * steer 队列（run 生灭）：
 *   · items——待注入消息 + 投递元数据
 *   · durable——run 级驻留注入（2026-09-21 裁决：技能正文等长效材料）：进
 *     数组一次、后续步自然继承（前缀稳定——KV 全命中；取代旧「每步
 *     before-step 重现」形态——那会在每次请求尾部重算整块正文）。
 *     与 items 同点消费（步边界 splice），但不参与 steer 的丢弃/sealed
 *     语义（长效材料不是投递消息——迟到注入仍可入队，消费点在下一步）。
 *   · sealed——收束判定已过：不再接受新注入（迟到的 steer 返回 false，
 *     ac-conversation 优雅回落 next-run：消息作为下一条独立 run 的入站，
 *     入账一次、不丢不重——D3 修复的核心）
 */
interface SteerQueue {

  items: Array<{ message: LlmMessage; sender?: string; source?: string }>;

  durable: LlmMessage[];

  sealed: boolean;

}

export class AgentLoopService extends Service {
  /** 活跃 run 的 steer 队列（runAddress → 队列）；随 run 生灭 */
  private steerQueues = new Map<string, SteerQueue>();

  /** system prompt 段注册表（cr-881 注册制；cr-944 动态化）：段名 → 贡献。
   *  注册随 fiber 归属自动回收（ctx.fiber.effect）；同名重复注册抛错。 */
  private promptSections = new Map<string, RegisteredSection>();

  /** 段装配前置缝（cr-944 P2b）：owner → 就绪回调。run() 入口第一拍 await
   *  全部回调（懒装配行在此完成段注册——如 host-face-client 远程段），先于
   *  singles 物化与 system 组装。回调抛错/超时放行（不得 veto run）。 */
  private sectionPrepares = new Map<string, () => Promise<void> | void>();

  constructor(ctx: Context) {
    super(ctx, 'agentLoop');
    // ---- ENV_MODEL 段（cr-881，自 ac-system-prompt 迁）：[模型能力] 行 ----
    // 注册住本服务构造器而非行 apply：本行 inject ['llm','tools']，自注册
    // 场景 apply 里走 ctx.agentLoop 即 "cannot get property without inject"
    //（cr-538 先例：同 fiber 自注册经服务实例直引）；visionOf 仍 use-time
    // 软取（段 provider 执行时 llm 服务在场——本行 inject ['llm'] 已保证）。
    // 防两类实测高频幻觉：视觉模型自认"看不了图"、文本模型硬猜图片内容。
    this.registerPromptSection({
      name: 'ENV_MODEL',
      text: (request) => {
        const llm = ctx.get('llm', false) as
          | { visionOf?(model: string, provider?: string): boolean | undefined }
          | undefined;
        if (typeof llm?.visionOf !== 'function') return '';
        const vision = llm.visionOf(request.model, request.provider);
        if (vision === true) {
          return `[模型能力] 当前对话模型 ${request.model} 支持图片输入（多模态）——用户消息中的附件图片会直接送达，请直接基于图片内容回答，不要声称无法查看图片`;
        }
        if (vision === false) {
          return `[模型能力] 当前对话模型 ${request.model} 为纯文本模型——附件以 [附件] 路径行提供，图片内容不可见（read 工具可读文本类附件）；涉及图片内容时如实说明这一限制，不要猜测或虚构图片`;
        }
        return ''; // 无能力元数据（undefined）零噪音
      },
    }, 'ac-agent-loop');
  }

  /**
   * system prompt 组装预览（cr-881）：与 run() 入口同源（同一注册面 + 同一
   * assembleSystemPrompt 纯函数），供 previewSystemPrompt 等干跑面镜像
   * 真实 run 的装配结果。纯读——不改注册面、不发 run。
   */
  assemblePreview(request: LoopRunRequest): string | undefined {
    // cr-888：frozenSections 分支与 run() 入口同源（快照段直组装，跳过注册面）
    return request.frozenSections !== undefined
      ? assembleSystemPrompt(request.frozenSections, request.system, request)
      : assembleSystemPrompt(this.promptSections.values(), request.system, request);
  }

  /**
   * 全段求值物化（cr-888 singles 前缀快照 ① 物化 / ③ 重算）：注册面按
   * request 逐段求值 → 静态段数组（快照正文 = 求值结果的冻结）。initial
   * 进 CALLER 段（order 0）；空串段不落（组装面本就跳过）。
   */
  materializeSections(request: LoopRunRequest, initial?: string): FrozenPromptSection[] {
    const out: FrozenPromptSection[] = [];
    if (initial !== undefined && initial !== '') {
      out.push({ name: 'CALLER', order: SECTION_ORDER.CALLER, text: initial });
    }
    const sorted = [...this.promptSections.values()]
      .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const s of sorted) {
      const text = typeof s.text === 'function' ? s.text(request) : s.text;
      if (text !== '') out.push({ name: s.name, order: s.order, text });
    }
    return out;
  }

  /**
   * 单段当前求值文本（cr-888 指纹键面——PTC_SDK 投影漂移检测）；
   * 段缺席 = ''（注册面漂移本身即指纹变化）。
   */
  sectionText(name: string, request: LoopRunRequest): string {
    const s = this.promptSections.get(name);
    if (s === undefined) return '';
    return typeof s.text === 'function' ? s.text(request) : s.text;
  }

  /**
   * 注册一条 system prompt 段（cr-881 次序数据化；cr-944 动态注册——name 任意
   * 非空串（CONVERSATION/DATETIME 核心保留）、order 自报 [0,900)，无词表审批）。
   * @param section 段名 + 段位 + 文本/provider + 自述
   * @returns 注销函数（显式注销可选；行卸载由 fiber 归属自动回收）
   */
  registerPromptSection(section: SectionContribution, owner: string): () => void {
    validateSectionName(section.name, owner);
    // 段位解析（cr-944）：显式 order 优先；缺省回落 SECTION_ORDER 核心惯例表
    //（核心行零改动——表值即单一来源）；既非显式又非惯例名 = fail-loud。
    const CORE_ORDER: Record<string, number | undefined> = SECTION_ORDER;
    const order = section.order ?? CORE_ORDER[section.name];
    if (order === undefined) {
      throw new Error('[prompt-section] 段位未声明且非核心惯例名（动态段须显式 order）: ' + section.name);
    }
    // 核心保留名 owner（CONVERSATION/DATETIME）豁免 900 上界（位在惯例表 900/910）
    const reserved = RESERVED_SECTION_NAMES.has(section.name);
    validateSectionOrder(order, reserved);
    if (this.promptSections.has(section.name)) {
      throw new Error('[prompt-section] 段名已注册: ' + String(section.name));
    }
    const entry: RegisteredSection = { ...section, order, owner };
    this.promptSections.set(section.name, entry);
    return this.ctx.fiber.effect(() => {
      this.promptSections.set(section.name, entry);
      return () => {
        // 同名再注册后的旧注销不得误删新条目
        if (this.promptSections.get(section.name) === entry) this.promptSections.delete(section.name);
      };
    }, `agentLoop.registerPromptSection(${String(section.name)})`);
  }

  /**
   * 注册段装配前置回调（cr-944 P2b）：懒装配行声明「run 组装前需要完成的
   * 注册动作」（如 host-face-client 远程段契约应用）。回调在 run() 入口第一拍
   * 执行——先于调用方的 singles 物化读面与 system 组装。
   * @returns 注销函数（fiber 归属自动回收）
   */
  registerSectionPrepare(fn: () => Promise<void> | void, owner: string): () => void {
    if (this.sectionPrepares.has(owner)) {
      throw new Error('[prompt-section] prepare 已注册: ' + owner);
    }
    this.sectionPrepares.set(owner, fn);
    return this.ctx.fiber.effect(() => {
      this.sectionPrepares.set(owner, fn);
      return () => {
        if (this.sectionPrepares.get(owner) === fn) this.sectionPrepares.delete(owner);
      };
    }, `agentLoop.registerSectionPrepare(${owner})`);
  }

  /**
   * 段装配前置拍（cr-944 P2b）：await 全部 prepare 回调。故障策略 = 放行：
   * 单回调抛错 warn 后继续、1500ms 超时放行——宿主离线/装配失败不得
   * veto run（段缺席走 §3 指纹 diff 的「新增段落」通知兜底，下 run 自愈）。
   */
  private async prepareSections(): Promise<void> {
    if (this.sectionPrepares.size === 0) return;
    await Promise.all([...this.sectionPrepares.values()].map(async (fn) => {
      try {
        await Promise.race([
          Promise.resolve(fn()).then(() => undefined, (err) => {
            this.ctx.logger.warn('[prompt-section] prepare 回调失败（放行）: ' + String(err instanceof Error ? err.message : err));
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 1500)),
        ]);
      } catch {
        // race 已吸收回调异常——防御性兜底
      }
    }));
  }

  /**
   * run 前拦截链（cr-881 三档退役后）：loop/before-run 单事件 waterfall
   * ——通用 run 边界 seam（veto/预算/messages 改写/懒准备），不再承载
   * 系统提示词装配语义（提示词组装走 PromptSection 注册制，run() 入口
   * 组装先于本链）。任一 veto 即否决下游全部（含 execute 与 run-started）。
   */
  private beforeRunChain(
    call: LoopRunCall,
    start: () => Promise<LoopRunResult>,
  ): Promise<LoopRunResult> {
    return this.ctx.waterfall('loop/before-run', call, start);
  }

  /**
   * 执行一轮 Agent 循环（拦截链内环）。
   * 拦截器 veto（不调 next）时直接返回拦截器提供的 LoopRunResult。
   */
  async run(request: LoopRunRequest): Promise<LoopRunResult> {
    // run 身份键（2026-09-24 身份贯通）：缺省铸造并塞回 request——此后
    // run-started/after-run 载荷、步级 envelope、llm 流式 meta、ToolCall
    // 全系携带同一值（before-run 档可读到；调用方自带则原样沿用）
    if (request.runId === undefined) {
      request.runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }
    // 段装配前置缝（cr-944 P2b）：懒装配行（远程段代理等）在此完成注册——
    // 先于 singles 物化（调用方在 run() 之前的快照对账）与 system 组装，
    // 「物化 = 全段求值」不变量由此成立。单回调抛错/超时放行（warn，不得
    // veto run——宿主离线不是会话错误）。
    await this.prepareSections();
    // system prompt 组装（cr-881）：PromptSection 注册制——run() 入口按
    // (order, name) 升序拼装（排序确定性 = 字节确定性），先于 before-run
    // 拦截链（拦截器读到的是组装后的终值；拦截器仍可改写 request.system）。
    const initial = request.system;
    // cr-888：物化段集在场 = singles 快照装配面——跳过注册面求值（快照 =
    // 求值结果的冻结），段序由快照 order 承载；initial 前缀照常拼首。
    const assembled = request.frozenSections !== undefined
      ? assembleSystemPrompt(request.frozenSections, initial, request)
      : assembleSystemPrompt(this.promptSections.values(), initial, request);
    if (assembled !== undefined) request.system = assembled;
    const call: LoopRunCall = { request };
    // steer 注册先于 before-run（同步）：run 受理即可被注入；
    // veto / 异常路径经 finally 回收。同地址并发 run 由 ac-conversation
    // 串行化门防止；直接调用方并发自担（后者覆盖前者队列，回收仅认领自己的）。
    const address = runAddress(request.agent, request.conversationId);
    if (address === undefined) {
      return this.beforeRunChain(call, () => this.execute(call.request, undefined));
    }
    const queue: SteerQueue = { items: [], durable: [], sealed: false };
    this.steerQueues.set(address, queue);
    const promise = this.beforeRunChain(call, () => this.execute(call.request, queue));
    return promise.finally(() => {
      if (this.steerQueues.get(address) !== queue) return;
      this.steerQueues.delete(address);
      // D3 残余观测：封口前已入队但未被消费（before-run veto 窗口）——
      // 消息已经 conversation/steered 事件入账/进视图，下一条自然 run
      // 可见（自愈）；发射通知供观测。不自动重投：next-turn 重投会经
      // router/message-received 二次入账（重复行）
      const dropped = queue.items.splice(0);
      if (dropped.length > 0) {
        this.ctx.emit('loop/steer-dropped', request.agent, request.conversationId, address, dropped);
      }
    });
  }

  /**
   * 向活跃 run 注入一条消息（ADR-1：steer 走 Service 方法，非事件）。
   * @param handle run 地址（= runAddress(agent, conversationId)）
   * @param meta 投递元数据（sender/source；steer-dropped 观测载荷用）
   * @returns false = 该地址无活跃 run 或已收束（sealed——D3：收束判定后
   *          的注入不再受理，调用方回落 next-run）
   */
  steer(handle: string, message: LlmMessage, meta?: { sender?: string; source?: string }): boolean {
    const queue = this.steerQueues.get(handle);
    if (!queue || queue.sealed) return false;
    queue.items.push({
      message,
      ...(meta?.sender !== undefined ? { sender: meta.sender } : {}),
      ...(meta?.source !== undefined ? { source: meta.source } : {}),
    });
    return true;
  }

  /**
   * run 级驻留注入（2026-09-21 裁决）：技能正文等长效材料进工作数组一次、
   * 后续步继承（前缀稳定 KV 全命中）。与 steer 的差异：不参与 sealed
   * 丢弃语义（run 收束后到达 = 无消费点，静默不入——调用方自持持久化
   * 通道，如 ac-skill 的 context 行落账）。
   * @param handle run 地址（= runAddress(agent, conversationId)）
   * @returns false = 该地址无活跃 run（正文持久性由调用方自己的落账承担）
   */
  injectDurable(handle: string, message: LlmMessage): boolean {
    const queue = this.steerQueues.get(handle);
    if (!queue) return false;
    queue.durable.push(message);
    return true;
  }

  private async execute(
    request: LoopRunRequest,
    steerQueue: SteerQueue | undefined,
  ): Promise<LoopRunResult> {
    const startedAt = Date.now(); // run 耗时（收束日志用）
    // run 开始通知（before-run 通过后；veto 不发）——WS 广播 / UI Turn 分组
    // 订阅面，不能挂在 before-run 决策链上
    this.ctx.emit('loop/run-started', request);
    const steps: LoopStepRecord[] = [];
    let usage: LoopRunUsage | undefined;
    // trigger/receive 双模式（对齐 src）：maxSteps > 0 = 上限；缺省/0 = 不限
    // （receive 模式靠"无工具调用"自然收束，中断由调用方 AbortSignal 负责）
    const maxSteps = request.maxSteps && request.maxSteps > 0 ? request.maxSteps : Infinity;
    // 工作消息：system + 历史；工具轮次在循环内追加（assistant/tool）
    const messages: LlmMessage[] = [
      ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
      ...request.messages,
    ];
    const specs = this.toolSpecs(request);
    // 请求面硬闸基线（cr-5）：run 开始时刻的注册面快照——run 期间动态
    // 注册的工具（插件安装中途启用等）不在其中，差集即「动态进面」放行集。
    // 闸门能力面判据用的 caps 同 router 口径（sessionCapsOf：会话授权注入
    // 含实验档 grants）——闸门只拦「本 Agent 能力面内的收窄越面」，不越权
    // 替安全行执法能力面外的调用。
    const baselineFace = new Set(this.ctx.tools.list().map((t) => t.name));
    const caps = sessionCapsOf(this.ctx, request.agent, request.conversationId);
    // 动态进面（run 期间新注册工具）：每步现算注册面 − 基线——插件安装等
    // 中途启用即自动进放行集，无需预知
    const dynamicFace = () => new Set(this.ctx.tools.list().map((t) => t.name).filter((n) => !baselineFace.has(n)));
    let finish: LoopRunResult['finish'] = 'stop';
    let error: string | undefined;
    let interruptReason: LoopInterruptReason | undefined;

    try {
      // 预算计数（2026-02-00 idle 续走改造）：budget 只数模型自主步；idle 注入的
      // 续走步不占预算（外部输入的接续，不是自主推理延长——见 events.ts
      // run-idle 契约注）。index 恒自然递增（步序唯一——settlement 折叠键）。
      let budget = 0;
      for (let index = 0; ; index++) {
        // step 边界中断检查（含首步之前）：已中止 → 保留已完成步收尾
        if (request.signal?.aborted) {
          finish = 'interrupted';
          const text = abortText(request.signal);
          interruptReason = { type: 'user-abort', ...(text ? { reason: text } : {}) };
          break;
        }
        // 消费 steer 注入（下一步生效；before-step 可继续改写）。
        // run 级驻留注入不在此消费——step() 内 before-step 后本步即取
        // （bade5362 实测：边界消费晚一步可见，模型困惑正文是否在场）
        const steering = steerQueue?.items.splice(0);
        if (steering && steering.length > 0) messages.push(...steering.map((s) => s.message));
        const step = await this.step(request, index, messages, specs, steerQueue);
        steps.push(step);
        if (step.usage) usage = mergeUsage(usage, step.usage, step.elapsedMs);
        // 中止步保真收束（cr-766）：本步 LLM 流被 abort——步记录（部分
        // text/reasoning）已照常入 steps 并发 after-step（journal 落盘），
        // 此处跳过工具执行（toolCalls 可能不完整——参数 JSON 截断）直接
        // 以 interrupted 收束。abortText 取 signal reason（与步边界检查
        // 同源）；无 reason 时如实缺省。
        if (step.aborted === true) {
          finish = 'interrupted';
          const text = request.signal ? abortText(request.signal) : undefined;
          interruptReason = { type: 'user-abort', ...(text ? { reason: text } : {}) };
          break;
        }

        // 自然收束条件：无工具调用且无待消费 steer（末轮 steer 不丢失）。
        // 自然停点拦截（2026-02-00 ask 挂起重构）：break 之前交给 loop/run-idle
        // waterfall——领域行（ask_questions 的答案等待）可注入材料续走同 run；
        // 全体空手 → 照旧 break。续走步不占 maxSteps（外部输入的接续，见
        // events.ts run-idle 契约注）。
        const pendingSteer = steerQueue !== undefined && steerQueue.items.length > 0;
        if (step.toolCalls.length === 0 && !pendingSteer) {
          const idleCall: LoopRunCall = { request };
          const injected = await this.ctx.waterfall('loop/run-idle', idleCall, async () => [] as LlmMessage[]);
          // 挂起中被中止（监听器自查 signal 空手返回）→ interrupted 收束，
          // 不把中止后的注入材料交给模型
          if (request.signal?.aborted) {
            finish = 'interrupted';
            const text = abortText(request.signal);
            interruptReason = { type: 'user-abort', ...(text ? { reason: text } : {}) };
            break;
          }
          if (injected.length === 0) break;
          // 尾部注入（2026-09-21 修正，session f5adb5d9 实测暴露：头部 splice
          // 使三次 LLM 调用 cacheHit 恒 5888、miss 30→425——system 后已缓存
          // 前缀整体后移；且答案在位置上先于用户原始消息，模型时序感知被
          // 扰乱）。自然停步的 assistant 终文本先补进工作数组（此前仅带
          // tool_calls 的步入数组——续走时停步文本缺席，run 内序与回放序
          // 分叉），注入材料尾部追加其后：run 内消息序与 settlement 回放
          // 序一致，跨 run 前缀可继承。契约注释见 events.ts
          messages.push(this.assistantOf(step));
          messages.push(...injected);
          continue; // 续走步不占预算（budget 不加；index 自然递增保步序唯一）
        }
        budget++;
        if (budget >= maxSteps) {
          // 预算耗尽：模型还想继续（带工具调用）→ max-steps；
          // 已给出终文本但 steer 仍待消费 → stop（steer 留给下一 run，
          // 由 ac-conversation 的会话上下文视图延续）
          if (step.toolCalls.length > 0) finish = 'max-steps';
          break;
        }
        messages.push(this.assistantOf(step));
        // 工具执行（M11）：执行身份随 call 装配（agentId/conversationId/
        // toolCallId + signal 透传）；同一步并发执行（mapLimit 5，对齐 src），
        // 结果按 tool_calls 序回填。elevation（access-tier §七）：机制分支
        // 临时提权随每步装配（档位矩阵 effectiveTier = call.elevation ??
        // tierOf(agentId)——安全行与工具行只读取）
        // 请求面硬闸（cr-5，editor~user 事故根因修复）：LLM 发出的工具名不在
        // request.tools 内 = 越面调用（DeepSeek 等推理端不校验 tool_calls 函数名，
        // 长历史浸泡下模型会模仿历史直调模式点名面外工具）。不执行、不 veto——
        // 回填带引导的纠错结果（面内可用工具 + 程序化模式正确入口），模型下一
        // 步自然回落。放行面 = 请求面 ∪ 动态进面（run 期间新注册的工具——插件
        // 安装中途启用等合法自进面，如 install_plugin 装好后即可调）；
        // request.tools 未定义（全注册面语义）不判定，零行为变化。
        const face = Array.isArray(request.tools) ? new Set(request.tools) : undefined;
        const toolResults = await mapLimit(step.toolCalls, 5, (tc) => {
          // 越面判定（能力面语义）：不在请求面 && 在本 Agent 能力面内 = 收窄越面
          // （幻觉直调主力形态——历史浸泡出的常规工具对本 Agent 全是能力面内，
          // 收窄后越面点名）→ 拦截。放行三支：请求面内；不在能力面（admin 自举
          // 工具对低权 Agent 本就不可见，interrupt/审批链路是既有语义——闸门
          // 不越权替安全行执法）；run 期间动态进面（插件安装中途启用）。
          const offFace = face !== undefined && !face.has(tc.name)
            && !dynamicFace().has(tc.name)
            && toolAllowedFor(this.ctx.tools.get(tc.name), caps);
          if (face === undefined || !offFace) {
            return this.ctx.tools.execute({
              name: tc.name,
              args: parseArgs(tc),
              ...(request.agent !== undefined ? { agentId: request.agent } : {}),
              ...(request.conversationId !== undefined
                ? { conversationId: request.conversationId }
                : {}),
              ...(request.runId !== undefined ? { runId: request.runId } : {}),
              ...(tc.id ? { toolCallId: tc.id } : {}),
              ...(request.signal ? { signal: request.signal } : {}),
              ...(request.elevation ? { elevation: request.elevation } : {}),
            });
          }
          this.ctx.logger.warn(
            '[loop] 越面工具调用已拦截（cr-5 请求面硬闸）run=%C step=%C 拦截=%C——面内工具=%C',
            request.runId ?? '(none)',
            String(index),
            tc.name,
            request.tools!.join(','),
          );
          return Promise.resolve({
            ok: false,
            error: `工具 ${tc.name} 不在本 run 工具面，调用未执行。本 run 可用工具：${request.tools!.join(',')}。${face.has('run_code') ? '本会话为程序化模式：请改用 run_code 编排调用（tools.<name> 子调用形态）。' : '请改用面内工具完成任务。'}`,
          });
        });
        for (let i = 0; i < step.toolCalls.length; i++) {
          step.toolResults.push(toolResults[i]);
          messages.push({
            role: 'tool',
            tool_call_id: step.toolCalls[i].id,
            content: JSON.stringify(toolResults[i]),
          });
        }
      }
    } catch (err) {
      // 中止归因（subagent 看门狗超时 / 用户中断直达传输层）：signal 已
      // 中止时的任何抛错（fetch AbortError、provider 中止拒绝）都是中断
      // 而非故障——如实标 interrupted + user-abort（abortReason 由调用方
      // 语义化，loop 只认 signal 状态）。此前无差别归 error：子 Agent 超时
      // 在 LLM 请求中段 abort 时终态误标 error（"This operation was
      // aborted"），ac-subagent 据此错报 timeout 语义。
      if (request.signal?.aborted) {
        finish = 'interrupted';
        const text = abortText(request.signal) ?? describeError(err);
        interruptReason = { type: 'user-abort', ...(text ? { reason: text } : {}) };
      } else {
        finish = 'error';
        // describeError 展开 cause 链（2026-09-05 nana 事故：Node fetch
        // 失败 message 只有 "fetch failed"，真实原因在 cause——裸 message
        // 落会话不可诊断）；非 Error 输入 String 兜底
        error = describeError(err);
      }
    }

    // D3 收束封口：settle 判定已过——此后到 run() finally 删队列之间
    // （transform-run waterfall + after-run emit 的异步窗口）迟到的
    // steer() 返回 false，ac-conversation 回落 next-run（消息入账一次、
    // 不丢不重）。此前窗口内 steer() 仍 true → 入账+ack 已注入 → 队列
    // 连消息一并删除，本轮永不消费。
    if (steerQueue) steerQueue.sealed = true;

    const result: LoopRunResult = {
      steps,
      text: steps.at(-1)?.text ?? '',
      // run 墙钟耗时（cr-772）：终稿行 runMs 的取源——历史链栏耗时锚
      wallMs: Date.now() - startedAt,
      finish,
      ...(error ? { error } : {}),
      ...(interruptReason ? { interruptReason } : {}),
      usage: usage ?? { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
    };
    const payload: LoopRunTransform = { request, result };
    // transform-run 终值（seam 语义见 events.ts 目录）
    const final = await this.ctx.waterfall('loop/transform-run', payload, async () => payload.result);
    this.logRunSettlement(request, final, startedAt);
    this.ctx.emit('loop/after-run', request, final);
    return final;
  }

  /**
   * run 收束日志（M18 调试可见性：步数/耗时/用量/缓存/终态一目了然）。
   * in/out = 累加轨（全部步输入/输出之和）；cache = 缓存命中率
   * （hit/(hit+miss) 的 token 口径，无缓存数据时 '-'）
   */
  private logRunSettlement(request: LoopRunRequest, final: LoopRunResult, startedAt: number): void {
    const hit = final.usage.cacheHit ?? 0;
    const miss = final.usage.cacheMiss ?? 0;
    const cacheRate = hit + miss > 0 ? `${((hit / (hit + miss)) * 100).toFixed(1)}%` : '-';
    // API 速率（token/秒，输出口径）：completion ÷ API 流时间累加（elapsedMs
    // 口径见 dispatch 注释——工具执行/编排不计入）。不用 total：prompt 随
    // 上下文单调膨胀，Σtotal/Σms 持续虚高（反映上下文膨胀而非吞吐）。
    // 无计时数据的旧链路 = '-'。
    const apiMs = final.usage.elapsedMs;
    const tps = apiMs
      ? (final.usage.completion / apiMs * 1000).toFixed(1) + 't/s'
      : '-';
    this.ctx.logger.info(
      '[loop] run 收束 agent=%C conv=%C finish=%C steps=%C elapsed=%Cms in=%C out=%C total=%C cache=%C(hit=%C/miss=%C) tps=%C',
      request.agent ?? '(直连)',
      request.conversationId ?? request.agent ?? '-',
      final.finish,
      String(final.steps.length),
      String(Date.now() - startedAt),
      String(final.usage.promptAccumulated),
      String(final.usage.completion),
      String(final.usage.totalAccumulated ?? final.usage.promptAccumulated + final.usage.completion),
      cacheRate,
      String(hit),
      String(miss),
      tps,
    );
  }

  /**
   * 步 → assistant wire 消息（tool_calls 原样映射；idle 续走补停步文本复用）。
   * thinking 回放（cr-98）：reasoning + thinkingSignature 透传——Anthropic
   * 协议适配层（toAnthropicMessages）据此重建 thinking 块，其余协议忽略。
   */
  private assistantOf(step: LoopStepRecord): LlmMessage {
    return {
      role: 'assistant',
      content: step.text,
      ...(step.reasoning ? { reasoning: step.reasoning } : {}),
      ...(step.thinkingSignature ? { thinkingSignature: step.thinkingSignature } : {}),
      ...(step.toolCalls.length > 0
        ? {
            tool_calls: step.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
              // 中性签名位（cr-443 Gemini thoughtSignature；Anthropic 走消息级
              // thinkingSignature）：Gemini 库 toGeminiContents 读本键回传
              ...(tc.signature ? { signature: tc.signature } : {}),
            })),
          }
        : {}),
    };
  }

  /** 单步：before-step waterfall（可改写本步消息）→ llm.chat → transform-step → after-step emit */
  private async step(

    request: LoopRunRequest,

    index: number,

    messages: LlmMessage[],

    specs: LlmToolSpec[] | undefined,

    steerQueue: SteerQueue | undefined,

  ): Promise<LoopStepRecord> {
    // conversationId 随步载体出生（2026-09-05 /name 手势注入需要会话键解析
    // singles 工作区技能——M25 §3.1 同款"真实需要出生"原则）
    const stepCall: LoopStepCall = { agent: request.agent, messages, conversationId: request.conversationId };
    // 信封子集（M13 载荷增强）：step/delta 级事件与 llm 调用共用，
    // WS 桥接按它过滤后台会话（source='event' 的流式输出不广播）。
    // runId/stepId（2026-09-24 身份贯通）：前端 delta 帧按键直达步载体
    const stepId = `${request.runId}:${index}`;
    const envelope = {
      runId: request.runId,
      stepId,
      conversationId: request.conversationId,
      sender: request.sender,
      source: request.source,
    };
    const record = await this.ctx.waterfall('loop/before-step', stepCall, async () => {

      // 【本步消费 run 级驻留注入（bade5362 实测反馈修复）】before-step 住户

      // （如 ac-skill injectDurable 入队）刚跑完——队内如有驻留材料，立刻进

      // 本步消息与工作数组（旧实现只入队、等下一边界消费 = 晚一步可见，

      // 实测模型在下一步 reasoning 里困惑「正文到底在不在」并浪费一次核查）。

      // 双写：stepCall.messages（本步请求）+ messages（工作数组——后续步继承）。

      const pendingDurable = steerQueue !== undefined ? steerQueue.durable.splice(0) : undefined;

      if (pendingDurable !== undefined && pendingDurable.length > 0) {

        stepCall.messages = [...stepCall.messages, ...pendingDurable];

        messages.push(...pendingDurable);

      }

      // step 开始通知（before-step 通过后、llm.chat 前；载荷 = 实际送入模型的消息）

      this.ctx.emit('loop/step-started', request.agent, index, stepCall.messages, envelope);
      const res = await this.ctx.llm.chat({
        ...(request.provider ? { provider: request.provider } : {}),
        model: request.model,
        messages: stepCall.messages,
        ...(specs ? { tools: specs } : {}),
        // 中断透传（C3）：signal 直达传输层（fetch abort），否则用户中断
        // /子代理超时只在步边界生效——当前步 LLM 请求照跑完整轮（token
        // 照扣、会话门不释放）。契约字段早已就位，纯接线遗漏。
        ...(request.signal ? { signal: request.signal } : {}),
        // 采样参数透传（M15：per-Agent 调参；键集由 ac-agents 白名单过滤）
        ...(request.llmParams ? request.llmParams : {}),
        meta: {
          agent: request.agent,
          conversationId: request.conversationId,
          sender: request.sender,
          source: request.source,
          // 身份贯通：delta-* 帧按键路由（dispatch 剥离，不进 provider body）
          runId: request.runId,
          stepId,
        },
      });
      return {
        index,
        // 步身份键（身份贯通）：与 envelope.stepId 同值——after-step 事件
        // 与 journal 落盘（SessionStepRecord.stepId）透传
        stepId,
        text: res.text,
        ...(res.reasoning ? { reasoning: res.reasoning } : {}),
        // 中止步保真（cr-766）：aborted 标记 + 相位时长透传——中断步的
        // 部分聚合照常入档（textMs/reasoningMs 均以最后片时刻收口）
        ...(res.aborted ? { aborted: true } : {}),
        toolCalls: res.toolCalls ?? [],
        toolResults: [] as LoopStepRecord['toolResults'],
        ...(res.textBeforeTools !== undefined ? { textBeforeTools: res.textBeforeTools } : {}),
        ...(res.reasoningMs !== undefined ? { reasoningMs: res.reasoningMs } : {}),
        ...(res.textMs !== undefined ? { textMs: res.textMs } : {}),
        ...(res.thinkingSignature !== undefined ? { thinkingSignature: res.thinkingSignature } : {}),
        ...(res.elapsedMs !== undefined ? { elapsedMs: res.elapsedMs } : {}),
        ...(res.usage ? { usage: res.usage } : {}),
        ...(res.finish ? { finish: res.finish } : {}),
      } satisfies LoopStepRecord;
    });
    // transform-step 终值（seam 语义见 events.ts 目录）：入档与通知均为变换后值
    const transform: LoopStepTransform = { agent: request.agent, step: record };
    const finalStep = await this.ctx.waterfall('loop/transform-step', transform, async () => transform.step);
    // 步级时序锚（2026-09-02 顺序反馈）：transform 可替换对象——ts 在变换后
    // 盖章（变换器不关心、也无需保留）；落盘行 steps[].ts 据此恢复中途插行的渲染序
    if (finalStep.ts === undefined) finalStep.ts = Date.now();
    this.ctx.emit('loop/after-step', request.agent, finalStep, envelope);
    return finalStep;
  }

  /**
   * 工具名清单 → LlmToolSpec[]（normalizeToolSpecs 规范化：字典序，
   * 与注册/装卸时序解耦——M21/D4）
   */
  private toolSpecs(request: LoopRunRequest): LlmToolSpec[] | undefined {
    const specs = normalizeToolSpecs(this.ctx.tools.list(), request.tools);
    if (specs.length === 0) return undefined;
    return specs;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** ReAct 循环服务（ac-agent-loop 提供；边界事件见本包 ./events.ts） */
    agentLoop: AgentLoopService;
  }
}
