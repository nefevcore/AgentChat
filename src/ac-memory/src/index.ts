// ============================================================
// ac-memory —— 长期记忆时间线服务（memory timeline）
//
// 重构裁决（src/docs/memory-timeline-plan.md，2026-12-08 cr-4）：
//   · 记忆归属主体 = Agent 人格（非会话桶）：单文件
//     files/<agentId>/memory/timeline.md，条目 = 宿主铸造头注释
//     （时间戳/origin=写入时会话标识/peers/tags）+ 正文；seq 位置派生。
//   · 旧桶注入协议（<memory> 块进 system）退役——记忆内容与 system 彻底
//     解耦：system 侧只剩恒定静态指引（数行），内容走会话流 context 行
//     （checkpoint 快照 + delta，尾部追加——KV 零失效）。
//   · 工具面：memory_write（append-only）/ memory_grep（检索）——
//     requiredTags ['memory']（与 fs 正交）；needPermission false。
//   · 跨会话可见是有意语义（人格连续性）：本会话写入的 delta 不重复注入
//     （tool-call 历史已有副本），他源 delta 注入。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import { grepEntries, mintEntry, parseTimeline, renderDelta, renderGrepResult, renderSnapshot, type MemoryEntry } from 'ac-memory-core';
import type {} from 'ac-agents'; // ctx.agents 可选能力类型（type-only）

/** 行配置（cordis.yml config / 构造直传） */
export interface MemoryRowOptions {
  /** 数据根目录（缺省 './data'，相对 cwd；未装 workspace 行时 timeline = <root>/files/<agentId>/memory/timeline.md） */
  root?: string;
  /** 注入 token 预算缺省（per-Agent settings['memory'].maxTokens 覆盖） */
  maxTokens?: number;
  /** 文件持久化开关（缺省 true；false = 纯内存——测试/演示） */
  persist?: boolean;
  /** 启动迁移开关（缺省 true；false = 跳过存量桶迁移投递） */
  migrate?: boolean;
}

export interface MemorySettings {
  /** 缺省 true；false = 本 Agent 软停用 */
  enabled?: boolean;
  /** 快照注入 token 预算 */
  maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 2000;

/** 记忆行 source 词汇（context 行 source 字段；锚检测与 viewer 过滤共用） */
export const MEMORY_SNAPSHOT_SOURCE = 'memory-snapshot';
export const MEMORY_DELTA_SOURCE = 'memory-delta';

/** workspace 服务的最小结构面（结构化读取，不引运行时依赖） */
interface WorkdirSource {
  agentWorkdir(agentId: string): string;
}

/**
 * system 静态指引（KV 声明纪律：字节恒定——记忆内容与 system 解耦；
 * per-Agent enabled=false 时整块缺席，同为稳定形态）。
 */
const MEMORY_GUIDE =
  '<memory-guide>\n' +
  '你拥有跨会话的长期记忆时间线（自动注入近期内容；他源新增也会注入）。\n' +
  '· memory_write：把值得长期记住的信息写成条目——正文以 [标签] 段开头（标签从小词表取：约定/偏好/事实/教训/待办/档案），可选 peers 标关联对方、date 回填事实发生日（整理旧资料时用，缺省=今天）。在当下就写，不要等会话结束。\n' +
  '· 条目约定：一条 = 一件自包含的事（未来只看这条就能想起全部来龙去脉；超长叙事拆条）；日期前缀系统自动铸造，正文不要再写日期。\n' +
  '· 过时信息不必删改：写新条目自然覆盖。需要检索更早记忆用 memory_grep（支持时间/对象/标签过滤）。\n' +
  '</memory-guide>';

export class MemoryService extends Service {
  private dataRoot: string;
  private persist: boolean;
  private defaultMaxTokens: number;
  /** 纯内存后端（persist=false；键 = agentId） */
  private store = new Map<string, string>();

