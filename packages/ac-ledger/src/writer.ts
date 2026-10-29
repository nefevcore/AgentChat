// ============================================================
// writer.ts —— 账本 writer（机制照搬 ac-session：按文件串行队列 /
// append + fsync / seq 单调分配 / settlement 两阶段物化）
//
// 差异：per-agent 目录（agents/<id>/sessions/<uuid>/）；requestId 准入
//（A2 落账即确认——admit 短路先于入队）；inbox durable（投递未消费
// 消息；activation 消费后清）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LedgerRow, LedgerHeader, JournalLine, JournalStep, JournalInject, JournalToolResult, JournalSettled, RunUsage } from './records.ts';
import { AdmissionGate } from 'ac-envelope-core';
import { nextSegmentName, writeAnchor, type CompactOptions, type CompactReport } from './archive.ts';
import { readLedger, readJournal, segmentizeRun } from './reader.ts';

/** 会话目录：agents/<agentId>/sessions/<uuid>/ */
export function sessionDir(dataRoot: string, agentId: string, uuid: string): string {
  for (const part of [agentId, uuid]) {
    if (part.length === 0 || /[/\\]/.test(part) || part === '.' || part === '..') {
      throw new Error('会话路径组件非法：' + part);
    }
  }
  return path.join(dataRoot, 'agents', agentId, 'sessions', uuid);
}

const MESSAGES = 'messages.jsonl';
const JOURNAL = path.join('journal', 'partials.jsonl');
const INBOX = 'inbox';


/** 单 writer（一 run 一实例——activation 单写者语义 A5） */
export class LedgerWriter {
  private queue: Array<() => void> = [];
  private draining = false;
  private nextSeq = 1;
  private headerWritten = false;
  private readonly admission: AdmissionGate;

  private readonly dir: string;
  private readonly header: Omit<LedgerHeader, 'type' | 'version' | 'createdAt'>;

  constructor(
    dir: string,
    header: Omit<LedgerHeader, 'type' | 'version' | 'createdAt'>,
    admission: AdmissionGate = new AdmissionGate(),
  ) {
    this.dir = dir;
    this.header = header;
    this.admission = admission;
  }

