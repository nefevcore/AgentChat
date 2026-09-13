// ============================================================
// ac-durable-interaction/src/store.ts —— 内存 / JSONL 后端（src 原样平移）
//
// 两条实现共享同一状态机与幂等语义：
//   · MemoryDurableInteractionStore：测试、嵌入式单进程
//   · JsonlDurableInteractionStore：append-only JSONL，每次变更
//     追加完整记录行；加载时按行序折叠（last-write-wins），
//     忽略物理 torn tail（最后一行不完整），保证崩溃恢复。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DurableInteractionConflictError,
  DurableInteractionCorruptionError,
  cloneJson,
  makeInteractionId,
  matchesFilter,
  type DurableInteraction,
  type DurableInteractionFilter,
  type DurableInteractionInput,
  type DurableInteractionStore,
  type JsonValue,
  type ReplyOutcome,
} from './types.ts';

/** 单调时钟：同毫秒连续 open 也保持 createdAt 严格递增——created_at
 *  语义 = 发生顺序（store 升序列出 / 前端「最新优先」路由都依赖它区分
 *  同步快速发出的多条交互；Date.now() 毫秒精度在单 step 双 ask_questions
 *  场景下会撞值，排序退化为插入序）。 */
let lastStamp = 0;
function nextStamp(): number {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

/** 共享状态机：按输入构造一条 pending 记录 */
function makeRecord(input: DurableInteractionInput): DurableInteraction {
  const now = nextStamp();
  return {
    id: input.id ?? makeInteractionId(),
    key: input.key,
    kind: input.kind,
    payload: cloneJson(input.payload, 'payload'),
    state: 'pending',
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** 共享状态机：对某条记录执行 reply 语义（纯函数，不持久化） */
function applyReply(record: DurableInteraction, answer: JsonValue): ReplyOutcome {
  if (record.state === 'closed') {
    return { status: 'closed', interaction: record };
  }
  if (record.state === 'answered') {
    return { status: 'duplicate', interaction: record, answer: record.answer };
  }
  const next: DurableInteraction = {
    ...record,
    state: 'answered',
    answer: cloneJson(answer, 'answer'),
    updatedAt: Date.now(),
  };
  return { status: 'ok', interaction: next };
}

/** 共享状态机：对某条记录执行 close 语义（纯函数，不持久化） */
function applyClose(record: DurableInteraction, reason?: string): DurableInteraction | undefined {
  if (record.state === 'closed') return undefined;
  return {
    ...record,
    state: 'closed',
    closedReason: reason,
    updatedAt: Date.now(),
  };
}

// ============================================================
// 内存后端
// ============================================================

export class MemoryDurableInteractionStore implements DurableInteractionStore {
  readonly name = 'memory';
  private records = new Map<string, DurableInteraction>();

  open(input: DurableInteractionInput): DurableInteraction {
    const record = makeRecord(input);
    if (this.records.has(record.id)) throw new DurableInteractionConflictError(record.id);
    this.records.set(record.id, record);
    return { ...record, payload: cloneJson(record.payload, 'payload') };
  }

  reply(id: string, answer: JsonValue): ReplyOutcome {
    const current = this.records.get(id);
    if (!current) return { status: 'not-found' };
    const outcome = applyReply(current, answer);
    if (outcome.status === 'ok' && outcome.interaction) {
      this.records.set(id, outcome.interaction);
    }
    return outcome;
  }

  close(id: string, reason?: string): boolean {
    const current = this.records.get(id);
    if (!current) return false;
    const next = applyClose(current, reason);
    if (!next) return false;
    this.records.set(id, next);
    return true;
  }

  get(id: string): DurableInteraction | undefined {
    const record = this.records.get(id);
    return record ? { ...record, payload: cloneJson(record.payload, 'payload') } : undefined;
  }

  list(filter?: DurableInteractionFilter): DurableInteraction[] {
    return [...this.records.values()]
      .filter((record) => matchesFilter(record, filter))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  listOpen(filter?: DurableInteractionFilter): DurableInteraction[] {
    return this.list({ ...filter, state: 'pending' });
  }

  clear(): number {
    const count = this.records.size;
    this.records.clear();
    return count;
  }

  dispose(): void {
    this.records.clear();
  }
}

// ============================================================
// JSONL 后端
// ============================================================

export interface JsonlDurableInteractionStoreOptions {
  /** 每次 append 后 fsync；缺省 true（崩溃安全的等待语义） */
  fsync?: boolean;
  /**
   * 终态记录保留期（毫秒）。sweep 时删除 updatedAt 早于 now - retentionMs
   * 的 answered/closed 记录（pending 永不清理——write-ahead 恢复源）。
   * 缺省不清理（纯 append-only，历史全留）。
   */
  retentionMs?: number;
}

export class JsonlDurableInteractionStore implements DurableInteractionStore {
  readonly name = 'jsonl';
  private records = new Map<string, DurableInteraction>();
  private readonly fsyncOnAppend: boolean;
  private readonly retentionMs?: number;
  /** reload 时盘上非空物理行数（sweep 判断文件是否需要折叠重写） */
  private physicalLines = 0;
  /** 持久化文件路径（诊断用） */
  readonly file: string;

  constructor(
    file: string,
    options: JsonlDurableInteractionStoreOptions = {},
  ) {
    this.file = file;
    this.fsyncOnAppend = options.fsync ?? true;
    this.retentionMs = options.retentionMs;
    this.reload();
    this.sweep();
  }

  open(input: DurableInteractionInput): DurableInteraction {
    const record = makeRecord(input);
    if (this.records.has(record.id)) throw new DurableInteractionConflictError(record.id);
    this.append(record);
    this.records.set(record.id, record);
    return { ...record, payload: cloneJson(record.payload, 'payload') };
  }

  reply(id: string, answer: JsonValue): ReplyOutcome {
    const current = this.records.get(id);
    if (!current) return { status: 'not-found' };
    const outcome = applyReply(current, answer);
    if (outcome.status === 'ok' && outcome.interaction) {
      this.append(outcome.interaction);
      this.records.set(id, outcome.interaction);
    }
    return outcome;
  }

  close(id: string, reason?: string): boolean {
    const current = this.records.get(id);
    if (!current) return false;
    const next = applyClose(current, reason);
    if (!next) return false;
    this.append(next);
    this.records.set(id, next);
    return true;
  }

  get(id: string): DurableInteraction | undefined {
    const record = this.records.get(id);
    return record ? { ...record, payload: cloneJson(record.payload, 'payload') } : undefined;
  }

  list(filter?: DurableInteractionFilter): DurableInteraction[] {
    return [...this.records.values()]
      .filter((record) => matchesFilter(record, filter))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  listOpen(filter?: DurableInteractionFilter): DurableInteraction[] {
    return this.list({ ...filter, state: 'pending' });
  }

  clear(): number {
    const count = this.records.size;
    this.records.clear();
    try {
      if (fs.existsSync(this.file)) fs.rmSync(this.file);
    } catch {
      // 文件可能被外部持有；内存投影已清空
    }
    return count;
  }

  dispose(): void {
    this.records.clear();
  }

  /**
   * 清理过期终态记录并折叠文件。保留：
   *   · 全部 pending（write-ahead 恢复源，永不清理）
   *   · 保留期内（updatedAt > now - retentionMs）的终态记录
   *   · retentionMs 未配置 = 只折叠不去重（多代行合并，仍全量保留）
   * 重写采用 rename 原子替换（Windows 兼容：先删旧名再 rename）。
   * 返回被清理的记录数；文件不存在或无需变化时为 0。
   */
  sweep(now = Date.now()): number {
    if (!fs.existsSync(this.file)) return 0;
    const cutoff = this.retentionMs === undefined ? -Infinity : now - this.retentionMs;
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.state !== 'pending' && record.updatedAt <= cutoff) {
        this.records.delete(id);
        removed++;
      }
    }
    // 干净文件（无删除且每 id 恰一行）跳过重写——启动路径只读不写
    if (removed > 0 || this.physicalLines !== this.records.size) {
      this.compact();
      this.physicalLines = this.records.size;
    }
    return removed;
  }

  /**
   * 把当前内存投影（每 id 一行）原子重写回文件。
   * 无写入则不触碰文件（防构造时把 torn-tail-only 文件误建出来）。
   */
  private compact(): void {
    if (this.records.size === 0 && !fs.existsSync(this.file)) return;
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.compact-${process.pid}`;
    const text = [...this.records.values()]
      .map((record) => JSON.stringify(record))
      .join('\n');
    const lines = this.records.size === 0 ? '' : `${text}\n`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, lines);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      // Windows：旧文件被外部短暂持有（读侧）——rename 会失败，保留
      // 原文件走 append 老路（折叠效果推迟到下次 sweep，无损）
    }
    try {
      fs.renameSync(tmp, this.file);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // 清理残片失败只留孤儿 tmp，无碍
      }
    }
  }

  /** 重读文件（崩溃恢复：按行序折叠，last-write-wins） */
  private reload(): void {
    this.records.clear();
    this.physicalLines = 0;
    if (!fs.existsSync(this.file)) return;

    const text = fs.readFileSync(this.file, 'utf-8');
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.trim() === '') continue;
      this.physicalLines++;
      let record: DurableInteraction;
      try {
        record = JSON.parse(line) as DurableInteraction;
      } catch {
        // torn tail（最后一行未写完整）：忽略，不影响已提交前缀
        continue;
      }
      this.validate(record);
      const previous = this.records.get(record.id);
      if (previous && previous.updatedAt > record.updatedAt) {
        // append-only 顺序异常：保留较新的投影
        continue;
      }
      this.records.set(record.id, record);
    }
  }

  private append(record: DurableInteraction): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, line, null, 'utf-8');
      if (this.fsyncOnAppend) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.physicalLines++;
  }

  private validate(record: DurableInteraction): void {
    if (typeof record?.id !== 'string' || record.id.length === 0) {
      throw new DurableInteractionCorruptionError(`durable-interaction 文件包含非法记录 id: ${this.file}`);
    }
    if (record.state !== 'pending' && record.state !== 'answered' && record.state !== 'closed') {
      throw new DurableInteractionCorruptionError(`durable-interaction 文件包含非法状态: ${String(record.state)}`);
    }
  }
}
