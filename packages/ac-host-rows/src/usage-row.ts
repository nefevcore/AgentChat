// ============================================================
// usage-row.ts —— 宿主 usage 行（cr-538：R1 usage 行「计费聚合（对账
// ledger 自报事件信）」preview 落地）
//
// 形态：UsageService 聚合并（主线零改动导入）+ host 端点收信面
//（UserStub 同构——邮局 local 通道）。壳 usage 事件信（kind=receipt /
// subject=usage-run）到达 → requestId 幂等去重 → reportMeter 入账
//（审计流水 + 内存聚合——查询面/webui 数据源与主线恒等）。
// 主线 UsageService 的 loop/after-run 订阅在宿主进程内空转零成本
//（无 loop 事件源——计量经事件信到达）。
//
// cr-842 对账回填（boot 一次）：壳 ledger 的 usage 事件信是 at-least-once
// 但历史上有一类静默丢失（IpcClient 断连不重连——宿主重启后长活壳发信
// 全部 catch 吞错）。计量本身已随 settlement 落 agents/<agent>/sessions/
// <sid>/journal/partials.jsonl 的 journal-settled 行（账本 = 事实源，信 =
// 尾巴）。boot 扫全账本：journal 计量与 audit 流水对拍，差额行经
// reportMeter(timestamp=账本时间) 补录——丢的信从事实源补回，逐日数据恢复。
// cr-871 水位增量：已覆盖 session 跳过 + messages 懒读（稳态零全读，见对账段注释）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context, Plugin } from '@agentchat/cordis';
import { UsageService, type UsageRowOptions } from 'ac-usage';
import type { LoopRunUsage } from 'ac-agent-loop';
import type { Envelope, UsageReportPayload, UsageStepPayload } from 'ac-envelope-core';
import { isUsageReport, validateUsagePayload } from 'ac-envelope-core';
import type { HostInbox } from './host-inbox.ts';

/** usage 行装配参数 */
export interface UsageHostRowOptions extends UsageRowOptions {
  /** host 端点收信扇出面（cr-545 起与 auth-registry 行共用——boot 建 HostInbox 注入） */
  inbox: HostInbox;
}

/**
 * 宿主 usage 行：UsageService 聚合并 + host 端点收信面。
 * 服务实例直引（不经 ctx.usage getter——插件 inject 声明在同 fiber
 * 自注册场景会 PENDING 死锁；服务键注册照常，主线消费面不受影响）。
 */
// —— cr-842 对账回填：journal 计量（事实源）vs audit 流水对拍，差额补录 ——
// cr-871 增量化：水位（<root>/usage/reconcile-watermark.json = 上次成功扫描
// 的开始时刻）之前的 journal 已被覆盖（补录幂等、audit 持证）——stat 一次即
// 跳过，boot 对账从 O(全历史)（实测 42agent×1175session×282MB 全读 87.6s，
// 同步卡死事件循环）降为 O(新增 session)；messages.jsonl 只为补录行所在
// session 读（lazy 取时间戳），稳态对账零全读。水位随 usage/ 清空消失 =
// 下次全量重建（清流水语义下从事实源重捞）。

/** journal-settled 计量候选行（时间戳未解析——仅补录行需要，届时 lazy 读
 *  该 session 的 messages.jsonl） */
interface JournalCandidateRow {
  agent: string;
  conversationId: string;
  runId: string;
  model: string;
  finish: string;
  usage: LoopRunUsage;
  /** journal 文件 mtime（ISO）——messages 缺终稿行时的兜底时间戳 */
  journalMtime: string;
  /** 所在 session 目录（lazy 读 messages.jsonl 的寻址） */
  sessDir: string;
}

/** 水位读（缺席/损坏 = null → 全量扫描） */
function readReconcileWatermark(dataRoot: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataRoot, 'usage', 'reconcile-watermark.json'), 'utf-8')) as { at?: unknown };
    const at = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  } catch { return null; }
}

/** 水位写（尽力面：失败不抛——下次全量重扫，幂等无害）。值 = 本次扫描的
 *  开始时刻：扫描期间新写的 journal（mtime ≥ 开始时刻）不会被误跳过。 */
function writeReconcileWatermark(dataRoot: string, scanStartMs: number): void {
  try {
    const dir = path.join(dataRoot, 'usage');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reconcile-watermark.json'), JSON.stringify({ at: new Date(scanStartMs).toISOString() }), 'utf-8');
  } catch { /* 尽力面 */ }
}