  /** 串行队列（按文件互斥——同 writer 实例内写序恒定） */
  private enqueue<T>(job: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        try {
          resolve(job());
        } catch (err) {
          reject(err);
        }
      });
      if (!this.draining) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.draining = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (job === undefined) break;
      job();
      // 串行但不同步等待 microtask——job 内已同步完成 IO
    }
    this.draining = false;
  }

  /** 首写建目录 + 头行 */
  private ensureFile(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      const fd = fs.openSync(file, 'a');
      fs.closeSync(fd);
    }
  }

  private appendLine(file: string, line: unknown): void {
    this.ensureFile(file);
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(line) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** messages.jsonl 首建时写头行（participants/kind 并进首行） */
  private ensureHeader(): void {
    if (this.headerWritten) return;
    const file = path.join(this.dir, MESSAGES);
    this.ensureFile(file);
    if (fs.statSync(file).size === 0) {
      const header: LedgerHeader = {
        type: 'session-header',
        version: 1,
        createdAt: new Date().toISOString(),
        participants: this.header.participants,
        kind: this.header.kind,
      };
      this.appendLine(file, header);
    }
    this.headerWritten = true;
  }

  private allocSeq(): number {
    return this.nextSeq++;
  }

  // —— 落账面（A2：delivered 即 ack） ——

  /**
   * 落账入站消息（requestId 幂等准入先行——同键重发短路 deduped，
   * 不重复写行）。timestamp 可显式携带（cr-698 viewer 派生行保各自账本
   * 原时间戳——派生时刻 ≠ 发言时刻）；缺省 = 落行时刻。
   * 返回 true = 新落账；false = 幂等命中。
   */
  async deliver(row: Omit<LedgerRow, 'message_id' | 'timestamp' | 'seq'> & { timestamp?: string }): Promise<boolean> {
    const key = row.requestId;
    if (key !== undefined && !this.admission.admit(key)) return false;
    const ts = row.timestamp ?? new Date().toISOString();
    const { timestamp: _ts, ...rest } = row;
    void _ts;
    await this.enqueue(() => {
      this.ensureHeader();
      const full: LedgerRow = {
        ...rest,
        message_id: key ?? cryptoRandomId(),
        timestamp: ts,
        seq: this.allocSeq(),
      };
      this.appendLine(path.join(this.dir, MESSAGES), full);
    });
    return true;
  }

  // —— journal 面（run 周期台账） ——

  async journal(line: JournalStep | JournalInject | JournalToolResult | Omit<JournalSettled, 'seq'>): Promise<void> {
    await this.enqueue(() => {
      // ts 盖戳（cr-697）：物化段行/步级时间戳的取源——写入时不可逆，缺席
      // 即永久缺席（存量行读侧回落收束时刻）。调用方已带 ts（注入行——
      // cr-707：与直播帧同一时刻，排序同源）时保留。
      const full = { ...line, ts: (line as { ts?: number }).ts ?? Date.now(), seq: this.allocSeq() } as JournalLine;
      this.appendLine(path.join(this.dir, JOURNAL), full);
    });
  }

  // —— settlement 两阶段（run 收束：段行物化 + journal 剔除） ——

  // cr-697：恢复主线两阶段语义（推翻 cr-658 的「journal 永源 + 读侧重建」
  // 裁决——935 行/4MB 的 journal 永不清理致全仓 267MB 膨胀）。收束时把
  // journal 步行按注入边界切段物化进 messages.jsonl（source='segment'/
  // 'inject' 行；steps = 补行覆盖 + 子调用平铺后的步序），随 journal 剔除
  // 该 run 步行（settled 行保留——usage 计量与终态审计面）。读面（steps
  // 带出 / 轨迹重建）物化行优先、journal 兜底存量与 in-flight。

  /**
   * run 收束：段行物化（注入边界切段）→ 终稿行 → journal-settled 标记
   * → journal 步行剔除（收束即清——settled 行保留）。
   * meter（cr-538）：run 级用量聚合随 settlement 落账——journal 计量（R2）。
   */
  async settle(
    finalRow: Omit<LedgerRow, 'message_id' | 'timestamp' | 'seq'>,
    runId: string,
    finish: 'ok' | 'interrupted' | 'error',
    meter?: { usage: RunUsage; model: string },
  ): Promise<void> {
    await this.enqueue(() => {
      this.ensureHeader();
      this.materialize(runId, finalRow.agent_id, finalRow.uuid);
      const full: LedgerRow = {
        ...finalRow,
        message_id: finalRow.requestId ?? cryptoRandomId(),
        timestamp: new Date().toISOString(),
        seq: this.allocSeq(),
      };
      this.appendLine(path.join(this.dir, MESSAGES), full);
      this.appendLine(path.join(this.dir, JOURNAL), {
        type: 'journal-settled', run: runId, finish,
        ...(meter !== undefined ? { usage: meter.usage, model: meter.model } : {}),
        seq: this.allocSeq(),
      });
      this.pruneJournal(runId);
    });
  }

  // 孤儿 run 收口（cr-628）归 settleOrphan：物化段行（无终稿行——壳死于
  // postReply 前，步级工作是会话事实）+ journal-settled(interrupted) + 剔除。
  // viewer 侧不再补锚（cr-698 锚信通道退役——空终稿 run 不落 viewer 行，
  // 前端由 session/history 读面的 steps 盲区投影渲染）。

  /**
   * 机制 run 收束（归档整理等——settle 机制变体）：journal-settled 落账 +
   * 步行剔除，messages.jsonl 不落行（机制 run 与会话增长无关——主线
   * ARCHIVE_REVIEW 三不语义的账本侧）。finish 照常——完成态事实仍在
   * journal（审计面）。
   */
  async settleMechanism(runId: string, finish: 'ok' | 'interrupted' | 'error'): Promise<void> {
    await this.enqueue(() => {
      this.appendLine(path.join(this.dir, JOURNAL), {
        type: 'journal-settled', run: runId, finish,
        seq: this.allocSeq(),
      });
      this.pruneJournal(runId);
    });
  }

  /**
   * 孤儿 run 收束（boot 期 recoverOrphanRuns 消费）：settle 的无终稿变体
   * ——段行物化 + journal-settled(interrupted) + 步行剔除。终稿行缺席是
   * 如实态（壳死于收束回信前）；步级轨迹经物化段行保持上下文/前端可见。
   */
  async settleOrphan(runId: string, finish: 'interrupted' | 'error', agentId: string, uuid?: string): Promise<void> {
    await this.enqueue(() => {
      this.ensureHeader();
      this.materialize(runId, agentId, uuid);
      this.appendLine(path.join(this.dir, JOURNAL), {
        type: 'journal-settled', run: runId, finish,
        seq: this.allocSeq(),
      });
      this.pruneJournal(runId);
    });
  }

  /** journal → 段行/注入行物化（settle/settleOrphan 共用；journal 内调用——
   *  串行队列内读该 run 全量行，切段落账。时间戳 = 步行落行 ts；存量行
   *  缺席回落物化时刻） */
  private materialize(runId: string, agentId: string, uuid?: string): void {
    const segments = segmentizeRun(readJournal(this.dir), runId);
    let i = 0;
    for (const seg of segments) {
      const isInject = seg.kind === 'inj';
      const lastTs = isInject ? seg.ts : lastStepTs(seg.steps);
      this.appendLine(path.join(this.dir, MESSAGES), {
        role: 'agent',
        content: isInject ? seg.content : '',
        agent_id: agentId,
        ...(uuid !== undefined ? { uuid } : {}),
        run: runId,
        source: isInject ? 'inject' : 'segment',
        // 注入行身份（cr-707）：message_id = injectionId——直播行与刷新行同锚
        //（前端 mergeHistoryPage 双键去重直接命中）；来源/文案随行携带
        ...(isInject && seg.injectSource !== undefined ? { injectSource: seg.injectSource } : {}),
        ...(isInject && seg.label !== undefined ? { label: seg.label } : {}),
        // 注入行信封关联（cr-713）：busy-steer 消息无入站行——本行即其账本
        // 记录，requestId 随行带出（重放判重 / 读侧与入站行同键归口）
        ...(isInject && seg.requestId !== undefined ? { requestId: seg.requestId } : {}),
        ...(isInject ? {} : { steps: seg.steps }),
        message_id: isInject
          ? (seg.injectionId ?? 'inj-' + runId + '-' + i++)
          : 'seg-' + runId + '-' + i++,
        timestamp: lastTs !== undefined ? new Date(lastTs).toISOString() : new Date().toISOString(),
        seq: this.allocSeq(),
      } satisfies LedgerRow);
    }
  }

  /** journal 步行剔除（收束即清）：该 run 的 step/inject/tool-result 行
   *  物化已完成，journal 只留 settled 行（usage 计量 + 终态审计）与其他
   *  in-flight run 的行。tmp+rename 原子重写。 */
  private pruneJournal(runId: string): void {
    const file = path.join(this.dir, JOURNAL);
    const lines = readJournal(this.dir);
    const keep = lines.filter((l) => !(l.run === runId && l.type !== 'journal-settled'));
    if (keep.length === lines.length) return;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, keep.map((l) => JSON.stringify(l)).join('\n') + (keep.length > 0 ? '\n' : ''), 'utf-8');
    fs.renameSync(tmp, file);
  }

  // —— 归档重写（D11：archive 行编排调用——物理面归账本 writer） ——

  /**
   * 归档重写：分段落盘（archive/history_N.jsonl + 尾锚）→ messages.jsonl
   * tmp+rename 原子重写（头行保留）→ 概要滚动（undefined = 不动）。
   * B1 窗口基线（主线 cr-315 语义）：快照 T0 之后新落账的行（seq >
   * baselineSeq）重读并入 keep 尾部——整理 run 分钟级窗口内新到消息不丢。
   */
  async compact(opts: CompactOptions): Promise<CompactReport> {
    return this.enqueue(() => {
      let keep = opts.keep as Array<{ seq?: number } | unknown>;
      if (opts.baselineSeq !== undefined) {
        const late = readLedger(this.dir).rows.filter((r) => (r.seq ?? 0) > opts.baselineSeq!);
        if (late.length > 0) keep = [...keep, ...late];
      }
      let segment: string | undefined;
      if (opts.archive.length > 0) {
        fs.mkdirSync(path.join(this.dir, 'archive'), { recursive: true });
        segment = nextSegmentName(this.dir);
        fs.writeFileSync(
          path.join(this.dir, 'archive', segment),
          opts.archive.map((r) => JSON.stringify(r)).join('\n') + '\n',
          'utf-8',
        );
        const last = opts.archive[opts.archive.length - 1] as { uuid?: string; seq?: number; message_id?: string };
        writeAnchor(this.dir, {
          conversationId: last.uuid ?? '',
          ...(typeof last.seq === 'number' ? { seq: last.seq } : {}),
          ...(last.message_id !== undefined ? { messageId: last.message_id } : {}),
        });
      }
      const header = readLedger(this.dir).header;
      const file = path.join(this.dir, MESSAGES);
      const tmp = file + '.tmp';
      const lines: string[] = [];
      if (header !== null) lines.push(JSON.stringify(header));
      for (const r of keep) lines.push(JSON.stringify(r));
      fs.writeFileSync(tmp, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf-8');
      fs.renameSync(tmp, file);
      if (opts.summary !== undefined) {
        fs.writeFileSync(path.join(this.dir, 'summary.md'), opts.summary, 'utf-8');
      }
      return { archived: opts.archive.length, kept: keep.length, ...(segment !== undefined ? { segment } : {}) };
    });
  }

  // —— inbox durable（投递未消费；activation 消费后清） ——

  async inboxStore(envelope: { requestId: string; payload: unknown }): Promise<void> {
    await this.enqueue(() => {
      const dir = path.join(this.dir, INBOX);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, envelope.requestId + '.json');
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(envelope), 'utf-8');
      fs.renameSync(tmp, file);
    });
  }

  inboxList(): Array<{ requestId: string }> {
    const dir = path.join(this.dir, INBOX);
    try {
      return fs.readdirSync(dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => ({ requestId: n.slice(0, -5) }));
    } catch {
      return [];
    }
  }

  inboxClear(requestId: string): void {
    try {
      fs.rmSync(path.join(this.dir, INBOX, requestId + '.json'), { force: true });
    } catch {
      // 缺席即无操作
    }
  }
}

function cryptoRandomId(): string {
  return crypto.randomUUID();
}

/** 段内最后步级 ts（物化段行时间戳取源；全缺席 = undefined → 回落物化时刻） */
function lastStepTs(steps: Array<{ ts?: number }>): number | undefined {
  let out: number | undefined;
  for (const s of steps) if (s.ts !== undefined) out = s.ts;
  return out;
}

import * as crypto from 'node:crypto';
