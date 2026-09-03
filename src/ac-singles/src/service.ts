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
import { normalizeToolSpecs } from 'ac-agent-loop';
import { resolvePersonaText } from 'ac-persona';
import { splitModelRef } from 'ac-llm';
import type { LoopRunRequest, LoopRunResult } from 'ac-agent-loop';
import type { SingleSessionMeta, SinglesCreateInput, SinglesUpdateInput } from './contract.ts';

export interface SinglesRowOptions {
  /** 数据根目录（缺省跟随启动 cwd（AGENTCHAT_DATA_ROOT），回退 './data'；元数据目录 = <root>/singles） */
  root?: string;
}

/** 标题长度上限（字符） */
const TITLE_MAX_LEN = 24;

/** 标题生成提示词（src singles-title 同款语义：短、无引号、无解释） */
const TITLE_PROMPT = (userText: string): string =>
  `根据下面的用户消息，为这段对话生成一个简短的中文标题（不超过${TITLE_MAX_LEN}字）。\n`
  + `要求：直接输出标题本身；不要引号、句号、解释或前后缀；概括意图而非复述原文。\n\n`
  + `用户消息：\n${userText.slice(0, 600)}`;

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
  /** 标题生成中守卫（同会话并发 after-run 只触发一次） */
  private titleInFlight = new Set<string>();
  /** 前缀快照在途处置（sid → 本次 run：capture 首拍/失效重拍 | verify 键未变核验终态） */
  private prefixPending = new Map<string, { kind: 'capture' | 'verify'; revision: string; toolsHash: string }>();

  constructor(ctx: Context, options: SinglesRowOptions = {}) {
    super(ctx, 'singles');
    this.singlesDir = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data', 'singles');

    // ---- 自动标题（src singles.auto-title 的 preview 形态）----
    // 首 run 结束（loop/after-run）后为无标题会话生成标题：LLM 一句话
    // 概括（fire-and-forget，不阻塞主对话流），失败回落首条消息截断。
    // 幂等守卫 = session.json 尚无 title（生成一次后永不再触发）；
    // 经 update() 写入 → singles/updated 事件 → 前端列表即时刷新。
    // C1：fire-and-forget 必须自带 catch——update() 落盘（Windows AV 锁/
    // 盘满可抛）发生在装饰性路径上，不得放大为宿主 unhandledRejection。
    this.ctx.on('loop/after-run', (request, result) => {
      void this.maybeGenerateTitle(request, result).catch((err: unknown) => {
        this.ctx.logger.error(
          '[singles] 标题生成失败（忽略）: %C',
          err instanceof Error ? err.message : String(err),
        );
      });
    }, { description: '独立会话收束记账（lastActivity）' });

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
    // 迁移）：读取带执行 Agent 维度，键 = conversationId ?? agent（与注入
    // 同口径）；无 Agent 身份（直连 run）无记忆语义 → 空串
    const memory = this.ctx.get('memory', false) as
      | { get(agentId: string, key: string): string | undefined }
      | undefined;
    const memoryKey = request.conversationId ?? request.agent;
    const memoryContent =
      memory && request.agent !== undefined && memoryKey !== undefined
        ? memory.get(request.agent, memoryKey) ?? ''
        : '';
    const revision = sha256(
      JSON.stringify([
        'v1', // 词表版本（快照形状演进时 bump——旧快照自然失效重拍；
        // M24 X1：hooks→settings 键变 = 显式失效重拍一次[无害]）
        persona,
        agent?.system ?? '',
        agents && agent ? agents.settingsOf(agent.id) : {},
        agent?.provider ?? '',
        request.model,
        request.llmParams ?? {},
        toolsHash,
        memoryContent,
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

  /** after-run 钩子：独立会话 + 无标题 + 正常收束 → 生成标题 */
  private async maybeGenerateTitle(request: LoopRunRequest, result: LoopRunResult): Promise<void> {
    const sid = request.conversationId;
    if (!sid || this.titleInFlight.has(sid)) return;
    if (result.finish === 'error' || result.finish === 'interrupted') return;
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

    this.titleInFlight.add(sid);
    try {
      const userText = firstUser.content;
      let title = '';
      const llm = this.ctx.get('llm', false) as
        | { chat(input: Record<string, unknown>): Promise<{ text: string }> }
        | undefined;
      if (llm) {
        try {
          const resp = await llm.chat({
            model: request.model,
            ...(request.provider ? { provider: request.provider } : {}),
            messages: [{ role: 'user', content: TITLE_PROMPT(userText) }],
            max_tokens: 64,
          });
          title = cleanTitle(resp.text ?? '');
        } catch (err: unknown) {
          this.ctx.logger.warn(
            '[singles] LLM 标题生成失败（回落截断标题）: %C',
            err instanceof Error ? err.message : String(err),
          );
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

  private readRecord(sessionId: string): SingleSessionMeta | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileOf(sessionId), 'utf-8'));
      if (typeof raw?.id !== 'string' || typeof raw?.agentId !== 'string') return null;
      return raw as SingleSessionMeta;
    } catch {
      return null; // 不存在/损坏
    }
  }

  private writeRecord(record: SingleSessionMeta): void {
    fs.mkdirSync(path.dirname(this.fileOf(record.id)), { recursive: true });
    const tmp = `${this.fileOf(record.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
    fs.renameSync(tmp, this.fileOf(record.id));
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

  /** 是否已有消息（ac-session 域 stats；锁定 Agent 变更的判据） */
  hasMessages(sessionId: string): boolean {
    const session = this.ctx.get('session');
    if (!session) return false;
    return (session.stats(sessionId)?.messageCount ?? 0) > 0;
  }

  /** 最近活动时间戳（ms；无消息 = undefined）——列表排序锚点 */
  lastActivity(sessionId: string): number | undefined {
    const session = this.ctx.get('session');
    return session?.stats(sessionId)?.updatedAt;
  }

  // ---- CRUD ----

  /** 读单会话（不存在 → null） */
  get(sessionId: string): SingleSessionMeta | null {
    return this.readRecord(sessionId);
  }

  /** 全部会话（含 archived；createdAt 降序） */
  list(): SingleSessionMeta[] {
    this.ensureShelves();
    if (!fs.existsSync(this.singlesDir)) return [];
    const out: SingleSessionMeta[] = [];
    for (const name of fs.readdirSync(this.singlesDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const record = this.readRecord(name.name);
      if (record) out.push(record);
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  /** 仅活跃会话（列表页数据源） */
  listActive(): SingleSessionMeta[] {
    return this.list().filter((s) => s.status === 'active');
  }

  /** 是否空白会话（未选 Agent 且无消息——复用判定） */
  isEmpty(sessionId: string): boolean {
    const record = this.readRecord(sessionId);
    if (!record || record.status !== 'active') return false;
    if (record.agentId) return false;
    return !this.hasMessages(sessionId);
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