/** 扫 agent 域账本的 journal 计量候选（run 唯一：同 run 至多一行带 usage
 *  的 settled——写侧唯一写点 + 全数据根实测零重复；无 usage 行 = 错误
 *  收束/重放标记，跳过）。水位前的 session 已覆盖，stat 一次即跳过。 */
function scanJournalMeters(dataRoot: string, watermarkMs: number | null): JournalCandidateRow[] {
  const out: JournalCandidateRow[] = [];
  let agents: fs.Dirent[] = [];
  try { agents = fs.readdirSync(path.join(dataRoot, 'agents'), { withFileTypes: true }); } catch { return out; }
  for (const a of agents) {
    if (!a.isDirectory()) continue;
    let sids: fs.Dirent[] = [];
    try { sids = fs.readdirSync(path.join(dataRoot, 'agents', a.name, 'sessions'), { withFileTypes: true }); } catch { continue; }
    for (const s of sids) {
      if (!s.isDirectory()) continue;
      const sessDir = path.join(dataRoot, 'agents', a.name, 'sessions', s.name);
      const jf = path.join(sessDir, 'journal', 'partials.jsonl');
      const st = fs.statSync(jf, { throwIfNoEntry: false });
      if (st === undefined || (watermarkMs !== null && st.mtimeMs < watermarkMs)) continue;
      let raw = '';
      try { raw = fs.readFileSync(jf, 'utf-8'); } catch { continue; }
      const mtime = new Date(st.mtimeMs).toISOString();
      for (const row of raw.split('\n')) {
        if (!row.includes('journal-settled')) continue;
        let l: any; try { l = JSON.parse(row); } catch { continue; }
        if (l?.type !== 'journal-settled' || typeof l?.run !== 'string' || !l?.usage) continue;
        out.push({
          agent: a.name,
          conversationId: s.name,
          runId: l.run,
          model: typeof l.model === 'string' ? l.model : '',
          finish: typeof l.finish === 'string' ? l.finish : '',
          usage: l.usage,
          journalMtime: mtime,
          sessDir,
        });
      }
    }
  }
  return out;
}

/** 同 run 终稿行时间索引（messages.jsonl 按行序 = 时间序，末次出现即收束
 *  时刻）——journal 行自身无时间字段；缺终稿行（崩溃孤儿 run）由调用方按
 *  journal mtime 兜底。 */
function readRunTimestamps(sessDir: string): Map<string, string> {
  const runTs = new Map<string, string>();
  try {
    const msgs = fs.readFileSync(path.join(sessDir, 'messages.jsonl'), 'utf-8');
    for (const row of msgs.split('\n')) {
      if (!row.includes('"run"')) continue;
      let l: any; try { l = JSON.parse(row); } catch { continue; }
      if (typeof l?.run === 'string' && typeof l?.timestamp === 'string') runTs.set(l.run, l.timestamp);
    }
  } catch { /* messages.jsonl 缺席（journal-only 会话）——mtime 兜底 */ }
  return runTs;
}

/** audit 流水已记账的 run 键集（cr-842 对拍基准。audit 行无 runId——以
 *  (agent, conversationId, usage.promptAccumulated, usage.completion,
 *  usage.steps) 五元组为指纹匹配；同一 run 的信重投与对账补录都不会撞
 *  新指纹（数字全等才判同）。会话内同指纹多 run（小概率）按计数容差。 */
function scanAuditRunKeys(dataRoot: string): Map<string, number> {
  const counts = new Map<string, number>();
  const usageDir = path.join(dataRoot, 'usage');
  let files: string[] = [];
  try { files = fs.readdirSync(usageDir).filter((f) => f.endsWith('.jsonl')); } catch { return counts; }
  for (const f of files) {
    let raw = '';
    try { raw = fs.readFileSync(path.join(usageDir, f), 'utf-8'); } catch { continue; }
    for (const row of raw.split('\n')) {
      if (!row.trim()) continue;
      let l: any; try { l = JSON.parse(row); } catch { continue; }
      if (typeof l?.agent !== 'string' || !l?.usage) continue;
      const key = [l.agent, l.conversationId ?? l.agent, l.usage.promptAccumulated, l.usage.completion, l.usage.steps].join('\u0000');
      counts.set(key, (counts.get(key) ?? 0) + 1);
      // stepCache 字段变化不进指纹（同 run 重投时 stepCache 可能有无两态）
    }
  }
  return counts;
}

