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

/** journal-settled 计量行（账本事实源投影——run 级聚合原样） */
interface JournalMeterRow {
  agent: string;
  conversationId: string;
  runId: string;
  model: string;
  finish: string;
  usage: LoopRunUsage;
  /** 计量时刻（ISO）——同会话终稿行（同 run）的 timestamp */
  timestamp: string;
}

/** 扫数据根全部 agent 域账本的 journal 计量（run 唯一：同 run 至多一行带
 *  usage 的 settled——写侧唯一写点 + 全数据根实测零重复；无 usage 行 =
 *  错误收束/重放标记，跳过）。时间取同会话 messages.jsonl 中同 run 终稿行
 *  的 timestamp（journal 行自身无时间字段）；缺终稿行（崩溃孤儿 run）按
 *  journal 文件 mtime 兜底。 */
function scanJournalMeters(dataRoot: string): JournalMeterRow[] {
  const out: JournalMeterRow[] = [];
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
      if (!fs.existsSync(jf)) continue;
      let raw = '';
      try { raw = fs.readFileSync(jf, 'utf-8'); } catch { continue; }
      // 同 run 终稿行时间索引（messages.jsonl 按行序 = 时间序，末次出现即收束时刻）
      const runTs = new Map<string, string>();
      try {
        const msgs = fs.readFileSync(path.join(sessDir, 'messages.jsonl'), 'utf-8');
        for (const row of msgs.split('\n')) {
          if (!row.includes('"run"')) continue;
          let l: any; try { l = JSON.parse(row); } catch { continue; }
          if (typeof l?.run === 'string' && typeof l?.timestamp === 'string') runTs.set(l.run, l.timestamp);
        }
      } catch { /* messages.jsonl 缺席（journal-only 会话）——mtime 兜底 */ }
      const mtime = new Date(fs.statSync(jf).mtimeMs).toISOString();
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
          timestamp: runTs.get(l.run) ?? mtime,
        });
      }
    }
  }
  return out;
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
 *  同指纹，下次 boot 对拍为空。 */
function reconcileUsage(svc: UsageService, dataRoot: string): number {
  const auditKeys = scanAuditRunKeys(dataRoot);
  const missing: JournalMeterRow[] = [];
  for (const m of scanJournalMeters(dataRoot)) {
    const key = [m.agent, m.conversationId, m.usage.promptAccumulated, m.usage.completion, m.usage.steps].join('\u0000');
    const seen = auditKeys.get(key) ?? 0;
    if (seen > 0) { auditKeys.set(key, seen - 1); continue; } // 已到账（计数容差消 fingerprint 撞）
    missing.push(m);
  }
  for (const m of missing) {
    svc.reportMeter({
      agent: m.agent,
      model: m.model,
      finish: m.finish,
      usage: m.usage,
      conversationId: m.conversationId,
      timestamp: m.timestamp,
    });
  }
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