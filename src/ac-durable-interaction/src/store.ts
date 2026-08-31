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

/** 共享状态机：按输入构造一条 pending 记录 */
function makeRecord(input: DurableInteractionInput): DurableInteraction {
  const now = Date.now();
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
}

export class JsonlDurableInteractionStore implements DurableInteractionStore {
  readonly name = 'jsonl';
  private records = new Map<string, DurableInteraction>();
  private readonly fsyncOnAppend: boolean;
  /** 持久化文件路径（诊断用） */
  readonly file: string;

  constructor(
    file: string,
    options: JsonlDurableInteractionStoreOptions = {},
  ) {
    this.file = file;
    this.fsyncOnAppend = options.fsync ?? true;
    this.reload();
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

  /** 重读文件（崩溃恢复：按行序折叠，last-write-wins） */
  private reload(): void {
    this.records.clear();
    if (!fs.existsSync(this.file)) return;

    const text = fs.readFileSync(this.file, 'utf-8');
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.trim() === '') continue;
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
