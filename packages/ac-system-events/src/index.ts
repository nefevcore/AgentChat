// ============================================================
// ac-system-events —— 系统事件日志纯库（cr-1182 批1）
//
// 定位：持久化 Agent 的环境感知数据面。宿主进程内系统级事件（宿主
// 换代、壳拉起、行集变化）append-only 落 <dataRoot>/meta/system-events.jsonl；
// 壳侧注入行（ac-env-pulse）按 per-(agent×会话) 水位读 delta，run 启动时
// 注入「自上次活跃后发生了什么」。读写两侧分进程：宿主单写者、壳纯
// 读者——无多进程并发写（第二写者出现时再加文件锁）。
//
// 词汇裁决（cr-1182）：事件 kind 开放词汇（后续生态行可扩展），当前
// 最小集三事件全宿主进程内生产。timer 变更不进（写面 per-agent、作用域
// per-agent、已有 timer 域状态文件为正位——全局公告流错配）。
//
// 事件形状：{ seq, ts, kind, ...payload }——seq 文件内单调 +1（行序即
// 真序，seq 为身份锚/水位用）；ts 纪元毫秒（与账本 timestamp 同口径）。
// ============================================================
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 系统事件（wire 形 = 持久形态） */
export interface SystemEvent {
  /** 文件内单调序号（1 起，身份锚/水位用） */
  seq: number;
  /** 事件时刻（纪元毫秒） */
  ts: number;
  /** 事件类（开放词汇：host-boot / shell-start / rowset-changed / 生态扩展） */
  kind: string;
  /**
   * 归属 Agent（数据面作用域词汇）：有 = per-agent 事件（读侧按 viewer 过滤，
   * 如 shell-start——别的 Agent 的壳拉起与本 Agent 无关）；无 = 全局公告
   * （如 host-boot / rowset-changed——全员相关）。
   */
  agentId?: string;
  /** 载荷（kind 自定义；renderSystemEvents 消费方约定见各 kind 注释） */
  payload?: Record<string, unknown>;
}

/** 日志文件路径（meta/ 数据分层第二层——与 timer/state.json 同域） */
export function systemEventsFile(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), 'meta', 'system-events.jsonl');
}

/**
 * 追加一条事件（宿主侧写；fail-soft——事件日志是尽力面，写失败不阻塞
 * boot/spawn 主链）。seq 续接尾行 +1（行序权威，seq 只作锚不承担重排）。
 */
export function appendSystemEvent(
  dataRoot: string,
  kind: string,
  payload?: Record<string, unknown>,
  agentId?: string,
): void {
  const file = systemEventsFile(dataRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let lastSeq = 0;
    try {
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '');
      const last = JSON.parse(lines[lines.length - 1]!) as { seq?: unknown };
      if (typeof last.seq === 'number') lastSeq = last.seq;
    } catch { /* 缺席/坏文件 → 1 起 */ }
    const event: SystemEvent = {
      seq: lastSeq + 1,
      ts: Date.now(),
      kind,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(payload !== undefined ? { payload } : {}),
    };
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf-8');
  } catch {
    // fail-soft：事件日志缺席不破坏系统功能（注入侧读空 = 无增量）
  }
}

/**
 * 读自 seq 之后的事件（壳侧纯读；delta = (since, ∞)）。
 * 文件缺席/损坏 → 空数组（fail-open：注入侧降级为无增量，不阻断 run）。
 */
export function readSystemEventsSince(dataRoot: string, since: number): SystemEvent[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(systemEventsFile(dataRoot), 'utf-8').split('\n');
  } catch {
    return [];
  }
  const out: SystemEvent[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    let ev: SystemEvent | undefined;
    try {
      const raw = JSON.parse(line) as { seq?: unknown; ts?: unknown; kind?: unknown; agentId?: unknown; payload?: unknown };
      if (typeof raw.seq === 'number' && typeof raw.ts === 'number' && typeof raw.kind === 'string') {
        const payload = raw.payload !== undefined && raw.payload !== null && typeof raw.payload === 'object'
          ? raw.payload as Record<string, unknown>
          : undefined;
        // 归属位（读旧写新兼容窗）：现行写侧走顶层 agentId；cr-1182 修补前的
        // 存量行把 agentId 放在 payload 里——读侧提升，旧行同样按 per-agent
        // 过滤（append-only 日志不改历史行）。
        const legacyAgent = payload !== undefined && typeof payload['agentId'] === 'string' ? payload['agentId'] as string : undefined;
        const agentId = typeof raw.agentId === 'string' && raw.agentId !== '' ? raw.agentId : legacyAgent;
        ev = {
          seq: raw.seq,
          ts: raw.ts,
          kind: raw.kind,
          ...(agentId !== undefined && agentId !== '' ? { agentId } : {}),
          ...(payload !== undefined ? { payload } : {}),
        };
      }
    } catch {
      ev = undefined; // 坏行跳过（append-only 语义下好行仍可读）
    }
    if (ev !== undefined && ev.seq > since) out.push(ev);
  }
  return out;
}

