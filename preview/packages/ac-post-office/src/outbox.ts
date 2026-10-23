// ============================================================
// outbox.ts —— 发件箱滞留中继（B1 三通道之三）
//
// 对端不可达 → outbox/ 落盘（durable，at-least-once）；通道恢复
//（端点转可达）→ 转投。重投语义 = 同 requestId 信封重发（接收方
// 幂等去重 cr-250）。文件名 = <seq>-<requestId>.json（seq 保序）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Envelope } from 'ac-envelope-core';

export interface OutboxEntry {
  /** 落箱序（文件名前缀——FIFO 转投序） */
  seq: number;
  envelope: Envelope;
  /** 滞留原因（unreachable / no-hint） */
  reason: string;
  storedAt: string;
}

/** 单数据根发件箱（宿主邮局持有——写者唯一） */
export class Outbox {
  private readonly dir: string;
  private nextSeq: number;

  constructor(dataRoot: string) {
    this.dir = path.join(dataRoot, 'outbox');
    this.nextSeq = this.scanMaxSeq() + 1;
  }

  private scanMaxSeq(): number {
    try {
      const names = fs.readdirSync(this.dir);
      let max = 0;
      for (const n of names) {
        const dash = n.indexOf('-');
        if (dash <= 0) continue;
        const seq = Number.parseInt(n.slice(0, dash), 10);
        if (Number.isInteger(seq) && seq > max) max = seq;
      }
      return max;
    } catch {
      return 0;
    }
  }

  /** 滞留落盘（原子写 tmp+rename） */
  store(envelope: Envelope, reason: string): OutboxEntry {
    const entry: OutboxEntry = {
      seq: this.nextSeq++,
      envelope,
      reason,
      storedAt: new Date().toISOString(),
    };
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, entry.seq + '-' + envelope.requestId + '.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
    fs.renameSync(tmp, file);
    return entry;
  }

  /** 全量滞留清单（FIFO——seq 升序） */
  list(): OutboxEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const entries: OutboxEntry[] = [];
    for (const n of names.sort()) {
      if (!n.endsWith('.json')) continue;
      try {
        entries.push(JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf-8')) as OutboxEntry);
      } catch {
        // 撕裂行跳过（rename 原子性下不应出现）
      }
    }
    return entries;
  }

  /** 出箱（转投成功后调用——幂等：缺席即无操作） */
  remove(seq: number, requestId: string): void {
    try {
      fs.rmSync(path.join(this.dir, seq + '-' + requestId + '.json'), { force: true });
    } catch {
      // 缺席即无操作
    }
  }

/**
 * 转投扫描（通道恢复节拍调用）：hintFor 命中的条目产出直投指令并
 * 标记待出箱；投递成功由调用方 remove（at-least-once——失败留箱重试）。
 */
  flush(
    hintFor: (endpointId: string) => string | undefined,
  ): Array<{ entry: OutboxEntry; transportHint: string }> {
    const out: Array<{ entry: OutboxEntry; transportHint: string }> = [];
    for (const entry of this.list()) {
      const hint = hintFor(entry.envelope.to);
      if (hint !== undefined) out.push({ entry, transportHint: hint });
    }
    return out;
  }
}
