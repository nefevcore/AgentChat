// ============================================================
// ac-singles/src/service.ts —— 独立会话管理服务（cordis Service）
//
// 本包是独立会话域契约的 owning package：SingleSessionMeta 等
// 域类型在 contract.ts，singles/* 事件目录在 events.ts。
//
// 持久化（规约 1：本服务 owns <root>/singles/<sid>/session.json）：
//   <root>/singles/<sid>/session.json   元数据（Agent 引用 + 模型覆盖 +
//                                       工作区挂载 + 状态）
//   <root>/sessions/singles/<ws|ungrouped>/<sid>/messages.jsonl
//                                       消息流——归 ac-session（上架 shelving：
//                                       conversationId = sid 寻址不变，规约 2；
//                                       按工作区分子文件夹，未分组归 ungrouped）
//
// 跨域读取一律走服务方法（铁律 2：this.ctx.get）：
//   agents   → 引用校验（存在且非 virtual）
//   workspace → 工作区挂载校验
//   session  → hasMessages/lastActivity（消息文件属 ac-session 域）
// 硬删的消息清理同样经 ctx.session.clear(sid)（owning 写口）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Service, type Context } from '@agentchat/cordis';
import { isArchiveReviewRun, normalizeToolSpecs } from 'ac-agent-loop';
import { resolvePersonaText } from 'ac-persona';
import { splitModelRef } from 'ac-llm';
import type { LoopRunRequest, LoopStepRecord } from 'ac-agent-loop';
import type { SingleSessionMeta, SinglesCreateInput, SinglesUpdateInput } from './contract.ts';

export interface SinglesRowOptions {
  /** 数据根目录（缺省跟随启动 cwd（AGENTCHAT_DATA_ROOT），回退 './data'；元数据目录 = <root>/singles） */
  root?: string;
}

/** 标题长度上限（字符） */
const TITLE_MAX_LEN = 24;

/** 标题生成提示词（结合 Agent 首步思考/正文——概括「对话在谈什么」） */
const TITLE_PROMPT = (userText: string, agentFirstOutput?: string): string =>
  `根据下面的对话材料，为这段对话生成一个简短的中文标题（不超过${TITLE_MAX_LEN}字）。\n`
  + `要求：直接输出标题本身；不要引号、句号、解释或前后缀；概括意图而非复述原文。\n\n`
  + `用户消息：\n${userText.slice(0, 600)}`
  + (agentFirstOutput
    ? `\n\nAgent 的初步思考/回应（理解参考）：\n${agentFirstOutput.slice(0, 600)}`
    : '');