/** 事件 → 人读句（注入行渲染用；未知 kind 原样带 kind 名——开放词汇的
 * 容错面：生态扩展事件缺渲染词时仍可读） */
export function renderSystemEvent(ev: SystemEvent): string {
  const t = new Date(ev.ts);
  const hhmm = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
  const p = ev.payload ?? {};
  const str = (k: string): string | undefined => (typeof p[k] === 'string' ? p[k] as string : undefined);
  switch (ev.kind) {
    case 'host-boot':
      return hhmm + ' 宿主重启完成（新代 pid ' + String(p.pid ?? '?') + (str('rowsetFp') !== undefined ? '，行集指纹 ' + str('rowsetFp') : '') + '）';
    case 'shell-start':
      // per-agent 事件（读侧已按 viewer 过滤）——本 Agent 壳重启 = 会话状态被重置。
      // pid 缺席（存量行）不渲染该段，勿输出占位符噪声。
      return hhmm + ' 你的 Agent 壳重启（' + (p.pid !== undefined ? '新代 pid ' + String(p.pid) + '，' : '') + '进程内会话状态已重置）';
    case 'rowset-changed':
      return hhmm + ' 行集变化：' + (str('summary') ?? '指纹 ' + (str('rowsetFp') ?? '?'));
    default:
      return hhmm + ' [系统事件] ' + ev.kind;
  }
}

/**
 * 作用域过滤（读侧）：带 agentId 的 per-agent 事件只对该 Agent 可见（别的
 * Agent 的壳拉起与本 Agent 无关——全局注入即噪声）。viewer 缺省 = 不过滤
 * （诊断/聚合读面）。
 */
export function filterEventsFor(events: SystemEvent[], viewerAgentId?: string): SystemEvent[] {
  if (viewerAgentId === undefined) return events;
  return events.filter((e) => e.agentId === undefined || e.agentId === viewerAgentId);
}

/** delta 渲染（注入行正文；事件空 = undefined——不注入）。
 *  viewerAgentId 给定 = 按作用域过滤后再渲染（注入行恒传本 Agent）。 */
export function renderSystemEvents(events: SystemEvent[], viewerAgentId?: string): string | undefined {
  const visible = filterEventsFor(events, viewerAgentId);
  if (visible.length === 0) return undefined;
  return '[系统状态] 自你上次活跃后系统发生如下变化：\n' + visible.map((e) => '- ' + renderSystemEvent(e)).join('\n');
}

/** 事件数组尾 seq（水位推进用；空 = 0） */
export function maxSeqOfEvents(events: SystemEvent[]): number {
  return events.length === 0 ? 0 : Math.max(...events.map((e) => e.seq));
}

/** 尾行指纹（宿主 boot 挂点比对用：与上一条 host-boot 的 rowsetFp 不同
 * → 追加 rowset-changed）。缺席/无先前 host-boot = undefined。 */
export function lastHostBootRowsetFp(dataRoot: string): string | undefined {
  const all = readSystemEventsSince(dataRoot, 0);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]!.kind === 'host-boot') {
      const fp = all[i]!.payload?.['rowsetFp'];
      return typeof fp === 'string' ? fp : undefined;
    }
  }
  return undefined;
}

// ---- 行集指纹（宿主 boot 挂点共用——稳定键序防同内容异序哈希） ----

/** 行集清单 → 稳定指纹（sha256 前 16 hex；行集 = 排序后 id 串） */
export function rowsetFingerprintOf(rowIds: Iterable<string>): string {
  const ids = [...rowIds].sort().join(',');
  return crypto.createHash('sha256').update(ids).digest('hex').slice(0, 16);
}

/** 两行集清单 diff → 人读摘要（rowset-changed 载荷用；同集 = undefined） */
export function rowsetDiffSummary(prev: string[], next: string[]): string | undefined {
  const added = next.filter((x) => !prev.includes(x));
  const removed = prev.filter((x) => !next.includes(x));
  if (added.length === 0 && removed.length === 0) return undefined;
  const parts: string[] = [];
  if (added.length > 0) parts.push('新增行 ' + added.join('、'));
  if (removed.length > 0) parts.push('移除行 ' + removed.join('、'));
  return parts.join('；');
}
