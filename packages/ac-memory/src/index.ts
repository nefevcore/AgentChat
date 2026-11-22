// ============================================================
// ac-memory —— 长期记忆时间线服务（memory timeline）
//
// 重构裁决（docs/design/archive/platform/memory-timeline-plan.md，2026-12-08 cr-4）：
//   · 记忆归属主体 = Agent 人格（非会话桶）：单文件
//     files/<agentId>/memory/timeline.md，条目 = 宿主铸造头注释
//     （时间戳/origin=写入时会话标识/peers/tags）+ 正文；seq 位置派生。
//   · 旧桶注入协议（<memory> 块进 system）退役——记忆内容与 system 彻底
//     解耦：system 侧只剩恒定静态指引（数行），内容走会话流 context 行
//     （checkpoint 快照 + delta，尾部追加——KV 零失效）。
//   · 工具面：memory_write（append-only）/ memory_grep（检索）——
//     requiredTags ['memory']（与 fs 正交）；needPermission false。
//   · 跨会话可见是有意语义（人格连续性）：本会话写入的 delta 不重复注入
//     （tool-call 历史已有副本），他源 delta 注入。注入水位归时间线私有
//     （.anchors.json，cr-1154）——账本注入行是纯回放材料，不承载水位。
// cr-1252 物化 seq + 遗忘口：头注释铸单调 seq:N（write 基数 = max(主文件,
//   forget 归档)+1 全文件派生零计数器——防尾部遗忘后撞号）；水位 H = maxSeq
//   （中间遗忘零重注，存量顺编后与旧 length 语义无缝）；memory_forget 把
//   条目移入 timeline.forget.md 回收站（副本先落再删正本——崩溃窗口至多
//   无害重复；降级行无稳定句柄拒收；forget 文件纯档案不进注入/grep）。
// ============================================================
import * as fs from 'node:fs';
//（cr-1251：wrapSystemReminder import 随双写退役——包裹归 loop 消费点）
import { parseKey } from 'ac-conv-keys'; // 会话键词法单源（cr-1238 B3）
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import { grepEntries, maxSeqOf, mintEntry, mintForgotten, parseTimeline, renderDelta, renderGrepResult, renderSnapshot, type MemoryEntry } from 'ac-memory-core';
import { isPresetId } from 'ac-agents-core'; // 预设词形判定单源（cr-880）
import { DreamController, type DreamSettings } from './dream.ts'; // cr-1254 记忆整理轮
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
  /** 记忆整理轮（dream）配置缺省；per-Agent settings['memory'].dream 覆盖 */
  dream?: DreamSettings;
}