/** 清洗模型输出：去引号/换行/首尾空白，超长截断 */
function cleanTitle(raw: string): string {
  const t = raw.trim().replace(/^["'「『《]+|["'」』》]+$/g, '').split('\n')[0]?.trim() ?? '';
  return t.length > TITLE_MAX_LEN ? t.slice(0, TITLE_MAX_LEN) : t;
}

/** 回落标题：首条用户消息截断（LLM 失败/空回复时保底） */
function fallbackTitle(userText: string): string {
  const firstLine = userText.trim().split('\n')[0] ?? '';
  return firstLine.length > TITLE_MAX_LEN ? `${firstLine.slice(0, TITLE_MAX_LEN)}…` : firstLine;
}

/** [system + tool schema] 前缀快照（M21 步骤 4 / D5，§5.2；最新胜 fold-latest） */
export interface PrefixSnapshot {
  /** 装配输入全集修订键（persona/system/settings/生效工具集 schema/模型/llmParams/memory 哈希） */
  revision: string;
  /** 首跑/失效重拍时捕获的终态 system 全文（装配链跑完后的 request.system） */
  system: string;
  /** 规范化工具 schema 全集哈希（normalizeToolSpecs 同口径——字典序字节） */
  toolsHash: string;
  capturedAt: string;
}

/** sha256（十六进制；修订键/哈希计算） */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

export class SinglesService extends Service {
  private readonly singlesDir: string;
  /** 上架同步只跑一次（首次触及任意方法；幂等，重复跑无副作用） */
  private shelvesSynced = false;
  /** 标题生成中守卫（同会话并发 after-step/after-run 只触发一次） */
  private titleInFlight = new Set<string>();
  /** 待命名 run 暂存（sid → 路由终值 + 首条用户消息；after-step 取账生成，
   *  after-run 兜底清账——run-started 挂账 / 首步收束即用） */
  private pendingTitle = new Map<string, { model: string; provider?: string; userText: string }>();
  /** 前缀快照在途处置（sid → 本次 run：capture 首拍/失效重拍 | verify 键未变核验终态） */
  private prefixPending = new Map<string, { kind: 'capture' | 'verify'; revision: string; toolsHash: string }>();

  constructor(ctx: Context, options: SinglesRowOptions = {}) {
    super(ctx, 'singles');
    this.singlesDir = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data', 'singles');

    // ---- 自动标题（src singles.auto-title 的 preview 形态）----
    // 两段式：run-started 暂存「待命名 run」（路由终值 model/provider +
    // 首条用户消息，此刻最全）→ after-step（首个完成的步）结合 Agent
    // 首步思考/正文生成——标题概括的是「这轮对话在谈什么」，Agent 的
    // 首步理解比用户原始输入更准（工具轮里用户消息常常只是「继续」）。
    // fire-and-forget，不阻塞主对话流；失败回落首条消息截断。
    // 幂等守卫 = session.json 尚无 title（生成一次后永不再触发）；经
    // update() 写入 → singles/updated 事件 → 前端列表即时刷新。
    // 挂首步 after-step 而非 run-started 直出的权衡：多等首步 LLM 完成
    // （纯直答即首步；长工具轮也只在首个工具步后），换来标题贴合会话
    // 实质。after-step 每步重复发——pendingTitle 只在生成前挂账，fire
    // 即清（titleInFlight 防同会话并发）。
    // after-run 兜底：run 中途夭折（error/interrupted/首步异常）时 pending
    // 仍在账上——用暂存的首条用户消息走截断回落，会话不留无名列。
    // 机制 run（archive-review）不触发；非 singles 桶读不到记录自然短路。
    // C1：fire-and-forget 必须自带 catch——update() 落盘（Windows AV 锁/
    // 盘满可抛）发生在装饰性路径上，不得放大为宿主 unhandledRejection。
    this.ctx.on('loop/run-started', (request) => {
      this.stagePendingTitle(request);
    }, { description: '独立会话命名暂存（run-started）' });
    this.ctx.on('loop/after-step', (agent, step, envelope) => {
      void this.generateStagedTitle(envelope?.conversationId, step).catch((err: unknown) => {
        this.ctx.logger.error(
          '[singles] 标题生成失败（忽略）: %C',
          err instanceof Error ? err.message : String(err),
        );
      });
    }, { description: '独立会话首步后命名' });
    this.ctx.on('loop/after-run', (request) => {
      void this.flushPendingTitle(request.conversationId).catch((err: unknown) => {
        this.ctx.logger.error(
          '[singles] 标题兜底生成失败（忽略）: %C',
          err instanceof Error ? err.message : String(err),
        );
      });
    }, { description: '独立会话命名兜底（after-run）' });

    // ---- system+tools 前缀快照（M21 步骤 4 / D5，§5.2）----
    // 独立会话是最自包含形态（无对端 Agent、模型覆盖恒定 = 路由/缓存域
    // 恒定）——[system + tool schema] 前缀对该会话跨轮、跨重启字节不变。
    // 机制 = 修订键锚点 + 终态核验（M5-lite「请求可重建」的轻量版）：
    //   · before-run（gate，零变异、位置无关）：按装配输入全集计算修订键；
    //     键未变 → verify；键变/无快照 → capture。修订键必须覆盖装配
    //     输入白名单全集——漏键 = 静默陈旧（"换了组合历史将无法复现"，
    //     DSH agentPreset 同一论证）。
    //   · run-started（纯观察，装配链已收口）：capture → 持久化终态
    //     system + specs 哈希（sidecar 最新胜）；verify → 与快照逐字节
    //     对拍，漂移 = 装配不确定性 → fail-loud 告警。
    // system 字节稳定由「输入确定（M2a）+ 修订键覆盖」保证；快照提供
    // 显式失效（一次 replace，可审计）与漂移检测。残余失效清单（显式
    // 接受）：Agent 档案/人设编辑、生效工具集变化、模型覆盖修改（换
    // 缓存域）、memory 修订（D4：保留 system 位，按内容哈希进修订键）。
    this.ctx.on('loop/before-run', (call, next) => {
      this.snapshotGate(call.request);
      return next();
    }, { description: '独立会话历史装配' });
    this.ctx.on('loop/run-started', (request) => {
      this.snapshotObserve(request);
    }, { description: '独立会话运行态登记' });
  }

  /** 快照 gate：独立会话 run 计算修订键，决定本 run 是 capture 还是 verify */
  private snapshotGate(request: LoopRunRequest): void {
    const sid = request.conversationId;
    if (!sid || !request.agent) return;
    if (!this.get(sid)) return; // 非独立会话（一次小文件读；不存在 = miss）
    const { revision, toolsHash } = this.prefixRevision(request);
    const snap = this.readSnapshot(sid);
    this.prefixPending.set(sid, {
      kind: snap && snap.revision === revision ? 'verify' : 'capture',
      revision,
      toolsHash,
    });
  }

  /** run-started 观察：capture 持久化终态 / verify 对拍告警漂移 */
  private snapshotObserve(request: LoopRunRequest): void {
    const sid = request.conversationId;
    if (!sid) return;
    const pending = this.prefixPending.get(sid);
    if (!pending) return;
    this.prefixPending.delete(sid);
    if (!this.get(sid)) return;
    if (pending.kind === 'capture') {
      this.writeSnapshot(sid, {
        revision: pending.revision,
        system: request.system ?? '',
        toolsHash: pending.toolsHash,
        capturedAt: new Date().toISOString(),
      });
      return;
    }
    const snap = this.readSnapshot(sid);
    if (snap && (snap.system !== (request.system ?? '') || snap.toolsHash !== pending.toolsHash)) {
      this.ctx.logger.warn(
        '[singles] 前缀快照漂移（%C…）：修订键未变而终态 system/tools 变化——装配链存在不确定性，KV 前缀可能失效',
        sid.slice(0, 8),
      );
    }
  }

  /** 修订键 = 装配输入全集哈希（白名单显式枚举；跨域读取走 ctx.get；
   *  M24 A1：persona 与 settings 均经 settingsOf 合成全局默认层——
   *  漏合成 = persona 恒空 / 键漂移，KV 前缀快照静默失效） */
  private prefixRevision(request: LoopRunRequest): { revision: string; toolsHash: string } {
    const agents = this.ctx.get('agents');
    const agent = agents?.get(request.agent ?? '');
    const defs = this.ctx.get('tools')?.list() ?? [];
    const specs = normalizeToolSpecs(defs, request.tools);
    const toolsHash = sha256(JSON.stringify(specs));
    const persona = agent ? resolvePersonaText(this.ctx, request.agent, agents!.settingsOf(agent.id, 'persona')) ?? '' : '';
    // 记忆归 Agent 本人（files/<agentId>/memory/<会话键>.md，2026-09 存储
    // 迁移）：读取经 memory.memoryBucketOf（注入同口径单一事实源——
    // singles 重定向对用户对桶、群桶锚属主，两处永不漂移）；无 Agent
    // 身份（直连 run）无记忆语义 → 空串
    const memory = this.ctx.get('memory', false) as
      | {
          memoryBucketOf(
            agentId: string,
            conversationId: string | undefined,
            sender: string | undefined,
          ): { anchor: string; key: string } | undefined;
          get(anchor: string, key: string): string | undefined;
        }
      | undefined;
    const memoryBucket =
      memory && request.agent !== undefined
        ? memory.memoryBucketOf(request.agent, request.conversationId, request.sender)
        : undefined;
    const memoryContent = memoryBucket ? memory!.get(memoryBucket.anchor, memoryBucket.key) ?? '' : '';
    // 会话工作区（2026-11 挂载即授予；2026-12 升为会话级工作目录——
    // sandboxWorkdir/提示词 [工作目录] 指向工作区根）+ 工作区技能组进
    // <available_skills>——挂载/卸载与技能增删都改变
    // system 字节，修订键必须覆盖（漏键 = 快照静默失效/漂移误报）。技能
    // 视图取清单形状（name/description/dirName/location——渲染信息全集，
    // 正文不进 system 不计）。行未装 = null 占位（键仍确定性）。
    const sid = request.conversationId ?? '';
    const workspaceRoot =
      sid && this.get(sid)?.workspaceId
        ? this.ctx.get('workspace')?.listWorkspaces?.().find((w) => w.id === this.get(sid)!.workspaceId)?.path ?? null
        : null;
    const skillsView = (this.ctx.get('skills', false) as
      | { listForAgent(agentId: string, conversationId?: string): unknown }
      | undefined
      | null)?.listForAgent(request.agent ?? '', sid || undefined) ?? null;
    const revision = sha256(
      JSON.stringify([
        'v2', // 词表版本（快照形状演进时 bump——旧快照自然失效重拍；
        // M24 X1：hooks→settings 键变 = 显式失效重拍一次[无害]；
        // v2：system-prompt 形态门控——独立会话不注入多 Agent 协作知识，
        // 装配词表变化 = 显式失效重拍一次[无害]）
        persona,
        agent?.system ?? '',
        agents && agent ? agents.settingsOf(agent.id) : {},
        agent?.provider ?? '',
        request.model,
        request.llmParams ?? {},
        toolsHash,
        memoryContent,
        workspaceRoot,
        skillsView,
      ]),
    );
    return { revision, toolsHash };
  }

  /** 快照文件：<root>/singles/<sid>/prefix-snapshot.json（本服务 owning） */
  private snapshotFile(sessionId: string): string {
    return path.join(this.singlesDir, sessionId, 'prefix-snapshot.json');
  }

  private readSnapshot(sessionId: string): PrefixSnapshot | undefined {
    try {
      const raw = JSON.parse(fs.readFileSync(this.snapshotFile(sessionId), 'utf-8')) as Partial<PrefixSnapshot>;
      if (typeof raw?.revision === 'string' && typeof raw?.system === 'string' && typeof raw?.toolsHash === 'string') {
        return { revision: raw.revision, system: raw.system, toolsHash: raw.toolsHash, capturedAt: raw.capturedAt ?? '' };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private writeSnapshot(sessionId: string, snapshot: PrefixSnapshot): void {
    try {
      fs.mkdirSync(path.dirname(this.snapshotFile(sessionId)), { recursive: true });
      const tmp = `${this.snapshotFile(sessionId)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
      fs.renameSync(tmp, this.snapshotFile(sessionId));
    } catch (err: unknown) {
      this.ctx.logger.warn(`[singles] 前缀快照落盘失败（${sessionId}）: ${String(err)}`);
    }
  }

  /** 快照读取口（诊断/RPC 面）：无快照 → undefined */
  prefixSnapshotOf(sessionId: string): PrefixSnapshot | undefined {
    return this.readSnapshot(sessionId);
  }

  /**
   * run-started 钩子：暂存待命名 run（路由终值 + 首条用户消息）。
   * 只挂账不生成——标题在首个 after-step（结合 Agent 首步产出）时才
   * 触发；run 收束（after-run）若账仍滞留（run 夭折/无步完成）则兜底
   * 清账（截断回落）。已有标题/机制 run/非 singles 桶在此即短路。
   */
  private stagePendingTitle(request: LoopRunRequest): void {
    const sid = request.conversationId;
    if (!sid || this.titleInFlight.has(sid) || this.pendingTitle.has(sid)) return;
    // 归档整理 run（机制自会话）：不是用户对话——不暂存不生成
    if (isArchiveReviewRun(request.meta)) return;
    const record = this.readRecord(sid);
    if (!record || record.status !== 'active' || record.title) return;
    // 首条用户消息：跳过 datetime 日快照行（M21 步骤 4：独立会话的日期
    // 以 user 行进信封——'[当前时间] ' 前缀是 ac-datetime 的行签名）
    const firstUser = request.messages.find(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.trim() &&
        !m.content.startsWith('[当前时间] '),
    );
    if (!firstUser) return;
    this.pendingTitle.set(sid, {
      model: request.model,
      ...(request.provider ? { provider: request.provider } : {}),
      userText: firstUser.content,
    });
  }

  /** after-step 钩子：首个完成的步 → 结合 Agent 思考/正文生成标题 */
  private async generateStagedTitle(sid: string | undefined, step: LoopStepRecord): Promise<void> {
    if (!sid || this.titleInFlight.has(sid)) return;
    const staged = this.pendingTitle.get(sid);
    if (!staged) return; // 非待命名 run（已命名会话/机制 run/非 singles 桶）
    // Agent 首步理解（标题概括的素材）：reasoning 优先——思考内容是对
    // 任务的理解与规划，比正文更贴「这轮对话在谈什么」；无思考模型
    // 用正文。工具步常见正文为空（只有 toolCalls），首步有思考即可用。
    const agentFirstOutput = step.reasoning?.trim() || step.text.trim() || undefined;
    await this.fireTitle(sid, staged, agentFirstOutput);
  }

  /** after-run 兜底：run 收束账上仍有 pending（run 夭折/无步完成）→ 截断回落 */
  private async flushPendingTitle(sid: string | undefined): Promise<void> {
    if (!sid || this.titleInFlight.has(sid)) return;
    const staged = this.pendingTitle.get(sid);
    if (staged) await this.fireTitle(sid, staged, undefined);
  }

  /**
   * 标题生成主体（after-step 与 after-run 兜底共用）：清账 → LLM 一句话
   * 概括（可结合 Agent 首步产出）→ 失败回落首条消息截断。
   */
  private async fireTitle(sid: string, staged: { model: string; provider?: string; userText: string }, agentFirstOutput?: string): Promise<void> {
    this.pendingTitle.delete(sid);
    this.titleInFlight.add(sid);
    try {
      const userText = staged.userText;
      let title = '';
      const llm = this.ctx.get('llm', false) as
        | { chat(input: Record<string, unknown>): Promise<{ text: string }> }
        | undefined;
      if (llm) {
        const baseInput = {
          model: staged.model,
          ...(staged.provider ? { provider: staged.provider } : {}),
          messages: [{ role: 'user', content: TITLE_PROMPT(userText, agentFirstOutput) }],
          max_tokens: 64,
        };
        // 思考型模型（GLM/DeepSeek 等）默认先出 reasoning 再出正文——
        // 64 token 小预算会被思考独占（finish=length、text 恒空，实测
        // glm-5.3 reasoning_tokens=62/64；deepseek-flash 64/64），标题
        // 永远走回落截断。双词汇禁用思考：GLM `thinking:{type:'disabled'}`
        // + DeepSeek/OpenAI `reasoning_effort:'none'`——宽容端点忽略未知
        // 键，两族各认各的。OpenAI 官方对未知顶层字段严格 400：指误即裸
        // 参数重试一次（协议库 max_tokens→max_completion_tokens 同款先例
        // 在传输层，这里 400 无结构化信号，按文案判定）。
        try {
          const resp = await llm.chat({
            ...baseInput,
            thinking: { type: 'disabled' },
            reasoning_effort: 'none',
          });
          title = cleanTitle(resp.text ?? '');
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/thinking|reasoning_effort/i.test(msg)) {
            // 未知参数指误：裸参数重试一次（非思考模型——无禁用必要）
            try {
              const resp = await llm.chat(baseInput);
              title = cleanTitle(resp.text ?? '');
            } catch (retryErr: unknown) {
              this.ctx.logger.warn(
                '[singles] LLM 标题生成失败（回落截断标题）: %C',
                retryErr instanceof Error ? retryErr.message : String(retryErr),
              );
            }
          } else {
            this.ctx.logger.warn(
              '[singles] LLM 标题生成失败（回落截断标题）: %C',
              msg,
            );
          }
        }
      }
      if (!title) title = fallbackTitle(userText);
      if (!title.trim()) return;
      // 再查一次：期间用户可能手动改过标题，不覆盖
      const latest = this.readRecord(sid);
      if (!latest || latest.title || latest.status !== 'active') return;
      this.update(sid, { title });
      this.ctx.logger.info(
        '[singles] 会话 %C… 已生成标题「%C」',
        sid.slice(0, 8),
        title,
      );
    } finally {
      this.titleInFlight.delete(sid);
    }
  }
  /**
   * 会话上架：消息目录归入 sessions/singles/<workspaceId|ungrouped>/<sid>/。
   * 经 ac-session 的 setShelf owning 写口（本服务不触碰会话文件）。
   * @returns 上架的会话数
   */
  syncShelves(): number {
    const session = this.ctx.get('session');
    if (!session || typeof session.setShelf !== 'function') return 0;
    let count = 0;
    for (const s of this.list()) {
      try {
        session.setShelf(s.id, `singles/${s.workspaceId ?? 'ungrouped'}`);
        count++;
      } catch (err: unknown) {
        this.ctx.logger.warn(`[singles] 会话上架失败（${s.id}）: ${String(err)}`);
      }
    }
    return count;
  }

  /** 首次触及即同步上架（老数据迁移 + 索引自愈；后续调用零成本） */
  private ensureShelves(): void {
    if (this.shelvesSynced) return;
    this.shelvesSynced = true;
    const count = this.syncShelves();
    if (count > 0) this.ctx.logger.info('[singles] 已按工作区上架 %C 个独立会话', String(count));
  }

  /** 单会话的 shelf 路径（workspaceId → 子文件夹；未分组 → ungrouped） */
  private shelfOf(record: SingleSessionMeta): string {
    return `singles/${record.workspaceId ?? 'ungrouped'}`;
  }

  /** 元数据文件：<root>/singles/<sid>/session.json */
  private fileOf(sessionId: string): string {
    return path.join(this.singlesDir, sessionId, 'session.json');
  }

  /**
   * 元数据读缓存（2026-12 卡顿优化）：mtime 命中零文件读。list()/purgeEmpty/
   * stagePendingTitle 等全走本面——379 会话规模下每次全量 list 的元数据
   * 读取从 ~19ms（热）/ 250ms+（冷）降到 stat 级（~8ms 热）。写侧
   * （writeRecord）主动刷新、删除（purge）弃条目；外部手改文件由 mtime
   * 失配自然兜底（下次读重读）。缓存条目 = null 表示「存在但损坏/读
   * 失败」——不缓存「不存在」（stat 探空必然先于缓存判断，缓存无收益）。
   */
  private recordCache = new Map<string, { mtimeMs: number; record: SingleSessionMeta | null }>();

  private readRecord(sessionId: string): SingleSessionMeta | null {
    const file = this.fileOf(sessionId);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null; // 不存在：不缓存（stat 探空无收益——见上方注释）
    }
    const cached = this.recordCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.record;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (typeof raw?.id !== 'string' || typeof raw?.agentId !== 'string') {
        this.recordCache.set(file, { mtimeMs: stat.mtimeMs, record: null });
        return null; // 损坏
      }
      const record = raw as SingleSessionMeta;
      this.recordCache.set(file, { mtimeMs: stat.mtimeMs, record });
      return record;
    } catch {
      this.recordCache.set(file, { mtimeMs: stat.mtimeMs, record: null });
      return null; // 读失败当次按损坏处理（mtime 已变，下次重试）
    }
  }

  private writeRecord(record: SingleSessionMeta): void {
    fs.mkdirSync(path.dirname(this.fileOf(record.id)), { recursive: true });
    const file = this.fileOf(record.id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    // 写后主动刷新缓存（写路径自己知道终值——省下一次读；mtime 取实际值，
    // statSync 失败（竞态删除等极端）则弃缓存条目由下次读重建）
    try {
      this.recordCache.set(file, { mtimeMs: fs.statSync(file).mtimeMs, record });
    } catch { /* 竞态：交由 mtime 失配兜底 */ }
  }

  // ---- 跨域校验（读取走服务方法；可选能力 ctx.get 非 strict 摘行不拖垮） ----

  private validateAgent(agentId: string): void {
    const agents = this.ctx.get('agents');
    if (!agents) return; // agents 行未装：放行，运行时 router 投递兜底报错
    const agent = agents.get(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" 不存在`);
    if (agent.virtual) throw new Error(`Agent "${agentId}" 是虚拟 Agent，不支持独立会话`);
  }

  private validateWorkspace(workspaceId: string): void {
    const workspace = this.ctx.get('workspace');
    if (!workspace) return;
    if (!workspace.listWorkspaces().some((w) => w.id === workspaceId)) {
      throw new Error(`工作区 "${workspaceId}" 不存在`);
    }
  }

  /**
   * 模型覆盖引用校验（P6）：`name@model` 左段须为已注册 provider 名
   * （llm 行装载时；含池行种子/条目），裸名放行（旧路由语义）。
   * llm 行未装/注册面为空 → 放行（fail-open，运行时 roster 报错兜底）。
   */
  private validateModelRef(model: string): void {
    const ref = splitModelRef(model);
    if (ref.provider === undefined) return; // 裸模型名
    const llm = this.ctx.get('llm', false) as { providers(): string[] } | undefined;
    if (!llm) return;
    const known = llm.providers();
    if (known.length > 0 && !known.includes(ref.provider)) {
      throw new Error(
        `模型引用 "${model}" 的 provider "${ref.provider}" 未注册（已注册：${known.join(', ')}；或改用裸模型名）`,
      );
    }
  }

  /** 是否已有消息（ac-session 域 stats + 在途队列；锁定 Agent 变更的判据）。
   *  首 run 进行中首条消息已入账未落盘——文件口径恒 0，在途必须计入，
   *  否则在途会话被误判无消息 */
  hasMessages(sessionId: string): boolean {
    const session = this.ctx.get('session');
    if (!session) return false;
    if ((session.stats(sessionId)?.messageCount ?? 0) > 0) return true;
    return session.hasPending(sessionId);
  }

  /**
   * 最近活动时间戳（ms；无消息 = undefined）——列表排序锚点。
   * statMeta 直取 mtime（零文件读）——与 stats().updatedAt 同源同值
   * （stats 三条路径的 updatedAt 恒 = stat.mtimeMs）。冷启动 list()/listActive()
   * 对全部会话逐个取活动时间：走 stats 会把 162 MiB 消息文件整读（实测
   * 307 会话 ~1.2s 只为排序）；mtime 是纯文件系统元数据，读成本近零，
   * 窗口计数留给真需要它的消费面（runs/snapshot 展开段）去付。
   */
  lastActivity(sessionId: string): number | undefined {
    const session = this.ctx.get('session');
    return session?.statMeta(sessionId)?.mtimeMs;
  }

  // ---- CRUD ----

  /** 读单会话（不存在 → null） */
  get(sessionId: string): SingleSessionMeta | null {
    return this.readRecord(sessionId);
  }

  /**
   * 全部会话（含 archived；按最近会话时间降序——lastActivity 优先，
   * 无消息回落 createdAt）。装饰排序：活动时间每会话取一次（lastActivity
   * 走 statMeta mtime 零文件读；比较器内反复取 = O(n log n) 次 stat）。
   */
  private sortedByActivity(): SingleSessionMeta[] {
    if (!fs.existsSync(this.singlesDir)) return [];
    const decorated: Array<{ record: SingleSessionMeta; activity: number }> = [];
    for (const name of fs.readdirSync(this.singlesDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const record = this.readRecord(name.name);
      if (record) decorated.push({ record, activity: this.lastActivity(record.id) ?? 0 });
    }
    decorated.sort((a, b) => b.activity - a.activity || b.record.createdAt.localeCompare(a.record.createdAt));
    return decorated.map((d) => d.record);
  }

  /** 全部会话（含 archived；按最近会话时间降序） */
  list(): SingleSessionMeta[] {
    this.ensureShelves();
    return this.sortedByActivity();
  }

  /**
   * 仅活跃会话（列表页数据源；RPC singles/list 载荷）。附 lastActivity
   * （ISO 串 = 最近一条消息时间——前端列表排序锚点；无消息的空会话
   * 不带该键，前端回落 createdAt）。
   */
  listActive(): SingleSessionMeta[] {
    return this.list().filter((s) => s.status === 'active').map((s) => this.withActivity(s));
  }

  /** 元数据 + lastActivity 拼装（跨域读取走服务方法：ac-session stats mtime） */
  private withActivity(record: SingleSessionMeta): SingleSessionMeta {
    const last = this.lastActivity(record.id);
    return last === undefined ? record : { ...record, lastActivity: new Date(last).toISOString() };
  }

  /** 是否空白会话（未选 Agent、无消息且无在途 run——复用判定）。
   *  「正在运行」= conversation 串行化门在册（跨域读取走服务方法）：首条
   *  消息已投递的 run 在途即会话有事实内容——误判空白会在别处 create 的
   *  purgeEmpty 中连消息流一起硬删（前端「看不到运行中会话且事后无记录」
   *  事故的根因）。conversation 行未装/脚本桩无 run 簿记面 → 放行
   *  （可选能力，fail-open） */
  isEmpty(sessionId: string): boolean {
    const record = this.readRecord(sessionId);
    if (!record || record.status !== 'active') return false;
    if (record.agentId) return false;
    if (this.hasMessages(sessionId)) return false;
    const conversation = this.ctx.get('conversation', false) as
      | { listRunning?: () => { conversationId?: string }[] }
      | undefined;
    return !conversation?.listRunning?.().some((r) => r.conversationId === sessionId);
  }

  /**
   * 创建独立会话。空白会话全局唯一不变量：创建新的空会话前先清理
   * 遗留空白会话；input.reuse = 已有空白会话时直接复用（不新建）。
   */
  create(input: SinglesCreateInput = {}): SingleSessionMeta {
    if (input.reuse) {
      for (const s of this.list()) {
        if (this.isEmpty(s.id)) return s;
      }
    }
    this.purgeEmpty();

    const agentId = (input.agentId ?? '').trim();
    if (agentId) this.validateAgent(agentId);
    const model = typeof input.model === 'string' ? input.model.trim() : undefined;
    if (model) this.validateModelRef(model);
    const workspaceId = (input.workspaceId ?? '').trim();
    if (workspaceId) this.validateWorkspace(workspaceId);

    const now = new Date().toISOString();
    const record: SingleSessionMeta = {
      id: randomUUID(),
      agentId,
      ...(model ? { model } : {}),
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      createdAt: now,
      updatedAt: now,
      status: 'active',
    };
    this.writeRecord(record);
    // 新会话即上架（消息目录从 sessions/singles/<ws>/<sid>/ 起步）
    this.ctx.get('session')?.setShelf?.(record.id, this.shelfOf(record));
    this.ctx.emit('singles/updated', record, 'created');
    return record;
  }

  /**
   * 更新会话设置（输入栏内联调整：换 Agent / 换模型覆盖 / 挂工作区 / 改标题）。
   * agentId 规则 1（src 同款）：已有消息的会话禁止变更——历史消息身份与
   * 投递目标绑定（未选 Agent 的会话消息经默认预设路由，同样锁定）。
   * '' = 清空待选。model：null = 清除覆盖（回落 Agent 原配置）。
   * workspaceId：'' = 移入未分组。
   */
  update(sessionId: string, input: SinglesUpdateInput): SingleSessionMeta {
    const record = this.readRecord(sessionId);
    if (!record) throw new Error(`独立会话 "${sessionId}" 不存在`);

    const nextAgent = input.agentId?.trim();
    if (nextAgent !== undefined && nextAgent !== record.agentId) {
      if (this.hasMessages(sessionId)) {
        throw new Error('已存在消息的会话不能更换预设/Agent（历史消息身份与 Agent 绑定）');
      }
      if (nextAgent) this.validateAgent(nextAgent);
      record.agentId = nextAgent;
    }
    if (input.model !== undefined) {
      if (input.model === null) delete record.model;
      else {
        const m = input.model.trim();
        if (m) {
          this.validateModelRef(m);
          record.model = m;
        } else delete record.model;
      }
    }
    if (input.workspaceId !== undefined) {
      const ws = input.workspaceId.trim();
      if (ws) {
        this.validateWorkspace(ws);
        record.workspaceId = ws;
      } else {
        delete record.workspaceId;
      }
    }
    if (input.title !== undefined) {
      const t = input.title.trim();
      if (t) record.title = t;
    }
    record.updatedAt = new Date().toISOString();
    this.writeRecord(record);
    // 换组即换架（消息目录随工作区迁移；寻址不变）
    if (input.workspaceId !== undefined) {
      this.ctx.get('session')?.setShelf?.(record.id, this.shelfOf(record));
    }
    this.ctx.emit('singles/updated', record, 'updated');
    return record;
  }

  /**
   * 会话分支（独立会话内新增分支）：以 anchorMessageId 消息（含）为终点
   * 复制出一个新会话——元数据（Agent/模型覆盖/工作区）继承，消息流经
   * session 域服务方法拷贝（compact keep 一次性落盘；越权红线：本服务不
   * 触碰会话文件）。
   * 行为语义：
   *   · 读取走 ctx.session.records()（权威读口：flush 在途队列 + journal
   *     恢复 + partial/补行合并投影——新会话自完整，无需 partials 回放）；
   *   · 锚点 = 行 message_id（收束行/注入行均有；不透明）；未命中抛错；
   *   · 落盘走 ctx.session.compact(keep)（原子 tmp+rename，不用逐行 append
   *     ——行数级拷贝太慢且非原子；keep 行已是稳定终态，无 B1 窗口顾虑
   *     〔目标文件本不存在〕）；
   *   · partial 检查点行（run 进行中）如实拷贝——records() 已做读侧合并，
   *     带 partial 标记的行仅出现在未收束 run 语义里，切片场景罕见且无害；
   *   · 新行 seq 重新从 0 连续（compact keep 语义——continueSeq 由承接的
   *     write 路径按文件续号，寻址不依赖 seq）；
   *   · 源会话只读不受影响；标题继承源标题（已具名会话），未命名会话
   *     （LLM 标题尚未生成/空白）不预置标题（新会话首跑触发自动命名）。
   * @returns 新会话元数据
   */
  async fork(sessionId: string, anchorMessageId: string): Promise<SingleSessionMeta> {
    const source = this.readRecord(sessionId);
    if (!source) throw new Error(`独立会话 "${sessionId}" 不存在`);
    const session = this.ctx.get('session');
    if (!session) throw new Error('session 服务未装载（会话分支不可用）');
    const records = await session.records(sessionId);
    let end = records.length - 1;
    if (anchorMessageId !== '') {
      end = records.findIndex((r) => r.message_id === anchorMessageId);
      if (end === -1) throw new Error(`消息 "${anchorMessageId}" 不在会话 "${sessionId}" 中（分支锚点失效）`);
    }
    const keep = records.slice(0, end + 1).map((r) => {
      const copy = { ...r };
      delete copy.partial;
      delete copy.echoSeq;
      return copy;
    });
    // create 会先 purgeEmpty 清理遗留空白会话——源会话有消息不受影响。
    // 标题：源已具名 → 剥旧「（分支）」后缀再追加（分支的分支不叠名，
    // 不会出现「xx（分支）（分支）」）；未命名不预置（新会话首跑自动命名）
    const title = source.title
      ? `${source.title.replace(/（分支）+$/, '')}（分支）`
      : undefined;
    const forked = this.create({
      agentId: source.agentId,
      ...(source.model ? { model: source.model } : {}),
      ...(title ? { title } : {}),
      ...(source.workspaceId ? { workspaceId: source.workspaceId } : {}),
    });
    if (keep.length > 0) await session.compact(forked.id, { keep });
    this.ctx.logger.info(
      '[singles] 会话分支 %C… → %C…（%C 条消息，锚点=%C）',
      sessionId.slice(0, 8),
      forked.id.slice(0, 8),
      String(keep.length),
      anchorMessageId === '' ? '末尾' : anchorMessageId.slice(0, 10),
    );
    return forked;
  }

  /** 归档（软删）：状态置 archived，消息流保留（可从数据目录找回） */
  archive(sessionId: string): SingleSessionMeta {
    const record = this.readRecord(sessionId);
    if (!record) throw new Error(`独立会话 "${sessionId}" 不存在`);
    record.status = 'archived';
    record.updatedAt = new Date().toISOString();
    this.writeRecord(record);
    this.ctx.emit('singles/updated', record, 'archived');
    return record;
  }

  /** 删除（硬删）：元数据目录 + 消息流（经 ac-session 清理写口）——不可恢复 */
  remove(sessionId: string): void {
    const record = this.readRecord(sessionId);
    if (!record) throw new Error(`独立会话 "${sessionId}" 不存在`);
    fs.rmSync(path.dirname(this.fileOf(sessionId)), { recursive: true, force: true });
    // 目录已删：弃缓存条目（下次 readRecord stat 探空自然回 null）
    this.recordCache.delete(this.fileOf(sessionId));
    const session = this.ctx.get('session');
    session?.clear(sessionId);
    this.ctx.emit('singles/updated', record, 'removed');
  }

  /** 清理全部遗留空白会话（未选 Agent 且无消息；硬删——无数据可失） */
  private purgeEmpty(): number {
    let purged = 0;
    for (const s of this.list()) {
      if (this.isEmpty(s.id)) {
        this.remove(s.id);
        purged += 1;
      }
    }
    return purged;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 独立会话管理服务（ac-singles 提供；元数据 owning，消息流归 ac-session） */
    singles: SinglesService;
  }
}
