// ============================================================
// ac-harness-tools/src/sessions.ts —— runKey 持久化（P2/cr-279）
//
// Agent 专属空间 harness/sessions.json：conversationId → { gateway, runKey, ts }。
// 语义：run 成功（finish=stop）即记——同会话下次委托默认续接（resume=auto）；
// 失败/超时/中止不覆盖（上次成功凭据保留，模型可显式 resume=new 重开）。
// 原子写（tmp+rename 同仓惯例）；读失败/损坏 = 空表（宽松降级——续接是优化不是承诺）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface HarnessSessionEntry {
  gateway: 'claude-code' | 'codex';
  runKey: string;
  ts: number;
}

type Table = Record<string, HarnessSessionEntry>;

function fileOf(agentDir: string): string {
  return path.join(agentDir, 'harness', 'sessions.json');
}

/** 读映射表（不存在/损坏 → 空表） */
export function readSessions(agentDir: string): Table {
  try {
    const raw = fs.readFileSync(fileOf(agentDir), 'utf-8');
    return toTable(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** 解析值形状守卫（null/数组/标量 → 空表——损坏文件宽松降级） */
function toTable(v: unknown): Table {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Table = {};
  for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
    if (e !== null && typeof e === 'object'
      && typeof (e as { gateway?: unknown }).gateway === 'string'
      && typeof (e as { runKey?: unknown }).runKey === 'string') {
      out[k] = e as HarnessSessionEntry;
    }
  }
  return out;
}

/** 记一条（finish=stop 时调用）：读-合-原子写；写失败静默（续接降级为 new） */
export function recordSession(agentDir: string, conversationId: string, entry: HarnessSessionEntry): void {
  try {
    const file = fileOf(agentDir);
    const table = readSessions(agentDir);
    table[conversationId] = entry;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(table, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    /* 记录失败不阻断结果回流 */
  }
}

/** 查会话当前续接凭据（无 conversationId/无记录 → undefined） */
export function sessionRunKeyOf(agentDir: string, conversationId: string | undefined, gateway: 'claude-code' | 'codex'): string | undefined {
  if (conversationId === undefined) return undefined;
  const table = readSessions(agentDir);
  // hasOwnProperty 判存在（Record 索引类型不含 undefined——判 key 而非判值）
  if (!Object.prototype.hasOwnProperty.call(table, conversationId)) return undefined;
  // 网关切换 = 旧凭据不同域，不续接（claude session 与 codex thread 不互通）
  return table[conversationId].gateway === gateway ? table[conversationId].runKey : undefined;
}