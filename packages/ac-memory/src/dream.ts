// ============================================================
// dream.ts —— 睡眠期记忆整理轮（dream，cr-1254）
//
// 灵感与依据：Anthropic《The components of agent memory》（2026-11-05）的
//   Dreaming 范式 + Letta 的 sleep-time compute——利用空闲时段对记忆做
//   巩固：纠错/合并/沉降/精炼，而不是等到注入预算被旧条目挤爆。
//
// 归位：本控制器住在 ac-memory 行内（不是独立行）——整理对象是记忆时间线
//   本身，离开记忆服务整行无意义（inject 判据）；per-Agent 开关走
//   settings['memory'].dream.enabled（缺省开）。
//
// 机制形态（对齐 archive 整理轮，但写口不同）：
//   · 触发 = run 收束后检测（loop/after-run）：间隔够久 ∧（新增够多 ∨
//     条目超硬阈值）→ 唤醒一次整理 run；同一 Agent 单飞 + 冷却。
//   · 唤醒 = conversation.deliver 普通 run（自会话）——排队/steer/落账/
//     崩溃恢复全套白拿；requestId 前缀 dream-run- 使自身 run 不重复触发。
//   · 写口 = Agent 自己的工具（memory_grep 读 / memory_write 写 /
//     memory_forget 遗忘）——整理产物是「新条目 + 遗忘旧条目」，不直接
//     改写文件（append-only + 回收站语义不被绕过）。
//   · 收束 = 整理 run 的 after-run 更新水位（.dream.json：lastDreamAt /
//     lastEntryCount）——不做轮询等待，事件驱动天然幂等。
//
// 指令纪律（Anthropic 实证：给方向、不给硬性规则——强模型上固定规则反
//   而降低记忆增益）；限额 maxSteps 防失控。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import type { MemoryEntry } from 'ac-memory-core';

/** dream 行配置（settings['memory'].dream 覆盖） */
export interface DreamSettings {
  /** 关闭整理轮（缺省开） */
  enabled?: boolean;
  /** 两次整理最小间隔（小时，缺省 20） */
  minIntervalHours?: number;
  /** 触发所需的记忆新增条目数（缺省 8——低于此不唤醒，防空转） */
  minNewEntries?: number;
  /** 条目数硬阈值（缺省 400——膨胀治理独立触发，绕开新增数门槛） */
  maxEntries?: number;
  /** 整理 run 步数上限（缺省 20——限额防失控） */
  maxSteps?: number;
}

/** 记忆服务最小结构面（避免 index ↔ dream 循环依赖） */
interface MemoryFace {
  entries(agentId: string): MemoryEntry[];
  timelineFileOf(agentId: string): string;
}

/** deliver 最小结构面（use-time 软取——conversation 行缺席时静默不整理） */
interface ConversationFace {
  deliver(agentId: string, inbound: string, options: Record<string, unknown>): Promise<unknown>;
}

interface DreamState {
  /** 上次整理完成时刻（ms） */
  lastDreamAt?: number;
  /** 上次投递尝试时刻（ms）——重试下界（防投递成功但 run 不完成时的反复重投） */
  lastAttemptAt?: number;
  /** 上次整理完成时的条目数（增量基线） */
  lastEntryCount?: number;
}

/** 整理 run 的 requestId 前缀（runId = 'run-' + requestId——自身不重复触发） */
export const DREAM_REQUEST_PREFIX = 'dream-run-';
const DREAM_RUN_PREFIX = 'run-' + DREAM_REQUEST_PREFIX;

const DEFAULT_MIN_INTERVAL_HOURS = 20;
const DEFAULT_MIN_NEW_ENTRIES = 8;
const DEFAULT_MAX_ENTRIES = 400;
const DEFAULT_MAX_STEPS = 20;
/** 在途整理轮的失效窗（超窗视为投递丢失，允许重来） */
const PENDING_TTL_MS = 15 * 60_000;
/** 重试下界：上一次投递尝试距现在不足此值时不再投（防反复重投） */
const RETRY_GAP_MS = 60 * 60_000;

export class DreamController {
  /** 在途整理轮（agentId → 投递时刻；单飞 + 超窗自愈） */
  private pending = new Map<string, number>();
  // 显式字段声明 + 构造赋值（Node strip-only 加载器禁类参数属性——仓规红线）
  private ctx: Context;
  private memory: MemoryFace;
  private defaults: DreamSettings;