  constructor(ctx: Context, options: MemoryRowOptions = {}) {
    super(ctx, 'memory');
    this.dataRoot = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');
    this.persist = options.persist !== false;
    this.defaultMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (options.migrate !== false) {
      // 迁移投递（boot 后 fire-and-forget，不阻塞 boot；延迟一拍让数据行
      // Agent 注册齐——预设/用户 Agent 在各自行 apply 里注册，行装载序
      // 晚于本行时不漏扫）
      const timer = setTimeout(() => void this.migrateLegacyBuckets(), 100);
      this.ctx.fiber.effect(() => () => clearTimeout(timer), 'memory.migrate');
    }

    // ---- system 静态指引（主档：字节恒定） ----
    this.ctx.on('loop/before-run', (call, next) => {
      const agentId = call.request.agent;
      if (agentId === undefined) return next();
      if (!this.enabledFor(agentId)) return next();
      call.request = {
        ...call.request,
        system: call.request.system ? `${call.request.system}\n\n${MEMORY_GUIDE}` : MEMORY_GUIDE,
      };
      return next();
    }, { description: '记忆静态指引注入（字节恒定；内容走 context 行协议）' });

    // ---- checkpoint/delta 注入协议（before-start seam：history 装配前直落流） ----
    this.ctx.on('conversation/before-start', async (agentId, conversationId) => {
      if (!this.enabledFor(agentId)) return;
      const session = this.ctx.get('session', false) as
        | { records(id: string): Promise<Array<{ role: string; source?: string; content: string; agent_id?: string }>>; recordContext(id: string, agent: string, content: string, extra: { source: string; label?: string }): string }
        | undefined;
      if (session === undefined) return;
      const entries = this.entries(agentId);
      const H = entries.length;
      // 锚检测：流尾向后扫最近一条记忆行
      const records = await session.records(conversationId);
      let S = -1;
      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i];
        if (r.role !== 'context') continue;
        if (r.source !== MEMORY_SNAPSHOT_SOURCE && r.source !== MEMORY_DELTA_SOURCE) continue;
        const m = /记忆基线 seq=(\d+)/.exec(r.content);
        S = m ? Number(m[1]) : 0;
        break;
      }
      const maxTokens = this.maxTokensFor(agentId);
      if (S === -1 || S > H) {
        // 无锚（新会话/压缩裁锚）或 H<S（文件被缩短）→ 全量快照重定基线
        if (H === 0) return; // 空时间线不注入（静态指引已告知 memory_write）
        session.recordContext(conversationId, agentId, `${renderSnapshot(entries, { maxTokens })}\n记忆基线 seq=${H}`, { source: MEMORY_SNAPSHOT_SOURCE, label: '长期记忆快照注入' });
        return;
      }
      if (H > S) {
        // delta = (S, H] 且 origin ≠ 本会话（本会话写入已有 tool-call 副本）
        const delta = entries.filter((e) => e.seq > S && e.origin !== conversationId);
        const text = renderDelta(delta, { from: S, to: H });
        if (text !== undefined) {
          session.recordContext(conversationId, agentId, `${text}\n记忆基线 seq=${H}`, { source: MEMORY_DELTA_SOURCE, label: '长期记忆增量注入' });
        }
      }
      // H === S：正常稳态，不注入
    }, { description: '记忆 checkpoint/delta 注入（锚检测 + 尾部追加 context 行）' });
  }

  /** settings['memory'] enabled 读取（agents 未装 = 行缺省 true） */
  private enabledFor(agentId: string): boolean {
    const agents = this.ctx.get('agents', false) as
      | { settingsOf(id: string, name?: string): unknown }
      | undefined;
    const cfg = agents?.settingsOf(agentId, 'memory');
    if (cfg !== undefined && cfg !== null && typeof cfg === 'object') {
      return (cfg as MemorySettings).enabled !== false;
    }
    return true;
  }

  private maxTokensFor(agentId: string): number {
    const agents = this.ctx.get('agents', false) as
      | { settingsOf(id: string, name?: string): unknown }
      | undefined;
    const cfg = agents?.settingsOf(agentId, 'memory');
    if (cfg !== undefined && cfg !== null && typeof cfg === 'object') {
      const v = (cfg as MemorySettings).maxTokens;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    }
    return this.defaultMaxTokens;
  }

  /**
   * 时间线文件路径：files/<agentId>/memory/timeline.md（workspace.
   * agentWorkdir 唯一事实源；未装 workspace 行回落 <dataRoot>/files/<agentId>/）
   */
  timelineFileOf(agentId: string): string {
    const ws = this.ctx.get('workspace', false) as WorkdirSource | undefined;
    return path.join(
      ws ? ws.agentWorkdir(agentId) : path.join(this.dataRoot, 'files', agentId),
      'memory', 'timeline.md',
    );
  }

  /**
   * 写入条目（append-only 唯一写口；工具/服务共用）：头由宿主铸造
   * （origin=写入时会话标识；at = date 参数〔YYYY-MM-DD，历史回填/迁移用〕
   * 当日 + 当前时刻，缺省=今天）。原子追加（appendFileSync——进程内工具
   * 执行串行；跨进程由数据根独占锁挡）。返回新条目 seq。
   */
  write(agentId: string, input: { content: string; peers?: string[]; date?: string; origin?: string }): number {
    const date = input.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(input.date)
      ? `${input.date}T${new Date().toISOString().slice(11)}`
      : new Date().toISOString();
    const line = mintEntry({
      at: date,
      origin: input.origin ?? agentId,
      ...(input.peers && input.peers.length > 0 ? { peers: input.peers } : {}),
      content: input.content,
    });
    if (!this.persist) {
      const prev = this.store.get(agentId) ?? '';
      this.store.set(agentId, prev + (prev.endsWith('\n') || prev === '' ? '' : '\n') + line);
      return parseTimeline(this.store.get(agentId)!).length;
    }
    const file = this.timelineFileOf(agentId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, 'utf-8');
    return this.entries(agentId).length;
  }

  /** 读取条目流（解析纯库；文件不存在 = 空）。persist 模式每次直读（Agent fs 外写即时可见）。 */
  entries(agentId: string): MemoryEntry[] {
    let text: string | undefined;
    if (!this.persist) text = this.store.get(agentId);
    else {
      try {
        const file = this.timelineFileOf(agentId);
        if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf-8');
      } catch {
        text = undefined;
      }
    }
    return text ? parseTimeline(text) : [];
  }

  /** 过滤轴查询（memory_grep / 服务面共用） */
  grep(agentId: string, q: { pattern?: string; since?: string; until?: string; peer?: string; tag?: string }): string {
    return renderGrepResult(grepEntries(this.entries(agentId), q));
  }

  // ============================================================
  // 存量迁移（版本切换一次性）
  // ============================================================

  /**
   * 存量桶迁移：逐 Agent 投递迁移 run（内嵌旧记忆内容，零路径残留）；
   * marker 落盘幂等；旧桶文件保留不删（供回查），不再注入。前置检查：
   * 无 memory tag → 跳过并告警（memory_write 不可见，迁移必然失败）。
   */
  /** 存量桶迁移（boot 延迟触发；public 供测试/手动重发） */
  async migrateLegacyBuckets(): Promise<void> {
    const agents = this.ctx.get('agents', false) as
      | { list(): Array<Record<string, unknown> & { id: string; tags?: string[]; preset?: boolean }> }
      | undefined;
    const conversation = this.ctx.get('conversation', false) as
      | { deliver(agentId: string, inbound: string, options: Record<string, unknown>): Promise<unknown> }
      | undefined;
    if (agents === undefined || conversation === undefined) return;
    // agentStore 可选解析（补 tag 持久化用；未装则无法补——按无标签路径跳过告警）
    const agentStore = this.ctx.get('agentStore', false) as
      | { saveAgent(config: Record<string, unknown>): void }
      | undefined;
    const reassign = (config: Record<string, unknown>): void => {
      (this.ctx.get('agents') as { reassign(config: unknown): void }).reassign(config);
    };
    for (const agent of agents.list()) {
      const markerFile = path.join(path.dirname(this.timelineFileOf(agent.id)), '.migrated');
      if (fs.existsSync(markerFile)) continue;
      const buckets = this.readLegacyBuckets(agent.id);
      if (buckets.length === 0) {
        this.writeMarker(markerFile);
        continue;
      }
      if (!(agent.tags ?? []).includes('memory')) {
        // 迁移等价授予（用户裁决 2026-09-27，一次性覆盖 2026-09-16「存量手工补」
        // 默认——只作用于有存量记忆的 infra Agent，不做常规读边补齐）：
        // infra = 会话基础设施能力面，视为 memory_write 等价已授权——补
        // memory tag（档案持久化 + 注册表热更新）后迁移。预设不迁移
        // （preset: true 不入 agentStore 档案、且预设软停用记忆）。
        if (agent.preset === true || !(agent.tags ?? []).includes('infra') || agentStore === undefined) {
          this.ctx.logger.warn(`[memory] Agent ${agent.id} 无 memory/infra 标签（或无 agentStore 行），跳过记忆迁移（补标签后重启/手动重发）`);
          continue;
        }
        const patched = { ...agent, tags: [...(agent.tags ?? []), 'memory'] };
        try {
          agentStore.saveAgent(patched as unknown as Record<string, unknown>);
          reassign(patched);
          this.ctx.logger.info(`[memory] Agent ${agent.id} 含 infra 标签，已补 memory 标签（一次性迁移授予）并开始迁移`);
        } catch (err: unknown) {
          this.ctx.logger.warn(`[memory] Agent ${agent.id} 补 memory 标签失败（跳过迁移）: ${String(err)}`);
          continue;
        }
      }
      const prompt = this.migratePrompt();
      try {
        await conversation.deliver(agent.id, prompt, {
          conversationId: `${agent.id}~${agent.id}`,
          sender: agent.id,
          source: 'event',
          placement: 'next-run',
          meta: { 'memory-migrate': true },
          elevation: 'sandbox-access',
          maxSteps: 32,
        });
        this.writeMarker(markerFile);
      } catch (err: unknown) {
        this.ctx.logger.warn(`[memory] 迁移投递失败（${agent.id}，重启重试）: ${String(err)}`);
      }
    }
  }

  /**
   * 读取旧桶全部记忆文件（files/<agentId>/memory/*.md 除 timeline.md）。
   * 桶键正向判定：对键含 ~（1v1/自会话/singles 重定向）/ 群 id 约定 g- 前缀 /
   * 缺省裸 agentId 键——其余同名目录工作文件（TODO/DONE/README/MEMORY/
   * DONE-archive-* 等）不是记忆桶，不进迁移提示词。
   */
  private readLegacyBuckets(agentId: string): Array<{ key: string; text: string }> {
    const dir = path.dirname(this.timelineFileOf(agentId));
    const isBucketKey = (stem: string): boolean =>
      stem.includes('~') || stem.startsWith('g-') || stem === agentId;
    try {
      const out: Array<{ key: string; text: string }> = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md') || f === 'timeline.md') continue;
        if (!isBucketKey(f.slice(0, -3))) continue;
        const text = fs.readFileSync(path.join(dir, f), 'utf-8').trim();
        if (text) out.push({ key: f.slice(0, -3), text });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 迁移提示词：只指路不内嵌（用户裁决 2026-09-27——内嵌旧桶全文有三大缺陷：
   * 提示词体积失控/转译质量押注单次 run/宿主读取面 ≠ Agent 自己能看到的全部
   * 上下文）。Agent 用 fs 工具自己读 memory/ 目录全部旧桶，经 memory_write
   * 或按格式直写 timeline.md 落账。
   */
  private migratePrompt(): string {
    return [
      '当前为系统新版本，记忆架构已发生变化：按会话分桶的旧记忆文件已停用，改为单一记忆时间线。',
      '请整理工作目录下的记忆文件夹（./memory）：读取其中全部旧记忆文件，把值得长期保留的信息整理为记忆条目。',
      '两种写入方式任选：',
      '1. 使用 memory_write 工具逐条写入（推荐）：一条 = 一件自包含的事（超长叙事按主题拆条，不要整段照搬）；content 以 [标签] 段开头（标签从小词表取：约定/偏好/事实/教训/待办/档案）；旧条目有明确日期的用 date 参数回填事实发生日（没有就缺省今天）；peers 标关联对方；可改写表述、可丢弃过时内容。',
      '2. 或按格式直接编写文件 ./memory/timeline.md：每条 = 一行 `<!-- at:ISO时间 | origin:本会话键 | peers:逗号分隔 | tags:逗号分隔 -->` 头注释 + 下一行 `[YYYY-MM-DD] [tag|tag] 正文`（前缀段无标签可省略）。',
      '旧文件整理完成后保留不删（供回查），系统不再注入它们。完成后简短确认。',
    ].join('\n');
  }

  private writeMarker(file: string): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, new Date().toISOString(), 'utf-8');
    } catch { /* 尽力而为 */ }
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 长期记忆时间线服务（ac-memory 提供）：files/<agentId>/memory/timeline.md + write/entries/grep 三口 */
    memory: MemoryService;
  }
}