/** 对账补录：journal 有而 audit 无的计量行 → reportMeter(timestamp=账本
 *  时间) 补入。返回补录条数（boot 日志观测）。幂等：补录后 audit 即持有
 *  同指纹，下次对拍为空。无候选（水位全覆盖）时零全读；补录中途抛错则
 *  水位不推进（下次重扫，幂等兜底）。 */
function reconcileUsage(svc: UsageService, dataRoot: string): number {
  const scanStartMs = Date.now();
  const wmOld = readReconcileWatermark(dataRoot);
  const candidates = scanJournalMeters(dataRoot, wmOld);
  const missing: JournalCandidateRow[] = [];
  if (candidates.length > 0) {
    const auditKeys = scanAuditRunKeys(dataRoot);
    for (const m of candidates) {
      const key = [m.agent, m.conversationId, m.usage.promptAccumulated, m.usage.completion, m.usage.steps].join('\u0000');
      const seen = auditKeys.get(key) ?? 0;
      if (seen > 0) { auditKeys.set(key, seen - 1); continue; } // 已到账（计数容差消 fingerprint 撞）
      missing.push(m);
    }
    // 时间戳 lazy 解析：同 session 的 messages.jsonl 只读一次（多补录行共享）
    const tsBySession = new Map<string, Map<string, string>>();
    for (const m of missing) {
      let runTs = tsBySession.get(m.sessDir);
      if (runTs === undefined) {
        runTs = readRunTimestamps(m.sessDir);
        tsBySession.set(m.sessDir, runTs);
      }
      svc.reportMeter({
        agent: m.agent,
        model: m.model,
        finish: m.finish,
        usage: m.usage,
        conversationId: m.conversationId,
        timestamp: runTs.get(m.runId) ?? m.journalMtime,
      });
    }
  }
  // 单调推进（max）：时钟回拨/人工改水位时不收窄覆盖面——不变式
  // 「mtime < 水位的 journal 已对账」只进不退。
  writeReconcileWatermark(dataRoot, Math.max(scanStartMs, wmOld ?? 0));
  return missing.length;
}

export function makeUsageHostRow(options: UsageHostRowOptions): Plugin {
  return {
    name: 'host-usage-row',
    inject: [],
    apply(ctx: Context) {
      let svc: UsageService | null = null;
      // 对账回填（cr-842）在服务构造器内跑：svc 捕获与 ctx.plugin 的 fiber
      // 时序不可依赖（plugin 装载异步），构造器是「this 就绪」的唯一确定点。
      // try/catch 包裹——对账失败不阻塞宿主 boot（观测面降级，信收面照常）。
      ctx.plugin(class extends UsageService {
        constructor(c: Context) {
          super(c, options);
          svc = this;
          try {
            const backfilled = reconcileUsage(this, options.root ?? './data');
            if (backfilled > 0) c.logger.info(`[usage] 对账回填 ${backfilled} 条丢失计量（journal → audit）`);
          } catch (err: unknown) {
            c.logger.warn('[usage] 对账回填失败: ' + String(err));
          }
        }
      });
      // host 端点收信面（HostInbox 扇出面——cr-545 起与 auth-registry 共存；
      // 非 usage 信静默直过〔回执/授权各归消费面〕，非法 payload 抛错 = 投递
      // 失败滞留重试〔fail-loud——原 warn+ack 吞错形态退役〕）
      options.inbox.on(async (env: Envelope) => {
        if (!isUsageReport(env)) return;
        const issues = validateUsagePayload(env.payload);
        if (issues.length > 0) throw new Error('[usage] 事件信 payload 非法：' + issues.join('；'));
        const p = env.payload as UsageReportPayload | UsageStepPayload;
        if (svc === null) return; // 服务未就绪（理论上不可达——构造先于注册）
        // 步级缓存信（cr-760）：pending 入账——运行中 run 的 KV 走势实时段
        if (p.subject === 'usage-step') {
          svc.reportStepPending(p.conversationId, { ts: p.ts, hit: p.hit, miss: p.miss });
          return;
        }
        svc.reportMeter({
          agent: p.agent,
          model: p.model,
          finish: p.finish,
          usage: p.usage,
          conversationId: p.conversationId,
          ...(p.stepCache !== undefined ? { stepCache: p.stepCache } : {}),
        });
      });
    },
  } satisfies Plugin;
}