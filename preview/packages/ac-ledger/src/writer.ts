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
import { readLedger, readJournal } from './reader.ts';

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
   * 不重复写行）。返回 true = 新落账；false = 幂等命中。
   */
  async deliver(row: Omit<LedgerRow, 'message_id' | 'timestamp' | 'seq'>): Promise<boolean> {
    const key = row.requestId;
    if (key !== undefined && !this.admission.admit(key)) return false;
    await this.enqueue(() => {
      this.ensureHeader();
      const full: LedgerRow = {
        ...row,
        message_id: key ?? cryptoRandomId(),
        timestamp: new Date().toISOString(),
        seq: this.allocSeq(),
      };
      this.appendLine(path.join(this.dir, MESSAGES), full);
    });
    return true;
  }

  // —— journal 面（run 周期台账） ——

  async journal(line: JournalStep | JournalInject | JournalToolResult | Omit<JournalSettled, 'seq'>): Promise<void> {
    await this.enqueue(() => {
      const full = { ...line, seq: this.allocSeq() } as JournalLine;
      this.appendLine(path.join(this.dir, JOURNAL), full);
    });
  }

  // —— settlement 两阶段（run 收束：journal 提升 + 切段物化） ——

  // cr-640/653 段行物化已退役（cr-658 轨迹完整性读侧重建取代——
  // historyMessagesFor 从 journal 重建协议级消息对，上下文不再依赖写侧
  // 文本降维；「run 做过的推理是会话事实」裁决由读面承接）。

  /**
   * run 收束：终稿行 append 到 messages.jsonl + journal-settled 标记。
   * 部分行吸收 = 读侧投影（journal-settled 后部分行失效——与现状同构）。
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
    });
  }

  // 孤儿 run 收口（cr-628）归 settleMechanism 同语义：journal-settled(interrupted)
  // 落账、messages 不落行（viewer 锚归 cr-631/632 补投面；上下文轨迹归
  // historyMessagesFor 读侧重建——cr-640 物化退役后无孤儿特有写行为）。

  /**
   * 机制 run 收束（归档整理等——settle 机制变体）：journal-settled 落账，
   * messages.jsonl 不落行（机制 run 与会话增长无关——主线 ARCHIVE_REVIEW
   * 三不语义的账本侧）。finish/interrupted 照常——整理行收尾的完成态事实
   * 仍在 journal（审计面）。
   */
  async settleMechanism(runId: string, finish: 'ok' | 'interrupted' | 'error'): Promise<void> {
    await this.enqueue(() => {
      this.appendLine(path.join(this.dir, JOURNAL), {
        type: 'journal-settled', run: runId, finish,
        seq: this.allocSeq(),
      });
    });
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

import * as crypto from 'node:crypto';