export interface MemorySettings {
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
 * system 静态指引（KV 声明纪律：字节恒定——记忆内容与 system 解耦）。
 */
const MEMORY_GUIDE =
  '<memory-guide>\n' +
  '你拥有跨会话的长期记忆时间线（自动注入近期内容；他源新增也会注入）。\n' +
  '· memory_write：把值得长期记住的信息写成条目——正文以 [标签] 段开头（标签从小词表取：约定/偏好/事实/教训/待办/档案），可选 peers 标关联对方、date 回填事实发生日（整理旧资料时用，缺省=今天）。在当下就写，不要等会话结束。\n' +
  '· 条目约定：一条 = 一件自包含的事（未来只看这条就能想起全部来龙去脉；超长叙事拆条）；日期前缀系统自动铸造，正文不要再写日期。\n' +
  '· 过时信息不必删改：写新条目自然覆盖。确有问题的条目（错误/冗余/失效）可 memory_forget 移入遗忘归档（不再注入与检索；归档文件可恢复）。需要检索更早记忆用 memory_grep（支持时间/对象/标签过滤）。\n' +
  '</memory-guide>';

/**
 * 本地日期 + 当前本地时刻 → UTC ISO 串。
 *
 * date 参数（YYYY-MM-DD）语义是**本地日**。原实现把本地日期与 UTC 时分直接拼接
 * （`${date}T${new Date().toISOString().slice(11)}`），按 UTC 解析后整体前移一天：
 * 东八区实测本地 11-23 05:35 写成 `11-23T21:35Z`，解析回本地是 11-24 05:35。
 * 本函数按本地日历构造「该日期 + 当下时分」，再 toISOString 转 UTC——
 * 得到的是同一瞬间的正确 UTC 表示。
 */
function localDateWithCurrentTime(dateStr: string): string {
  const now = new Date();
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds()).toISOString();
}

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
      const timer = setTimeout(() => {
        // cr-1252 存量顺编先行（同步轻量：每 Agent 一次读判 + 至多一次重写）——
        // 幂等（全物化即跳过），跑在旧桶迁移前保证新写入基数就位
        try {
          const agents = this.ctx.get('agents', false) as
            | { list(): Array<Record<string, unknown> & { id: string }> }
            | undefined;
          for (const agent of agents?.list() ?? []) this.materializeSeq(agent.id);
        } catch {
          // 顺编失败不阻断 boot——下次 boot 重试（幂等）
        }
        void this.migrateLegacyBuckets();
      }, 100);
      this.ctx.fiber.effect(() => () => clearTimeout(timer), 'memory.migrate');
    }



    // 记忆整理轮（cr-1254）：run 收束后自检触发条件 → 自会话唤醒整理 run
    //（写口水位 .dream.json；conversation 行缺席时静默降级）
    new DreamController(this.ctx, this, options.dream ?? {}).mount();

    // 回放声明（cr-1104 注册制）：memory 两词的回放档由本行 owning 声明
    //（wrapper——快照/delta 注入体）。账本行未装 = 降级缺省 wrapper。
    {
      const ledger = this.ctx.get('ledger', false) as { registerReplayPolicy?: (d: { source: string; replay: 'original' | 'wrapper' | 'none' }) => unknown } | undefined;
      ledger?.registerReplayPolicy?.({ source: 'memory-snapshot', replay: 'wrapper' });
      ledger?.registerReplayPolicy?.({ source: 'memory-delta', replay: 'wrapper' });
    }

    // ---- checkpoint/delta 注入协议（loop/before-run seam——cr-1102 迁移） ----
    // 原挂 conversation/before-start（主线 ac-conversation 事件）：生产壳树
    // ConversationService 从不 emit 该事件（主线行不在壳装配），注入协议
    // 整体失效。迁移到 loop/before-run waterfall——两树（主线 host / 生产
    // 壳）唯一共有的 run 前 seam（ac-skill 手势注入同款先例），注入双写：
    //   · session.recordContext 落账（壳内活跃 run → journalInject 事件，
    //     injectSource=memory-snapshot/delta；主线 → context 行）；
    //   · 同字节 user 消息 append 进 request.messages（当前 run 即刻可见；
    //     下一轮回放取自落账行——字节一致，无双计）。
    // cr-1154 水位归时间线私有：注入水位不再寄居账本注入行（cr-46 串台 /
    // cr-1102 读面迁移 / cr-1107 payload 显式化——三轮补丁仍随账本层演化
    // 反复炸：v1 无 seq 行永踞 recordsFor 投影尾部 → 锚永命中旧行 → S 冻结
    // → 每 run 重注）。水位状态 = files/<agentId>/memory/.anchors.json
    // （{会话键: 已注入条目水位}，per-Agent×会话粒度——每个会话桶各自看
    // 到它还没见过的跨会话记忆，多桶各注各的是产品语义而非重复；真正的
    // 病灶是同一桶重复注）。判定退化为纯函数：
    //   无锚 或 S>H → 快照重定基线；H>S → delta=(S,H] 过滤本会话 origin；
    //   H=S → 稳态不注入。
    // 账本注入行降级为纯回放材料——recordContext 失败 fail-soft（只丢该次
    // 回放行），不影响水位推进；锚文件 tmp+rename 原子写，崩溃窗口最坏
    // = 注入成功但锚未落 → 下次重注同 delta 一次（幂等收敛）。
    this.ctx.on('loop/before-run', async (call, next) => {
      const req = call.request;
      // cr-1233 干跑（previewSystemPrompt）：只读预览不落账不推水位
      if (req.dryRun === true || call.inject === undefined) return next();
      if (req.conversationId === undefined || req.agent === undefined) return next();
      const agentId = req.agent;
      const conversationId = req.conversationId;
      const entries = this.entries(agentId);
      // cr-1252 水位语义：H = maxSeq（物化空间高度，非条目数）——forget 中间
      // 条目 maxSeq 不变 ⇒ 稳态零重注；存量顺编迁移后 maxSeq == 旧 length 值，
      // 锚无缝。delta 过滤 seq > S 照常（不连续 seq 空间下语义不变）。
      const H = entries.reduce((m, e) => (e.seq > m ? e.seq : m), 0);
      const S = this.anchorOf(agentId, conversationId);
      const maxTokens = this.maxTokensFor(agentId);
      /** cr-1251 注入面单写：消息进数组 + 消费点落账（包裹同源）由 loop
       * 统一承担 + 锚推进（S 单调不降——cr-1154：水位归本服务私有，
       * 账本行不再承载）。 */
      const inject = (text: string, source: string, label: string): void => {
        call.inject!({ role: 'user', content: text }, { injectSource: source, label });
        this.setAnchor(agentId, conversationId, H);
      };
      if (S > H) {
        // H<S（文件被人工缩短）→ 全量快照重定基线（自愈语义沿袭）
        inject(renderSnapshot(entries, { maxTokens }), MEMORY_SNAPSHOT_SOURCE, '长期记忆快照注入');
        return next();
      }
      if (S === 0 && H === 0) return next(); // 空时间线不注入（静态指引已告知 memory_write）
      if (S === 0) {
        // 无锚（新会话）→ 全量快照重定基线
        inject(renderSnapshot(entries, { maxTokens }), MEMORY_SNAPSHOT_SOURCE, '长期记忆快照注入');
        return next();
      }
      if (H > S) {
        // delta = (S, H] 且 origin ≠ 本会话（本会话写入已有 tool-call 副本）
        const delta = entries.filter((e) => e.seq > S && e.origin !== conversationId);
        const text = renderDelta(delta, { from: S, to: H });
        if (text !== undefined) {
          inject(text, MEMORY_DELTA_SOURCE, '长期记忆增量注入');
        }
      }
      // H === S：正常稳态，不注入
      return next();
    }, { description: '记忆 checkpoint/delta 注入（loop/before-run：私有水位判定 + 落账/工作数组双写 + 锚推进）' });
  }

  // ---- 注入水位（cr-1154：时间线私有状态，per-Agent×会话） ----

  /** persist=false 纯内存后端的锚映射（persist=true 时恒空——读写走文件） */
  private anchorStore = new Map<string, number>();

  /** 锚文件路径：与 timeline.md 同目录（.anchors.json） */
  private anchorFileOf(agentId: string): string {
    return path.join(path.dirname(this.timelineFileOf(agentId)), '.anchors.json');
  }

  /** 读水位：无锚 = 0（新会话语义）。读失败/坏文件 = 0（fail-soft：
   * 最坏重注一次快照收敛，无震荡——锚文件损坏不阻断注入链） */
  private anchorOf(agentId: string, conversationId: string): number {
    if (!this.persist) return this.anchorStore.get(agentId + '\u0000' + conversationId) ?? 0;
    try {
      const raw = fs.readFileSync(this.anchorFileOf(agentId), 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const v = parsed[conversationId];
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0;
    }
  }

  /** 写水位（S 单调不降）：tmp+rename 原子写。多会话并发写 = read-modify-write
   * 竞态，last-write-wins 且每会话只写自己的键——丢的是对方会话尚未推进的
   * 锚（下次注入重算），无损全局收敛；单会话内 run 串行化门保证无自竞态。 */
  private setAnchor(agentId: string, conversationId: string, seq: number): void {
    if (!this.persist) {
      const cur = this.anchorStore.get(agentId + '\u0000' + conversationId) ?? 0;
      if (seq > cur) this.anchorStore.set(agentId + '\u0000' + conversationId, seq);
      return;
    }
    const file = this.anchorFileOf(agentId);
    let anchors: Record<string, number> = {};
    try {
      anchors = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, number>;
    } catch {
      // 缺席/坏文件 → 覆盖重建（本会话键起步，其余会话下次注入时快照自愈）
    }
    if ((anchors[conversationId] ?? 0) >= seq) return; // 单调不降
    anchors[conversationId] = seq;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(anchors), 'utf-8');
      fs.renameSync(tmp, file);
    } catch {
      // 写失败 = 下次重注同 delta 一次（幂等收敛），不阻断注入链
    }
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
    // date 参数语义是**本地日**（YYYY-MM-DD，回填/迁移用）；时分取当下本地时刻。
    // 原实现 `${input.date}T${UTC时分}` 把本地日期与 UTC 时分拼在一起，生成的
    // 串按 UTC 解析后整体前移一天（东八区实测：本地 11-23 05:35 写成 11-23T21:35Z
    // ⇒ 解析回本地是 11-24 05:35）。修法：按本地日历构造该日当前时刻再转 UTC。
    const date = input.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(input.date)
      ? localDateWithCurrentTime(input.date)
      : new Date().toISOString();
    // cr-1252 物化 seq：基数 = 三维下界（见 nextSeqOf）——seq 一旦铸造永不重用。
    const seq = this.nextSeqOf(agentId);
    const line = mintEntry({
      at: date,
      origin: input.origin ?? agentId,
      seq,
      ...(input.peers && input.peers.length > 0 ? { peers: input.peers } : {}),
      content: input.content,
    });
    if (!this.persist) {
      const prev = this.store.get(agentId) ?? '';
      this.store.set(agentId, prev + (prev.endsWith('\n') || prev === '' ? '' : '\n') + line);
      return seq;
    }
    const file = this.timelineFileOf(agentId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, 'utf-8');
    return seq;
  }

  /**
   * 下一个物化 seq（cr-1252）：三维下界取 max + 1。
   *   ① 物化 maxSeq（主文件）；② 条目总数——无 seq 条目的位置派生 seq 恰好
   *   落在 (物化max, 条目数] 区间，不把这个上界纳入下界就会撞号（现场：
   *   tester 旧代码壳在换代窗口写入 3 条无 seq 条目 → 位置派生 228-230，
   *   而物化 max 仅 227，下次铸造差一撞号）；③ forget 归档高水位（防尾部
   *   遗忘后复用号）。全文件派生零计数器——崩溃安全 by construction。
   */
  private nextSeqOf(agentId: string): number {
    const text = this.persist ? this.readOr(this.timelineFileOf(agentId)) : (this.store.get(agentId) ?? '');
    const forgetText = this.persist ? this.readOr(this.forgetFileOf(agentId)) : '';
    const forgetMax = this.persist ? maxSeqOf(forgetText) : (this.forgetStore.get(agentId) ?? 0);
    return Math.max(maxSeqOf(text), parseTimeline(text).length, forgetMax) + 1;
  }

  /** 读文件文本（缺席/失败 → 空串：新 Agent 与首次 forget 的常态） */
  private readOr(file: string): string {
    try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; }
  }

  /** forget 归档文件路径（与 timeline.md 同目录） */
  forgetFileOf(agentId: string): string {
    return path.join(path.dirname(this.timelineFileOf(agentId)), 'timeline.forget.md');
  }

  /** persist=false 纯内存后端的 forget 高水位（persist=true 时恒空） */
  private forgetStore = new Map<string, number>();

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

  /**
   * 遗忘条目（cr-1252 memory_forget 服务写口）：条目移入 forget 归档——
   * ① 先 append 副本进 timeline.forget.md（forgotten 时间戳 + 可选 reason
   * 头注释重铸）；② 再 tmp+rename 重写 timeline.md 删除该条。定序铁律：副本
   * 先落——中间崩溃 = forget 里有副本但正本没删 = 无害重复（续删幂等跳过①）；
   * 反序则崩溃窗口条目真丢（两边都没有）。只接受物化 seq 条目（降级行
   * 无稳定句柄，须先 write 正规化再 forget）。seq 查重：已在 forget 文件
   * 则跳过①（幂等续删/重复调用安全）。
   */
  forget(agentId: string, seq: number, reason?: string): { ok: boolean; error?: string } {
    const entries = this.entries(agentId);
    const target = entries.find((e) => e.seq === seq);
    if (target === undefined) return { ok: false, error: `条目 #${seq} 不存在（可能已被遗忘或 seq 无效）` };
    if (!this.isMaterialized(target)) {
      return { ok: false, error: `条目 #${seq} 是无头降级行（位置派生 seq 不稳定）——先写新条目承接其内容，再 forget 该条目` };
    }
    const forgottenAt = new Date().toISOString();
    if (!this.persist) {
      this.forgetStore.set(agentId, Math.max(this.forgetStore.get(agentId) ?? 0, seq));
      this.store.set(agentId, this.removeEntryText(this.store.get(agentId) ?? '', target));
      return { ok: true };
    }
    const forgetFile = this.forgetFileOf(agentId);
    // ① 幂等查重：seq 已在 forget 文件 → 跳过落副本（续删/重入）
    let forgetText = '';
    try { forgetText = fs.readFileSync(forgetFile, 'utf-8'); } catch { /* 首次 forget */ }
    if (!new RegExp(`\\bseq:${seq}\\b`).test(forgetText)) {
      fs.mkdirSync(path.dirname(forgetFile), { recursive: true });
      fs.appendFileSync(forgetFile, mintForgotten(target, forgottenAt, reason), 'utf-8');
    }
    // ② 重写正本（tmp+rename 原子）：剔除目标条目块
    const file = this.timelineFileOf(agentId);
    let mainText = '';
    try { mainText = fs.readFileSync(file, 'utf-8'); } catch { return { ok: false, error: 'timeline.md 读取失败' }; }
    const rewritten = this.removeEntryText(mainText, target);
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, rewritten, 'utf-8');
      fs.renameSync(tmp, file);
    } catch {
      return { ok: false, error: 'timeline.md 重写失败（副本已落 forget 归档，重试安全）' };
    }
    return { ok: true };
  }

  /**
   * 从时间线全文剔除条目：按 mint 形态重建目标头注释行定位（at/seq/peers
   * 与写入时同源），块边界 = 该头注释行至下一头注释行前。头行不匹配
   * （被人工改写）→ 原文返回不动（幂等安全——fail-soft）。
   */
  private removeEntryText(text: string, target: MemoryEntry): string {
    const lines = text.split('\n');
    const headerIdx = lines.findIndex((l) => l.trim() === this.headerLineOf(target));
    if (headerIdx < 0) return text;
    let end = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith('<!--')) { end = i; break; }
    }
    const kept = [...lines.slice(0, headerIdx), ...lines.slice(end)];
    // 收敛连续空行（块删除残留），末尾补换行
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  /** 目标条目的头注释行（mint 形态重建——at/seq/origin/peers 与写入时同源） */
  private headerLineOf(e: MemoryEntry): string {
    return mintEntry({ at: e.at!, origin: e.origin ?? '', seq: e.seq, ...(e.peers && e.peers.length > 0 ? { peers: e.peers } : {}), content: '' }).split('\n')[0];
  }

  /** 物化判定：头注释带合法 seq:N（parse 侧 materialized 标记——位置派生兜底不算） */
  private isMaterialized(e: MemoryEntry): boolean {
    return e.materialized === true;
  }

  /** 过滤轴查询（memory_grep / 服务面共用） */
  grep(agentId: string, q: { pattern?: string; since?: string; until?: string; peer?: string; tag?: string }): string {
    return renderGrepResult(grepEntries(this.entries(agentId), q));
  }

  // ============================================================
  // 存量迁移（版本切换一次性）
  // ============================================================

  /**
   * 存量 timeline.md 物化 seq 顺编（cr-1252 迁移，一次性）：boot 延迟触发，
   * 按当前解析序给每个条目头补写 seq:1..N（已有合法 seq 的条目保持不动，
   * 仅降级行获得位置派生 seq——迁移后 nextSeqOf 基数自然就位）。幂等：
   * 全部条目已物化即跳过。顺编后 maxSeq = N = 旧 entries.length ⇒ 存量
   * .anchors.json 水位零漂移（H 语义从 length 切 maxSeq 无缝）。
   */
  materializeSeq(agentId: string): void {
    const file = this.timelineFileOf(agentId);
    if (!this.persist) return; // 纯内存后端无存量
    let text: string;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { return; }
    const entries = parseTimeline(text);
    if (entries.length === 0) return;
    if (entries.every((e) => e.materialized === true)) return; // 全物化：幂等出口
    // 整文重铸（正文原样，parse 侧已 trim 尾空白——重铸至多收敛多余空行）。
    // seq 分配：已物化保原号（跨会话引用不失效），无 seq 条目从 max+1 起
    // 递增并跳过已占用号（乱序输入也零撞号；forget 空号不复用）。降级行
    // （无头/坏头）获得铸造头正规化——at 缺失用 epoch 兜底保条目序稳定。
    const taken = new Set<number>();
    for (const e of entries) if (e.materialized === true) taken.add(e.seq);
    let next = taken.size > 0 ? Math.max(...taken) + 1 : 1;
    const alloc = (): number => { while (taken.has(next)) next++; taken.add(next); return next++; };
    let out = '';
    for (const e of entries) {
      const seq = e.materialized === true ? e.seq : alloc();
      const peers = e.peers && e.peers.length > 0 ? ` | peers:${e.peers.join(',')}` : '';
      out += `<!-- at:${e.at ?? new Date(0).toISOString()} | origin:${e.origin ?? ''} | seq:${seq}${peers} -->\n${e.content}\n`;
    }
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, out, 'utf-8');
      fs.renameSync(tmp, file);
    } catch {
      // 写失败 = 下次 boot 重试（幂等），不影响注入链
    }
  }

  /**
   * 存量桶迁移（boot 延迟触发；public 供测试/手动重发）：逐 Agent 投递
   * 迁移 run（指路提示词——不内嵌旧记忆内容，见 migratePrompt 裁决注）；
   * marker 落盘幂等；旧桶文件保留不删（供回查），不再注入。cr-953：tags
   * 门退役——本行在场 = 本壳全体 Agent 有记忆能力面（行装载单闸），infra
   * 等价授予与补标签通路随之退役；预设仍不迁移（软停用）。
   */
  async migrateLegacyBuckets(): Promise<void> {
    const agents = this.ctx.get('agents', false) as
      | { list(): Array<Record<string, unknown> & { id: string }> }
      | undefined;
    const conversation = this.ctx.get('conversation', false) as
      | { deliver(agentId: string, inbound: string, options: Record<string, unknown>): Promise<unknown> }
      | undefined;
    if (agents === undefined || conversation === undefined) return;
    for (const agent of agents.list()) {
      const markerFile = path.join(path.dirname(this.timelineFileOf(agent.id)), '.migrated');
      if (fs.existsSync(markerFile)) continue;
      const buckets = this.readLegacyBuckets(agent.id);
      if (buckets.length === 0) {
        this.writeMarker(markerFile);
        continue;
      }
      if (isPresetId(agent.id)) {
        this.ctx.logger.warn(`[memory] 预设 Agent ${agent.id} 不迁移记忆（预设软停用）`);
        continue;
      }
      const prompt = this.migratePrompt();
      try {
        await conversation.deliver(agent.id, prompt, {
          conversationId: `${agent.id}~${agent.id}`,
          sender: agent.id,
          source: 'event',
          placement: 'next-run',
          meta: { 'memory-migrate': true },
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
   * DONE-archive-* 等）不是记忆桶，不进迁移（提示词只指路，Agent 自己读）。
   */
  private readLegacyBuckets(agentId: string): Array<{ key: string; text: string }> {
    const dir = path.dirname(this.timelineFileOf(agentId));
    const isBucketKey = (stem: string): boolean => {
      const s = parseKey(stem);
      return s.shape === 'pair' || s.shape === 'group' || stem === agentId;
    };
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
  description: '长期记忆时间线（ctx.memory）：Agent 人格单文件 timeline.md（物化单调 seq）+ checkpoint/delta 流式注入（KV 零失效）+ memory_write/memory_grep/memory_forget 工具（forget = 遗忘归档回收站语义）',
  fields: [
    { name: 'maxTokens', type: 'number', min: 0, step: 1000, default: DEFAULT_MAX_TOKENS, description: '快照注入 token 预算（整数条截断 + 溢出注记）' },
  ],
  listeners: [
    { event: 'loop/before-run', role: '静态指引注入（段注册制）', description: '字节恒定的 memory-guide（内容走 context 行协议）' },
    { event: 'loop/before-run', role: 'checkpoint/delta 注入（cr-1154）', description: '私有水位判定（.anchors.json：H>S delta / H=S 稳态 / 无锚或 H<S 快照重定基线）+ 落账/工作数组双写 + 锚推进' },
    { event: 'loop/after-run', role: '记忆整理轮 dream（cr-1254）', description: '间隔 ∧（新增 ≥N ∨ 条目超阈）→ 自会话唤醒整理 run（memory_grep/write/forget 三件套落账）；水位 .dream.json' },
  ],
};

/**
 * 工具行注入：memory_write / memory_grep（requiredTags ['memory']——与 fs
 * 正交；needPermission false——写口有界，落自身专用空间）。
 */
export const inject = ['tools', 'agentLoop'];

export function apply(ctx: Context, options: MemoryRowOptions = {}) {
  ctx.plugin(MemoryService, options);
  // ---- system 静态指引（MEMORY 段，cr-881：字节恒定；内容走 context 行协议） ----
  ctx.agentLoop.registerPromptSection({
    name: 'MEMORY',
    text: (request) => (request.agent === undefined ? '' : MEMORY_GUIDE),
  }, 'ac-memory');
  ctx.tools.register({
    name: 'memory_write',
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
    name: 'memory_forget',
    description: '遗忘一条记忆：把指定条目移入遗忘归档（timeline.forget.md），不再注入也不再检索到。适用于确有问题的条目（错误结论/已失效的旧约定/重复冗余）；常规过时信息不必遗忘——写新条目自然覆盖。误遗弃可从归档文件恢复（同目录 timeline.forget.md）。',
    parameters: {
      type: 'object',
      properties: {
        seq: { type: 'number', description: '要遗忘的条目序号（memory_grep 输出中的 #N）' },
        reason: { type: 'string', description: '遗忘理由（可选；记入归档头注释，供审计）' },
      },
      required: ['seq'],
    },
    execute: (args, call) => {
      const agentId = call.agentId;
      if (!agentId) return { ok: false, error: 'memory_forget 需要会话身份（agentId 缺失）' };
      const memory = ctx.get('memory') as MemoryService;
      const seq = Number(args.seq);
      if (!Number.isInteger(seq) || seq <= 0) return { ok: false, error: 'seq 必须是正整数（memory_grep 输出中的 #N）' };
      const r = memory.forget(agentId, seq, args.reason !== undefined ? String(args.reason) : undefined);
      return r.ok ? { ok: true, output: `已遗忘条目 #${seq}` + (r.error !== undefined ? `（${r.error}）` : '') } : { ok: false, error: r.error };
    },
  });
  ctx.tools.register({
    name: 'memory_grep',
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