  constructor(ctx: Context, memory: MemoryFace, defaults: DreamSettings = {}) {
    this.ctx = ctx;
    this.memory = memory;
    this.defaults = defaults;
  }

  /** 挂载触发检测（apply 内一次性调用） */
  mount(): void {
    this.ctx.on('loop/after-run', (request) => {
      const agentId = request.agent;
      if (agentId === undefined) return;
      // 整理轮自身收束 → 记水位（不检测，防自激）
      if ((request.runId ?? '').startsWith(DREAM_RUN_PREFIX)) {
        this.complete(agentId);
        return;
      }
      void this.maybeDream(agentId).catch((err: unknown) => {
        this.ctx.logger.warn('[dream] 触发检测失败（' + agentId + '）: ' + String(err));
      });
    }, { description: '记忆整理轮（dream）触发检测：间隔 ∧（新增 ∨ 超阈）→ 自会话唤醒整理 run' });
  }

  /**
   * 触发判定（幂等）：间隔够久 且（新增够多 或 条目超硬阈值）→ 唤醒。
   * 无记忆 / 整理轮在途 / 配置关闭 → 静默跳过（良定义降级）。
   */
  private async maybeDream(agentId: string): Promise<void> {
    const cfg = this.settingsOf(agentId);
    if (cfg.enabled === false) return;
    const requestedAt = this.pending.get(agentId);
    if (requestedAt !== undefined) {
      if (Date.now() - requestedAt < PENDING_TTL_MS) return; // 在途
      this.pending.delete(agentId); // 超窗：投递丢失，允许重来
    }
    const entries = this.memory.entries(agentId);
    if (entries.length === 0) return;
    const state = this.readState(agentId);
    const intervalMs = this.intervalMsOf(agentId, cfg);
    if (Date.now() - (state.lastDreamAt ?? 0) < intervalMs) return;
    if (Date.now() - (state.lastAttemptAt ?? 0) < RETRY_GAP_MS) return; // 重试下界
    const growth = entries.length - (state.lastEntryCount ?? 0);
    const overSize = entries.length >= (cfg.maxEntries ?? DEFAULT_MAX_ENTRIES);
    if (growth < (cfg.minNewEntries ?? DEFAULT_MIN_NEW_ENTRIES) && !overSize) return;
    const conv = this.ctx.get('conversation', false) as ConversationFace | undefined;
    if (conv === undefined) return; // 会话行缺席 = 无法唤醒（静默降级）
    const now = Date.now();
    this.pending.set(agentId, now);
    try {
      await conv.deliver(agentId, this.promptOf(entries, state), {
        sender: agentId,
        source: 'event',
        conversationId: agentId + '~' + agentId, // 自会话：不打扰任何用户线程
        requestId: DREAM_REQUEST_PREFIX + now,
        mechanism: true,
        budget: 3,
        maxSteps: cfg.maxSteps ?? DEFAULT_MAX_STEPS,
        meta: { origin: 'dream' },
      });
      // 尝试时刻先落盘（与 pending 互为兜底：进程重启丢 pending 也不会立刻重投）
      this.writeState(agentId, { ...state, lastAttemptAt: now });
      this.ctx.logger.info('[dream] 已唤醒整理轮（' + agentId + '，' + entries.length + ' 条）');
    } catch (err: unknown) {
      this.pending.delete(agentId);
      this.ctx.logger.warn('[dream] 整理轮投递失败（' + agentId + '）: ' + String(err));
    }
  }

  /**
   * 间隔（含 per-Agent 抖动 ±15%）：多 Agent 同批部署时错峰唤醒，避免惊群
   * （所有壳在同一分钟齐发整理 run）。哈希只依赖 agentId——同一 Agent 的
   * 抖动恒定，行为可预测，便于排障。
   */
  private intervalMsOf(agentId: string, cfg: DreamSettings): number {
    const base = (cfg.minIntervalHours ?? DEFAULT_MIN_INTERVAL_HOURS) * 3600_000;
    let h = 0;
    for (let i = 0; i < agentId.length; i++) h = (h * 31 + agentId.charCodeAt(i)) % 1000;
    return Math.round(base * (0.85 + 0.3 * (h / 1000)));
  }

