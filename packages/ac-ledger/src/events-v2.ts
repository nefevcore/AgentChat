// ============================================================
// events-v2.ts —— 事件词汇 v2 壳（cr-1245 B1：纯核迁 ac-ledger-core
// events-core.ts，本文件保留 fs 读面 + 全量 re-export——出口面不变，
// 既有依赖方零改动）。
// ============================================================
export {
  domainFactsOf, compactionBoundaryOf,
  type RunFinish, type SpeechEvent, type ContextEvent, type PhaseEvent, type StepMeter,
  type InjectEvent, type RunEndEvent, type CompactionEvent, type SessionEvent,
  type RunFactsV2, type CompactionFacts, type DomainFacts,
} from 'ac-ledger-core/src/events-core.ts';
import type { DomainFacts } from 'ac-ledger-core/src/events-core.ts';
import { domainFactsOf } from 'ac-ledger-core/src/events-core.ts';
import * as path from 'node:path';
import { conversationDirs } from './manage.ts';
import { readLedger, readJournal, readSubcalls } from './reader.ts';

/**
 * 单域归一化 fs 壳（messages + journal + subcalls 三源 → DomainFacts）。
 * v2 单文件：journal/subcalls 缺席为常态；v1 会话三源并存。归一化本体
 * 在 ac-ledger-core domainFactsOf（纯）。
 */
export function readDomainFacts(dir: string, domain: string): DomainFacts {
  const { header, rows } = readLedger(dir);
  return domainFactsOf(domain, header?.version ?? 1, rows, readJournal(dir), readSubcalls(dir));
}

/** 数据根下某会话的域事实集（conversationDirs 域序；viewer 域剔除） */
export function readConversationFacts(dataRoot: string, conversationId: string, dirs?: string[]): DomainFacts[] {
  const list = dirs ?? conversationDirs(dataRoot, conversationId, { includeJournalOnly: true });
  const out: DomainFacts[] = [];
  for (const dir of list) {
    const domain = path.basename(path.dirname(path.dirname(dir)));
    if (domain === 'viewer') continue;
    out.push(readDomainFacts(dir, domain));
  }
  return out;
}