export const name = 'ac-memory';
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'memory',
  label: '记忆时间线',
  description: '长期记忆时间线（ctx.memory）：Agent 人格单文件 timeline.md + checkpoint/delta 流式注入（KV 零失效）+ memory_write/memory_grep 工具（memory 标签门禁）',
  fields: [
    { name: 'maxTokens', type: 'number', min: 0, step: 1000, default: DEFAULT_MAX_TOKENS, description: '快照注入 token 预算（整数条截断 + 溢出注记）' },
    { name: 'enabled', type: 'boolean', default: true, description: '行为门控（软停用）' },
  ],
  listeners: [
    { event: 'loop/before-run', role: '静态指引注入', description: '字节恒定的 memory-guide（内容走 context 行协议）', respectsEnabled: true },
    { event: 'conversation/before-start', role: 'checkpoint/delta 注入', description: '锚检测（H>S delta / H=S 稳态 / H<S 或无锚快照重定基线）+ 尾部追加 context 行', respectsEnabled: true },
  ],
};

/**
 * 工具行注入：memory_write / memory_grep（requiredTags ['memory']——与 fs
 * 正交；needPermission false——写口有界，落自身专用空间）。
 */
export const inject = ['tools'];

export function apply(ctx: Context, options: MemoryRowOptions = {}) {
  ctx.plugin(MemoryService, options);
  ctx.tools.register({
    name: 'memory_write',
    requiredTags: ['memory'],
    description: '向长期记忆时间线追加一条记忆（自动铸 [日期] 前缀；跨会话可用；过时信息不必删改——写新条目自然覆盖）',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆正文，以 [标签] 段开头（如 `[约定] 每周五同步`——标签从小词表取：约定/偏好/事实/教训/待办/档案），后接自包含的一句话或短段（未来的你只看这条就能想起来龙去脉）' },
        peers: { type: 'array', items: { type: 'string' }, description: '关联对象（端点/Agent id，可选）' },
        date: { type: 'string', description: '事实发生日 YYYY-MM-DD（可选；缺省=今天。仅历史回填/迁移整理时使用——记录当时日期而非整理日）' },
      },
      required: ['content'],
    },
    execute: (args, call) => {
      const agentId = call.agentId;
      if (!agentId) return { ok: false, error: 'memory_write 需要会话身份（agentId 缺失）' };
      const memory = ctx.get('memory') as MemoryService;
      const peers = Array.isArray(args.peers) ? args.peers.map(String) : undefined;
      const date = args.date !== undefined ? String(args.date) : undefined;
      const seq = memory.write(agentId, {
        content: String(args.content ?? ''),
        ...(peers ? { peers } : {}),
        ...(date ? { date } : {}),
        ...(call.conversationId ? { origin: call.conversationId } : {}),
      });
      return { ok: true, output: `已写入记忆条目 #${seq}` };
    },
  });
  ctx.tools.register({
    name: 'memory_grep',
    requiredTags: ['memory'],
    description: '检索长期记忆时间线（正则 + 时间/对象/标签过滤轴；条目级分组输出）',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JS 正则（匹配正文/origin/tags）' },
        since: { type: 'string', description: '时间下界（ISO 日期，可选）' },
        until: { type: 'string', description: '时间上界（ISO 日期，可选）' },
        peer: { type: 'string', description: '按关联对象过滤（可选）' },
        tag: { type: 'string', description: '按标签过滤（可选）' },
      },
    },
    execute: (args, call) => {
      const agentId = call.agentId;
      if (!agentId) return { ok: false, error: 'memory_grep 需要会话身份（agentId 缺失）' };
      const memory = ctx.get('memory') as MemoryService;
      try {
        return { ok: true, output: memory.grep(agentId, {
          ...(args.pattern !== undefined ? { pattern: String(args.pattern) } : {}),
          ...(args.since !== undefined ? { since: String(args.since) } : {}),
          ...(args.until !== undefined ? { until: String(args.until) } : {}),
          ...(args.peer !== undefined ? { peer: String(args.peer) } : {}),
          ...(args.tag !== undefined ? { tag: String(args.tag) } : {}),
        }) };
      } catch (err: unknown) {
        return { ok: false, error: `正则无效: ${String(err)}` };
      }
    },
  });
}