  /** 整理轮收束：记水位（lastDreamAt + 条目基线——下次增量从这里起算） */
  private complete(agentId: string): void {
    this.pending.delete(agentId);
    const count = this.memory.entries(agentId).length;
    this.writeState(agentId, { lastDreamAt: Date.now(), lastEntryCount: count });
    this.ctx.logger.info('[dream] 整理轮完成（' + agentId + '，' + count + ' 条）');
  }

  /** 状态文件：与 timeline.md 同目录 .dream.json（记忆域私有，tmp+rename 原子） */
  private stateFileOf(agentId: string): string {
    return path.join(path.dirname(this.memory.timelineFileOf(agentId)), '.dream.json');
  }

  private readState(agentId: string): DreamState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFileOf(agentId), 'utf-8')) as unknown;
      // 原样返回（字段逐条白名单会让新增字段静默失传——cr-1254 现场：
      // lastAttemptAt 被剥掉后重试下界失效）；只挡非对象畸形值。
      return parsed !== null && typeof parsed === 'object' ? parsed as DreamState : {};
    } catch {
      return {}; // 缺席/坏文件 = 从未整理（最坏多整理一次，幂等收敛）
    }
  }

  private writeState(agentId: string, state: DreamState): void {
    try {
      const file = this.stateFileOf(agentId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf-8');
      fs.renameSync(tmp, file);
    } catch {
      // 写失败 = 下次重整理一次（幂等），不阻断
    }
  }

  /** per-Agent 配置（settings['memory'].dream） */
  private settingsOf(agentId: string): DreamSettings {
    const agents = this.ctx.get('agents', false) as
      | { settingsOf(id: string, name?: string): unknown }
      | undefined;
    const cfg = agents?.settingsOf(agentId, 'memory');
    const dream = cfg !== null && typeof cfg === 'object'
      ? (cfg as { dream?: unknown }).dream
      : undefined;
    return { ...this.defaults, ...(dream !== null && typeof dream === 'object' ? dream as DreamSettings : {}) };
  }

  /**
   * 整理指令（措辞按「给方向不给规则」：四类动作 + 纪律，做多少由 Agent 判断）。
   * 统计行给足定位信息（条数/时间跨度/tag 分布）——避免 Agent 为摸底而翻全量。
   */
  private promptOf(entries: MemoryEntry[], state: DreamState): string {
    const times = entries.map((e) => e.at).filter((t): t is string => t !== undefined).sort();
    const span = times.length > 0 ? times[0].slice(0, 10) + ' ~ ' + times[times.length - 1].slice(0, 10) : '时间未知';
    const tags = new Map<string, number>();
    for (const e of entries) for (const t of e.tags ?? []) tags.set(t, (tags.get(t) ?? 0) + 1);
    const tagLine = tags.size > 0
      ? [...tags.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => t + '×' + n).join('、')
      : '无标签';
    const last = state.lastDreamAt !== undefined
      ? new Date(state.lastDreamAt).toISOString().slice(0, 16).replace('T', ' ')
      : '从未整理';
    return [
      '[记忆整理] 这是你的睡眠期记忆整理（dream）。你的长期记忆时间线现有 ' + entries.length + ' 条（时间跨度 ' + span + '；tags：' + tagLine + '；上次整理：' + last + '）。',
      '整理目标：让时间线在有限的注入预算下更好用——近期与高价值的完整，陈旧的沉降，重复的合并，错误的更正。',
      '',
      '可用手段：memory_grep（pattern 正则 / since·until 时间 / tag / peer；不传参数看最近 50 条）、memory_write（追加新条目）、memory_forget（移入遗忘归档，可恢复，reason 记原因）。',
      '',
      '建议按此优先级处理（做多少由你判断，拿不准就保留）：',
      '1. 纠错：与当前已知事实矛盾、或已被后来条目推翻的结论——写一条更正条目，再 forget 旧条。',
      '2. 合并：同一主题散落的碎片——写一条完整自洽的合并条目，再逐条 forget 原件（reason 写「合并入 #新号」）。',
      '3. 沉降：一次性事实、已完成的待办、只对当时有意义的过程记录——forget（reason 写原因）。',
      '4. 精炼：反复有效的教训保留最精炼表述（注入预算有限，精炼即提升）。',
      '',
      '纪律：不要凭空新增知识（新条目必须来自对已有条目的归纳/更正）；本次控制在 20 条操作内，做不完留给下次；这是机制任务——不要发起对话、不要等待用户，结束后用一两句话汇报（纠错/合并/沉降/精炼各几条）。',
    ].join('\n');
  }
}
