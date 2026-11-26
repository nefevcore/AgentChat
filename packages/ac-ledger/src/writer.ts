// ============================================================
// writer.ts —— 账本 writer（机制照搬 ac-session：按文件串行队列 /
// append + fsync / seq 单调分配）
//
// 差异：per-agent 目录（agents/<id>/sessions/<uuid>/）；requestId 准入
//（A2 落账即确认——admit 短路先于入队）；inbox durable（投递未消费
// 消息；activation 消费后清）。
//
// cr-974（cr-972 第二刀）事件词汇 v2：messages.jsonl 即会话唯一事件日志
//（头行 version:2；判别行 + 未知 type 安全忽略）——相位族 step/* +
// inject + run-end 逐行落账，终稿 = type:'message' 行。物化（materialize）
// 与 journal 剔除（prune）退役（journal/subcalls 停写，存量文件读兼容）。
// cr-998：v1 写面（journal()/settle 两阶段/settleMechanism 落 journal）
// 随回滚兼容窗退役——writer 恒 v2 形态（既有 v1 会话文件追加 v2 行合法，
// 头行永不重写）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { LedgerRow, LedgerHeader, RunUsage } from './records.ts';
import { AdmissionGate } from 'ac-envelope-core';
import { nextSegmentName, writeAnchor, type CompactOptions, type CompactReport } from './archive.ts';
import { readLedger } from './reader.ts';

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
const SUBCALLS = 'subcalls.jsonl';
const INBOX = 'inbox';


/** 尾行 seq 扫描（B1 行级 seq 持久化）：读文件末 ~32KB，取各行 seq 最大值。
 *  * 尾部窗口足够——续接只关心「已分配到的最大值」，而 append-only 下它
 *  * 恒在文件末尾（32KB 覆盖数百行；极端长行/大窗口 miss 时取到偏小值，
 *  * seq 仍单调不回退——只是留空洞，无害）。文件缺席/空 = 0。 */
function tailMaxSeq(file: string): number {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return 0; }
  if (size === 0) return 0;
  const CHUNK = 32 * 1024;
  const start = Math.max(0, size - CHUNK);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  let max = 0;
  for (const line of buf.toString('utf8').split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const seq = (JSON.parse(t) as { seq?: unknown }).seq;
      if (typeof seq === 'number' && seq > max) max = seq;
    } catch { /* 截断的首行（窗口切在行中间）跳过 */ }
  }
  return max;
}

/** 单 writer（一 run 一实例——activation 单写者语义 A5；cr-973 起 viewer
 * 投影账本退役，每目录恒单写者——cr-946 的 per-write 尾行对账形态随之退役） */
export class LedgerWriter {
  private queue: Array<() => void> = [];
  private draining = false;
  private nextSeq = 1;
  private seqSeeded = false;
  private headerWritten = false;
  private readonly admission: AdmissionGate;
  /** 落账后通知（cr-976 B 案）：每个 enqueue 切片内追加到 messages.jsonl 的
   *  行（含分配好的 seq）在 fsync 后回调——宿主直播管线据此投影转发
   *  （帧 = 日志 append 事件的视图，D3-2 壳 ipc 事件面的数据源）。 */
  private readonly onAppend?: (rows: Array<Record<string, unknown>>) => void;

  private readonly dir: string;
  private readonly header: Omit<LedgerHeader, 'type' | 'version' | 'createdAt'>;

