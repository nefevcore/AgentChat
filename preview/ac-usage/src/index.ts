// ============================================================
// ac-usage —— 用量统计服务（usage 双轨的消费侧）
//
// src agent-session 的 log-usage runEnd 钩子平移（地图 §3.2 /
// 资产 #10）：
//   · 记账通道 = 订阅 loop/after-run（emit 面，零 inject、零侵入）
//   · 双轨语义在契约（ac-agent-loop LoopRunUsage，M12 进契约）：
//     覆盖 = 当次上下文（末步 prompt/total）· 累加 = 总用量
//     （promptAccumulated/completion）· cache hit/miss · react_steps
//   · 审计流水：<root>/usage/usage-<date>.jsonl（本服务自有目录，
//     ADR-5；append 失败尽力而为不阻塞事件链）
//   · 查询面：内存聚合（boot 起）byAgent/byModel/byDay/byDayModel/totals
//
// M15 对账落地：持久聚合回读——构造期回读全部 usage-*.jsonl 重建
// 内存聚合（src /api/usage 的"重启即恢复"语义；单机量级全量回读
// 毫秒级，不引入 src 式快照缓存——SNAPSHOT_VERSION 演进成本
// 大于收益，有性能证据再议）。流水行新增 conversationId（byPair
// 维度的数据基础）。损坏行/缺字段行宽容跳过（对齐 src 读取口径）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import { ARCHIVE_REVIEW_META } from 'ac-agent-loop';
import type { LoopRunResult, LoopRunUsage } from 'ac-agent-loop';

/** 行配置 */
export interface UsageRowOptions {
  /** 数据根（缺省 './data'；审计流水 = <root>/usage/usage-<date>.jsonl） */
  root?: string;
}

/** 聚合桶（按 agent / 按模型两个维度共用形状） */
export interface UsageAggregate {
  /** run 数 */
  runs: number;
  /** ReAct 步数合计 */
  steps: number;
  /** 累加轨：输入 token 合计 */
  prompt: number;
  /** 补全 token 合计 */
  completion: number;
  /** 累加轨：总 token 合计（无 total 供给的步按 prompt+completion 折算） */
  total: number;
  /** 最近一次 run 的当次上下文（覆盖轨） */
  lastContextPrompt: number;
  cacheHit: number;
  cacheMiss: number;
}

/** 按日聚合桶（M15：跨天可比） */
export interface UsageDayAggregate extends UsageAggregate {
  /** YYYY-MM-DD（流水行 timestamp 的本地日期） */
  date: string;
}

/** 按日 × 模型交叉聚合桶（「按模型」堆叠图数据源） */
export interface UsageDayModelAggregate extends UsageAggregate {
  /** YYYY-MM-DD */
  date: string;
  model: string;
}

/** 按端点对聚合（弦图数据源：a/b 为两端 Agent id，'user' = 用户侧） */
export interface UsagePairAggregate extends UsageAggregate {
  a: string;
  b: string;
}

function emptyAggregate(): UsageAggregate {
  return {
    runs: 0,
    steps: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    lastContextPrompt: 0,
    cacheHit: 0,
    cacheMiss: 0,
  };
}

function mergeAggregate(acc: UsageAggregate, usage: LoopRunUsage): void {
  acc.runs += 1;
  acc.steps += usage.steps;
  acc.prompt += usage.promptAccumulated;
  acc.completion += usage.completion;
  acc.total += usage.totalAccumulated ?? usage.promptAccumulated + usage.completion;
  acc.lastContextPrompt = usage.prompt; // 覆盖轨：当次上下文
  acc.cacheHit += usage.cacheHit ?? 0;
  acc.cacheMiss += usage.cacheMiss ?? 0;
}

/** 审计流水行 */
interface UsageAuditLine {
  timestamp: string;
  agent: string;
  model: string;
  finish: string;
  usage: LoopRunUsage;
  /** 会话键（M15 入账；byPair 维度数据基础） */
  conversationId?: string;
}