  constructor(
    dir: string,
    header: Omit<LedgerHeader, 'type' | 'version' | 'createdAt'>,
    admission: AdmissionGate = new AdmissionGate(),
    opts: { onAppend?: (rows: Array<Record<string, unknown>>) => void } = {},
  ) {
    this.dir = dir;
    this.header = header;
    this.admission = admission;
    this.onAppend = opts.onAppend;
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

  /** messages.jsonl 首建时写头行（participants/kind 并进首行；version:2
   *  ——cr-974 单文件事件日志；既有文件头行永不重写——v1 会话续写
   *  保持 version:1，行级判别归一） */
  private ensureHeader(): void {
    if (this.headerWritten) return;
    const file = path.join(this.dir, MESSAGES);
    this.ensureFile(file);
    if (fs.statSync(file).size === 0) {
      const header: LedgerHeader = {
        type: 'session-header',
        version: 2,
        createdAt: new Date().toISOString(),
        participants: this.header.participants,
        kind: this.header.kind,
      };
      this.appendLine(file, header);
    }
    this.headerWritten = true;
  }

  private allocSeq(): number {
    // B1 行级 seq 持久化：首分配前扫三文件尾行取 max(seq) 续接——消灭
    // 「每实例从 1 重来」（此前 admin~admin 38 行 13 处回退边）。messages /
    // journal partials / subcalls 共用计数器，续接面同宽。此后同目录 seq
    // 跨 writer 实例单调不回退（成为稳定身份锚——B3 依赖）。
    if (!this.seqSeeded) {
      this.seqSeeded = true;
      const tail = Math.max(
        tailMaxSeq(path.join(this.dir, MESSAGES)),
        tailMaxSeq(path.join(this.dir, JOURNAL)),
        tailMaxSeq(path.join(this.dir, SUBCALLS)),
      ) + 1;
      // 只抬不降：本实例已分配但未落盘的行序不制造回退
      if (tail > this.nextSeq) this.nextSeq = tail;
    }
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
        // v2 判别行（cr-974）：发言 message / 材料 context；存量 v1 行无 type
        //（读侧按行判别归一——同文件混词汇合法）
        type: row.role === 'context' ? 'context' : 'message',
        message_id: key ?? cryptoRandomId(),
        timestamp: ts,
        seq: this.allocSeq(),
      };
      this.appendLine(path.join(this.dir, MESSAGES), full);
      this.onAppend?.([full as unknown as Record<string, unknown>]);
    });
    return true;
  }

  // —— v2 事件面（cr-974：相位/注入/收束判别行——单文件事件日志） ——

  /**
   * 相位/注入事件批落账（journalStep 展开 / 工具结果补行 / 注入行的共同
   * 落面）：逐行 allocSeq + append+fsync，同一串行队列切片内原子完成。
   * 返回末行 seq（B2 帧携带——ledger/step-journaled 的 durable 锚）。
   * 行体由调用方按 v2 词汇组装（step/* / inject / run-end）。
   */
  async appendEvents(lines: Array<Record<string, unknown>>): Promise<number> {
    return this.enqueue(() => {
      this.ensureHeader();
      let last = 0;
      const appended: Array<Record<string, unknown>> = [];
      for (const line of lines) {
        last = this.allocSeq();
        const full = { ...line, seq: last };
        this.appendLine(path.join(this.dir, MESSAGES), full);
        appended.push(full);
      }
      if (appended.length > 0) this.onAppend?.(appended);
      return last;
    });
  }

  /**
   * 压缩事件落账（cr-1160 P1：单事件形态——一行携带全部压缩语义：
   * boundarySeq（缺省 = 落账时刻主日志尾部 maxSeq，writer 内联计算）、
   * endTs（= ts，P2 双维边界时刻维）、summary（可空——P3 形态校验
   *  不合格时省略，本代无新概要）、stats/model（审计面）+ run-end。
   *  单队列切片原子追加（append+fsync 行级原子——取代旧三连两阶段。
   *  旧三连读侧归并兼容，存量零迁移）。物理回收是另一时机的 compact。
   */
  async compaction(runId: string, opts: { summary?: string; shadowedSeq?: number; stats?: { shadowedRows?: number; estimatedTokens?: number }; model?: string; origin?: string } = {}): Promise<number> {
    const boundary = opts.shadowedSeq ?? Math.max(tailMaxSeq(path.join(this.dir, MESSAGES)), 0);
    const ts = Date.now();
    return this.appendEvents([
      { type: 'compaction', run: runId, boundarySeq: boundary, ts, ...(opts.summary !== undefined ? { summary: opts.summary } : {}), ...(opts.stats !== undefined ? { stats: opts.stats } : {}), ...(opts.model !== undefined ? { model: opts.model } : {}), ...(opts.origin !== undefined ? { origin: opts.origin } : {}) },
      { type: 'run-end', run: runId, finish: 'completed', ts },
    ]);
  }

  /**
   * run 收束标记行（v2 run-end——落账即 durable，回放闸门锚；D-2）。
   * settlement 两阶段（物化 + journal 剔除）退役：步级事实已在事件流，
   * 本行是唯一收束信号。
   */
  async runEnd(
    runId: string,
    finish: 'completed' | 'interrupted' | 'error',
    meter?: { usage: RunUsage; model: string },
    errorMessage?: string,
    runMs?: number,
    origin?: string,
  ): Promise<void> {
    await this.appendEvents([{
      type: 'run-end',
      run: runId,
      finish,
      ...(meter !== undefined ? { usage: meter.usage, model: meter.model } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      ...(runMs !== undefined ? { runMs } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ts: Date.now(),
    }]);
  }

  // cr-697 物化两阶段（段行物化 + journal 剔除）与 cr-998 前的 v1 写面
  //（journal()/settleMechanism v1 分支）已随 cr-974/998 退役——journal
  // 停写，存量 v1 会话经 events-v2 归一化读。

  /**
   * run 收束（cr-974 v2）：终稿 message 行 +（error 时 context/error 行）
   * + run-end 标记行——单队列切片内原子追加；无物化、无 journal 写、无
   * prune（步级事实已在事件流，run-end 即唯一收束信号）。
   * meter（cr-538）：run 级用量聚合随 run-end 落账。
   */
  async settle(
    finalRow: Omit<LedgerRow, 'message_id' | 'timestamp' | 'seq'>,
    runId: string,
    finish: 'ok' | 'interrupted' | 'error',
    meter?: { usage: RunUsage; model: string },
    errorMessage?: string,
    origin?: string,
  ): Promise<void> {
    // v2 收束（cr-974）：终稿 message 行 +（error 时 context/error 行）+
    // run-end 标记行——单队列切片内原子追加；无物化、无 journal 写、无
    // prune（步级事实已在事件流，run-end 即唯一收束信号）
    // cr-1332：finalRow.delivered（settle 写面 origin 门控产物）经 spread
    // 落盘——白名单词汇透传单点。
    await this.enqueue(() => {
      this.ensureHeader();
      const appended: Array<Record<string, unknown>> = [];
      const finalLine = {
        type: 'message',
        ...finalRow,
        message_id: finalRow.requestId ?? cryptoRandomId(),
        timestamp: new Date().toISOString(),
        seq: this.allocSeq(),
      };
      this.appendLine(path.join(this.dir, MESSAGES), finalLine);
      appended.push(finalLine as unknown as Record<string, unknown>);
      // cr-807：error 收束错误行（context+source:error——UI 红条）；
      // cr-1332：终稿行带 delivered 标时同值随行（error 失败须可见——IM 白名单含红条）
      if (finish === 'error') {
        const errLine = {
          type: 'context',
          role: 'context',
          source: 'error',
          content: errorMessage ?? 'run 以 error 收束',
          agent_id: finalRow.agent_id,
          ...(finalRow.uuid !== undefined ? { uuid: finalRow.uuid } : {}),
          ...(finalRow.delivered !== undefined ? { delivered: finalRow.delivered } : {}),
          run: runId,
          message_id: cryptoRandomId(),
          timestamp: new Date().toISOString(),
          seq: this.allocSeq(),
        };
        this.appendLine(path.join(this.dir, MESSAGES), errLine);
        appended.push(errLine);
      }
      const endLine = {
        type: 'run-end',
        run: runId,
        finish: finish === 'ok' ? 'completed' : finish,
        ...(meter !== undefined ? { usage: meter.usage, model: meter.model } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        ...(finalRow.runMs !== undefined ? { runMs: finalRow.runMs } : {}),
        // run 成因持久锚（cr-1238 B5）：读侧消费面（计时锚/归档文案/回放）
        // 从行读 origin，不从直播管道反推
        ...(origin !== undefined ? { origin } : {}),
        ts: Date.now(),
        seq: this.allocSeq(),
      };
      this.appendLine(path.join(this.dir, MESSAGES), endLine);
      appended.push(endLine);
      this.onAppend?.(appended);
    });
  }

  // 孤儿 run 收口（cr-628 settleOrphan）已随 cr-974 退役：D-3 读方配平——
  // 未闭合 run 不回写，读侧（fold）合成 run-end(interrupted) 投影。

  /**
   * 机制 run 收束（归档整理等——settle 机制变体，cr-974 v2）。cr-1189 V3
   * 退役标记：整理轮改普通 run 语义（终稿照常落账）后本面无生产消费方——
   * 保留为存量读兼容薄壳（恢复面收口等残余调用形态），不再新增调用。
   */
  async settleMechanism(runId: string, finish: 'ok' | 'interrupted' | 'error'): Promise<void> {
    await this.runEnd(runId, finish === 'ok' ? 'completed' : finish);
  }

  // —— 归档重写（D11：archive 行编排调用——物理面归账本 writer） ——

  /**
   * 归档重写：分段落盘（archive/history_N.jsonl〔.gz〕+ 尾锚）→ messages.jsonl
   * tmp+rename 原子重写（头行保留）→ 概要滚动（undefined = 不动；v2 模式
   * 恒不写 summary.md——摘要已是事件，见 compaction()）。
   * B1 窗口基线（主线 cr-315 语义）：快照 T0 之后新落账的行（seq >
   * baselineSeq）重读并入 keep 尾部——整理 run 分钟级窗口内新到消息不丢
   * （压缩事件行经此通道自然保留在主日志——audit 面永在）。
   * cr-974：compress = 归档段整段单流 gzip（.gz——S5 白名单时机的物理
   * 回收；Node 24.18 无 zlib.zstdSync，zstd 落空时回落 gzip 并如实命名）。
   */
  async compact(opts: CompactOptions & { compress?: boolean }): Promise<CompactReport> {
    return this.enqueue(() => {
      let keep = opts.keep as Array<{ seq?: number } | unknown>;
      if (opts.baselineSeq !== undefined) {
        // cr-1234：late-merge 去重——keep 基准从快照 rows 换成事件后重读行面后，
        // 事件行/新行已含在 keep 内；seq 单调假设在物理重写后失效（writer 从三
        // 文件种子重编号，事件行 seq 可能 ≤ baselineSeq 又已在 keep），再并入即
        // 同行双写（现场：compaction#10 出现两遍）。以 seq+type+run 复合指纹去重。
        const seen = new Set(keep.map((r) => {
          const ro = r as { seq?: number; type?: unknown; run?: unknown };
          return ro.seq !== undefined ? ro.seq + '|' + String(ro.type) + '|' + String(ro.run) : JSON.stringify(ro);
        }));
        const late = readLedger(this.dir).rows.filter((r) => {
          if ((r.seq ?? 0) <= opts.baselineSeq!) return false;
          const ro = r as { seq?: number; type?: unknown; run?: unknown };
          const key = ro.seq !== undefined ? ro.seq + '|' + String(ro.type) + '|' + String(ro.run) : JSON.stringify(ro);
          return !seen.has(key);
        });
        if (late.length > 0) keep = [...keep, ...late];
      }
      let segment: string | undefined;
      if (opts.archive.length > 0) {
        fs.mkdirSync(path.join(this.dir, 'archive'), { recursive: true });
        segment = nextSegmentName(this.dir, opts.compress === true);
        const body = opts.archive.map((r) => JSON.stringify(r)).join('\n') + '\n';
        fs.writeFileSync(
          path.join(this.dir, 'archive', segment),
          opts.compress === true ? zlib.gzipSync(body) : body,
          opts.compress === true ? undefined : 'utf-8',
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
      // cr-1245 B3 同构对拍（物理重写等价断言——fail-loud）：读回行集必须
      // 与写入 keep 恒等（rename 原子性 + 行序列化无损）；任何缺行 = 重写
      // 丢事实，宁可炸也不静默（cr-1156/1234 的写侧防线）。
      const reread = readLedger(this.dir).rows;
      if (reread.length !== keep.length) {
        throw new Error('compact 同构对拍失败：读回 ' + reread.length + ' 行 ≠ 写入 keep ' + keep.length + ' 行（' + this.dir + '）');
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