/** 流水行宽容解析：缺 agent/model/usage 的行返回 null（损坏跳过） */
function parseAuditLine(raw: string): UsageAuditLine | null {
  try {
    const parsed = JSON.parse(raw) as Partial<UsageAuditLine>;
    if (
      typeof parsed.agent !== 'string' ||
      typeof parsed.model !== 'string' ||
      !parsed.usage ||
      typeof parsed.usage !== 'object'
    ) {
      return null;
    }
    return {
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
      agent: parsed.agent,
      model: parsed.model,
      finish: typeof parsed.finish === 'string' ? parsed.finish : '',
      usage: parsed.usage,
      ...(typeof parsed.conversationId === 'string' ? { conversationId: parsed.conversationId } : {}),
    };
  } catch {
    return null;
  }
}

/** 本地日期键（YYYY-MM-DD；与流水文件名同口径） */
function dayKeyOf(line: UsageAuditLine): string {
  if (line.timestamp) {
    const d = new Date(line.timestamp);
    if (!Number.isNaN(d.getTime())) {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
  }
  return 'unknown';
}

export class UsageService extends Service {
  private usageDir: string;
  private byAgentMap = new Map<string, UsageAggregate>();
  private byModelMap = new Map<string, UsageAggregate>();
  private byDayMap = new Map<string, UsageAggregate>();
  /** 日期 × 模型交叉聚合（「按模型」堆叠图数据源；键 = `${date}|${model}`） */
  private byDayModelMap = new Map<string, UsageAggregate>();
  /** M17-F：按会话协作流量（byPair 的 preview 收敛——会话键即桶键） */
  private byConversationMap = new Map<string, UsageAggregate>();
  /**
   * agent × 会话键交叉聚合（byPair 数据基础）：行级 (agent, conversationId)
   * 全量留存，查询时按会话键形态分类端点对——对桶 'a~b'（M19：直答
   * user~x / 委托 / 自会话 a~a）、迁移行（conv=agent → user 对；conv=对方
   * agent → 委托对）、群（conv=gid，排除出 byPair）、独立会话（conv=sid，
   * 排除）。
   */
  private byAgentConvMap = new Map<string, { agent: string; conversationId: string; usage: UsageAggregate }>();

  constructor(ctx: Context, options: UsageRowOptions = {}) {
    super(ctx, 'usage');
    this.usageDir = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data', 'usage');
    this.replayAuditFiles(); // M15：持久聚合回读（重启不丢看板）

    this.ctx.on('loop/after-run', (request, result) => {
      // 机制标记 run（归档整理，M20）不记账：巨型整理上下文会顶掉该桶
      // lastContextPrompt、污染 tokens 仪表（src META_ARCHIVE_REVIEW 消费方）
      if (request.meta?.[ARCHIVE_REVIEW_META] === true) return;
      try {
        this.record(
          request.agent ?? '(anonymous)',
          request.model,
          request.conversationId,
          result,
        );
      } catch (err: unknown) {
        this.ctx.logger.warn(`[usage] 记账失败: ${String(err)}`);
      }
    }, { description: '用量双轨记账（覆盖轨/累计轨）' });
  }

  /** 记一次 run（聚合 + 审计流水） */
  private record(
    agent: string,
    model: string,
    conversationId: string | undefined,
    result: LoopRunResult,
  ): void {
    mergeAggregate(this.bucket(this.byAgentMap, agent), result.usage);
    mergeAggregate(this.bucket(this.byModelMap, model), result.usage);
    const conv = conversationId ?? agent;
    mergeAggregate(this.bucket(this.byConversationMap, conv), result.usage);
    this.mergeAgentConv(agent, conv, result.usage);
    const line: UsageAuditLine = {
      timestamp: new Date().toISOString(),
      agent,
      model,
      finish: result.finish,
      usage: result.usage,
      ...(conversationId !== undefined ? { conversationId } : {}),
    };
    const day = dayKeyOf(line);
    mergeAggregate(this.bucket(this.byDayMap, day), result.usage);
    mergeAggregate(this.bucket(this.byDayModelMap, `${day}|${model}`), result.usage);
    try {
      fs.mkdirSync(this.usageDir, { recursive: true });
      fs.appendFileSync(
        path.join(this.usageDir, `usage-${line.timestamp.slice(0, 10)}.jsonl`),
        `${JSON.stringify(line)}\n`,
        'utf-8',
      );
    } catch (err: unknown) {
      // 审计流水尽力而为：失败不阻塞（聚合已在内存）
      this.ctx.logger.warn(`[usage] 审计流水写入失败: ${String(err)}`);
    }
  }

  /** agent × 会话键交叉累加（同键合并） */
  private mergeAgentConv(agent: string, conversationId: string, usage: LoopRunUsage): void {
    const key = `${agent}\u0000${conversationId}`;
    const existing = this.byAgentConvMap.get(key);
    if (existing) mergeAggregate(existing.usage, usage);
    else {
      const fresh = emptyAggregate();
      mergeAggregate(fresh, usage);
      this.byAgentConvMap.set(key, { agent, conversationId, usage: fresh });
    }
  }

  /** 回读全部审计流水重建聚合（boot 一次；损坏行跳过） */
  private replayAuditFiles(): void {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.usageDir).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      return; // 目录不存在 = 首启
    }
    let replayed = 0;
    for (const file of files) {
      let raw = '';
      try {
        raw = fs.readFileSync(path.join(this.usageDir, file), 'utf-8');
      } catch {
        continue; // 单文件读失败跳过（其余文件照常回读）
      }
      for (const row of raw.split('\n')) {
        if (!row.trim()) continue;
        const line = parseAuditLine(row);
        if (!line) continue;
        const usage: LoopRunUsage = line.usage;
        mergeAggregate(this.bucket(this.byAgentMap, line.agent), usage);
        mergeAggregate(this.bucket(this.byModelMap, line.model), usage);
        mergeAggregate(this.bucket(this.byConversationMap, line.conversationId ?? line.agent), usage);
        this.mergeAgentConv(line.agent, line.conversationId ?? line.agent, usage);
        const day = dayKeyOf(line);
        mergeAggregate(this.bucket(this.byDayMap, day), usage);
        mergeAggregate(this.bucket(this.byDayModelMap, `${day}|${line.model}`), usage);
        replayed++;
      }
    }
    if (replayed > 0) {
      this.ctx.logger.info(`[usage] 已回读 ${replayed} 条流水重建聚合（${files.length} 个文件）`);
    }
  }

  private bucket(map: Map<string, UsageAggregate>, key: string): UsageAggregate {
    let acc = map.get(key);
    if (!acc) {
      acc = emptyAggregate();
      map.set(key, acc);
    }
    return acc;
  }

  /** 按 Agent 聚合（快照拷贝） */
  byAgent(): Record<string, UsageAggregate> {
    return Object.fromEntries([...this.byAgentMap].map(([k, v]) => [k, { ...v }]));
  }

  /** 按模型聚合（快照拷贝） */
  byModel(): Record<string, UsageAggregate> {
    return Object.fromEntries([...this.byModelMap].map(([k, v]) => [k, { ...v }]));
  }

  /** 按日聚合（M15；date 升序快照拷贝） */
  byDay(): UsageDayAggregate[] {
    return [...this.byDayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }));
  }

  /** 按日 × 模型交叉聚合（「按模型」堆叠图；date 升序、model 字典序快照拷贝） */
  byDayModel(): UsageDayModelAggregate[] {
    return [...this.byDayModelMap.entries()]
      .map(([key, v]) => {
        const sep = key.indexOf('|');
        return { date: key.slice(0, sep), model: key.slice(sep + 1), ...v };
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model));
  }

  /** 按会话聚合（M17-F 弦图数据源；byPair 的 preview 收敛） */
  byConversation(): Record<string, UsageAggregate> {
    return Object.fromEntries([...this.byConversationMap].map(([k, v]) => [k, { ...v }]));
  }

  /**
   * 按端点对聚合（弦图数据源，M19 对键统一解析）：行级 (agent, conversationId)
   * 按会话键形态分类——
   *   · conv = 'a~b'（对桶：直答 user~x / 委托 a~b / 自会话 a~a）
   *                               → (a, b)          端点对
   *   · conv === agent            → ('user', agent)  迁移行兜底（旧 agentId 桶）
   *   · conv = 其他 agent id（迁移行：counterpart 落在 conversationId）
   *                               → (agent, conv)    agent⇄agent（历史数据）
   *   · conv = 群 gid / 独立会话 sid → 不进 byPair（弦图是端点对视图；
   *     群用量见 byConversation）
   * user 是普通端点（M19）——是否在弦图里显示 user 轴由视图层选择
   * （TokenUsage 的过滤是纯视图选择，非特判）。agents/group 经 ctx.get
   * 可选解析（查询时服务已就绪；缺行 = 未知名不进 byPair，宁可少不可错挂）。
   */
  byPair(): UsagePairAggregate[] {
    const agents = this.ctx.get('agents');
    const group = this.ctx.get('group');
    const groupIds = new Set(group?.list()?.map((g) => g.id) ?? []);
    const merged = new Map<string, UsagePairAggregate>();
    for (const { agent, conversationId, usage } of this.byAgentConvMap.values()) {
      let a: string | undefined;
      let b: string | undefined;
      if (conversationId.includes('~')) {
        // 对桶统一解析（M19）：user 只是端点之一，不再排除
        const [p, q] = conversationId.split('~');
        if (p && q) [a, b] = [p, q];
      } else if (conversationId === agent) {
        // 迁移行兜底：旧 agentId 桶（user⇄agent 1v1 时代的键）
        a = 'user';
        b = agent;
      } else if (agents?.has(conversationId)) {
        // 迁移行兜底：旧委托行（counterpart 落在 conversationId）
        [a, b] = [agent, conversationId].sort();
      }
      // 群 gid / 独立会话 sid / 未注册名：不进端点对
      if (a === undefined || b === undefined || a === b) continue;
      if (groupIds.has(a) || groupIds.has(b)) continue;
      const key = `${a}|${b}`;
      const acc = merged.get(key);
      if (acc) {
        acc.runs += usage.runs;
        acc.steps += usage.steps;
        acc.prompt += usage.prompt;
        acc.completion += usage.completion;
        acc.total += usage.total;
        acc.lastContextPrompt = usage.lastContextPrompt;
        acc.cacheHit += usage.cacheHit;
        acc.cacheMiss += usage.cacheMiss;
      } else {
        merged.set(key, { a, b, ...usage });
      }
    }
    return [...merged.values()].sort((x, y) => y.total - x.total);
  }

  /** 总量（全部 run） */
  totals(): UsageAggregate {
    const out = emptyAggregate();
    for (const acc of this.byAgentMap.values()) {
      out.runs += acc.runs;
      out.steps += acc.steps;
      out.prompt += acc.prompt;
      out.completion += acc.completion;
      out.total += acc.total;
      out.cacheHit += acc.cacheHit;
      out.cacheMiss += acc.cacheMiss;
    }
    return out;
  }

  /** 诊断：审计流水文件名（已有者） */
  auditFiles(): string[] {
    try {
      return fs.readdirSync(this.usageDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return [];
    }
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 用量统计服务（ac-usage 提供）：after-run 记账 + 持久回读 + byAgent/byModel/byDay/byDayModel/totals 查询 */
    usage: UsageService;
  }
}

export const name = 'ac-usage';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'usage',
  label: 'Token 用量记录',
  description: 'after-run 双轨记账 + 审计流水（用量看板数据源）',
  automatic: true,
  listeners: [{ event: 'loop/after-run', role: '双轨记账', description: 'run 结束通知（持久化/审计/指标订阅）——承重：关停用量看板断流' }],
};


export function apply(ctx: Context, options: UsageRowOptions = {}) {
  ctx.plugin(UsageService, options);
}
