// ============================================================
// writer.ts —— 导入写面（盘上落盘 + 原子换名 + 恒等复验）
//
// 编排（R-10）：staging 写入（tmp 目录全量构造：messages + journal +
// subcalls 恒等拷贝 + 未知文件恒等拷贝）→ 落盘后 verifySession 复验
//（写面缺陷在换名前暴露）→ 原子换名进 agents/<id>/sessions/（失败即
// 中止不落半态；目标已存在 = 幂等重入，rows 不一致 fail-loud）。
// 主线原样保留：全程零写入旧根。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readLegacySession, agentIdOfPairKey, scanLegacyRoot, type LegacyRow, type LegacyRunSettled, type LegacyJournalRow } from './legacy.ts';
import { projectSession, projectSubcalls, type ProjectContext, type Projected } from './project.ts';
import { verifySession } from './verify.ts';
import { importAgentsTree, type AgentTreeResult } from './agents-tree.ts';
import { projectUserLedgers, type UserProjectionStats } from './user-projection.ts';
import { readLedger, readJournal } from 'ac-ledger';

/** 旧会话文件集（readLegacySession 返回面——参数透传用） */
export interface LegacyFiles {
  headerCreatedAt: string | null;
  rows: Array<LegacyRow | LegacyRunSettled>;
  partials: LegacyJournalRow[];
  subcalls: LegacyRow[];
  summary: string | null;
  extraFiles: string[];
  marker: boolean;
}

/**
 * agentId → 路径段净化（Windows 非法字符 : * ? " < > | 及控制符 → %XX 转义；
 * 双向可还原——decodeURIComponent 逆转）。真数据根实测：remote:dev-ROx 形态
 * 的 agentId 冒号在 Windows 路径非法（cr-518）。
 */
export function pathSegment(agentId: string): string {
  return agentId.replace(/[%:*?"<>|\\\/[\x00-\x1f]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** 单会话导入结果（导入报告行） */
export interface SessionImportResult {
  key: string;
  agentId: string;
  uuid: string;
  kind: string;
  rows: number;
  dropped: number;
  materialized: number;
  subcalls: number;
  extraFiles: number;
}

/** 单会话 staging 写入：投影产物 → 目标目录全量构造（文件写，不 rename） */
export function writeSession(targetDir: string, files: LegacyFiles, legacyDir: string, projected: Projected): void {
  fs.mkdirSync(path.join(targetDir, 'journal'), { recursive: true });
  const lines = [JSON.stringify(projected.header), ...projected.rows.map((r) => JSON.stringify(r))];
  fs.writeFileSync(path.join(targetDir, 'messages.jsonl'), lines.join('\n') + '\n', 'utf-8');
  if (projected.journal.length > 0) {
    fs.writeFileSync(path.join(targetDir, 'journal', 'partials.jsonl'), projected.journal.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  }
  if (files.subcalls.length > 0) {
    fs.copyFileSync(path.join(legacyDir, 'subcalls.jsonl'), path.join(targetDir, 'subcalls.jsonl'));
  }
  if (files.summary !== null) fs.copyFileSync(path.join(legacyDir, 'summary.md'), path.join(targetDir, 'summary.md'));
  for (const name of files.extraFiles) {
    fs.copyFileSync(path.join(legacyDir, name), path.join(targetDir, name));
  }
}
/**
 * 单会话导入三步：staging 写入 → 落盘复验 → 原子换名。
 * staging 位形：<stagingRoot>/<agentId>/<uuid>.staging/；最终位形：
 * <targetRoot>/agents/<agentId>/sessions/<uuid>/。
 */
export function importSession(
  legacyDir: string,
  ctx: ProjectContext,
  targetRoot: string,
  stagingRoot: string,
): SessionImportResult {
  const files = readLegacySession(legacyDir);
  const projected = projectSession(files.rows, files.partials, ctx, files.extraFiles, files.headerCreatedAt);
  const problems = verifySession(files.rows, files.partials, projected);
  if (problems.length > 0) throw new Error('恒等门失败 [' + ctx.uuid + ']：' + problems.slice(0, 3).map((p) => p.kind + '@' + p.detail).join(' | '));
  const stagingDir = path.join(stagingRoot, pathSegment(ctx.agentId), ctx.uuid + '.staging');
  fs.rmSync(stagingDir, { recursive: true, force: true });
  writeSession(stagingDir, files, legacyDir, projected);
  // 落盘复验：读回对齐（写面缺陷在换名前暴露）
  const back = readLedger(stagingDir);
  if (back.rows.length !== projected.rows.length) {
    throw new Error('落盘复验失败 [' + ctx.uuid + ']：rows ' + back.rows.length + ' != ' + projected.rows.length);
  }
  const backJournal = readJournal(stagingDir);
  if (backJournal.length !== projected.journal.length) {
    throw new Error('落盘复验失败 [' + ctx.uuid + ']：journal ' + backJournal.length + ' != ' + projected.journal.length);
  }
  // 原子换名（目标已存在 = 幂等重入：投影是确定性纯函数——同源重导必逐字节
  // 一致；内容不一致 = 非同源（双位分叉/目标被改写）→ fail-loud 人工裁决。
  // cr-547 根因修复：原护栏只比 rows 行数——真数据根实测 sid 3abe307a 双位
  //（根直下 12 行含 3 run-settled / shelf 11 行含 2）投影 rows 恰同 9，
  // 分叉会话被静默以后到丢弃，违 R-10 信息无丢失。）
  const targetDir = path.join(targetRoot, 'agents', pathSegment(ctx.agentId), 'sessions', ctx.uuid);
  if (fs.existsSync(targetDir)) {
    const existing = readLedger(targetDir);
    if (JSON.stringify(existing.rows) !== JSON.stringify(projected.rows)) {
      throw new Error('换名冲突 [' + ctx.uuid + ']：目标已存在且内容不一致（rows ' + existing.rows.length + ' vs ' + projected.rows.length + '）——人工裁决');
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } else {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.renameSync(stagingDir, targetDir);
  }
  return {
    key: ctx.uuid,
    agentId: ctx.agentId,
    uuid: ctx.uuid,
    kind: ctx.kind,
    rows: projected.rows.length,
    dropped: projected.stats.dropped,
    materialized: projected.stats.materialized,
    subcalls: files.subcalls.length,
    extraFiles: files.extraFiles.length,
  };
}

/**
 * 全根导入编排（R-10 语义总入口）：扫描 → 逐会话 importSession → 报告。
 * 域 → ProjectContext 派生规则（旧格式知识圈禁于此）：
 *   pairs：<a>~<b> → agentId = 尾段，participants = 两端，kind = agent-pair
 *   groups：gid → agentId = gid（群本体账本归群端点自身——D4），kind = group
 *   singles：sid → agentId = 行内 majority（空 = fallback），participants = [agentId, user]，kind = user
 *   subagents：subId → agentId = 行内非 user majority（空 = __standard__ 兜底），kind = subagent
 *   unknown：跳过并计入报告（fail-loud 人工裁决面——不静默丢弃）；
 *   其中已人工裁决的键归 skip-list（reason 记裁决依据），不再计 failed-loud
 */

/**
 * 已裁决 unknown 键 → 跳过理由（人工裁决记录——裁决簿语义）。
 * 2026-10-19 用户裁决 B（跳过不导入，旧根保真）：__standard__ singles
 * 历史会话，元数据已删（singles 移除语义）消息桶残留——调试性短会话
 * 无保留价值，新系统不可见；旧 sessions/ 恒不删（R-10 终极回滚）。
 */
const ADJUDICATED_SKIPS: Record<string, string | undefined> = {
  '72481a4d-d574-4f24-89da-bb7cd1f6909f': '已裁决跳过（2026-10-19 B）：__standard__ singles 调试会话，元数据已删',
};

/**
 * singles 双位裁决记录（cr-547）：sid → 保留位（目录名匹配后缀）。双位 = 旧系统
 * 会话移动残留（真数据根 1 例：3abe307a——根直下与 shelf 同 sid 并存，内容分叉）。
 * 2026-10-19 裁决：保留根直下位（内容更全 = 事实终态；shelf 版为中途分叉）。
 */
const ADJUDICATED_SINGLES: Record<string, string> = {
  '3abe307a-87f9-46c7-9c6f-571047b2a5d3': 'sessions/3abe307a-87f9-46c7-9c6f-571047b2a5d3',
};

export async function importRoot(
  legacyRoot: string,
  targetRoot: string,
  stagingRoot: string,
  opts: {
    singleAgentFallback?: string;
    onResult?: (r: SessionImportResult) => void;
    /** agents 树域迁移（cr-547：config 换轨 + entries 归拢 + 身份文件拷贝） */
    agentsTree?: boolean;
    /** user 账本投影（cr-547：kind=user 会话 → users/user/sessions/ 终稿层） */
    userProjection?: boolean;
  } = {},
): Promise<{
  results: SessionImportResult[];
  skipped: Array<{ key: string; reason: string }>;
  /** agents 树域迁移结果（agentsTree 开启时在场） */
  agentsTreeResults?: AgentTreeResult[];
  /** user 账本投影统计（userProjection 开启时在场） */
  userProjectionStats?: UserProjectionStats;
}> {
  const inv = scanLegacyRoot(legacyRoot);
  const results: SessionImportResult[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  for (const p of inv.pairs) {
    const agentId = agentIdOfPairKey(p.conversationId);
    const parts = p.conversationId.split('~');
    const r = importSession(p.dir, { agentId, uuid: p.conversationId, participants: parts, kind: 'agent-pair' }, targetRoot, stagingRoot);
    results.push(r); opts.onResult?.(r);
  }
  for (const g of inv.groups) {
    const r = importSession(g.dir, { agentId: g.gid, uuid: g.gid, participants: [g.gid], kind: 'group' }, targetRoot, stagingRoot);
    results.push(r); opts.onResult?.(r);
  }
  // singles 同 sid 双位（根直下 + shelf 并存——真数据根实测分叉形态）：裁决记录
  // 单源（ADJUDICATED_SINGLES：sid → 保留位标记）；未裁决 = fail-loud 列候选。
  const bySid = new Map<string, Array<{ sid: string; dir: string; metaPath: string | null }>>();
  for (const s of inv.singles) {
    const list = bySid.get(s.sid) ?? [];
    list.push(s);
    bySid.set(s.sid, list);
  }
  for (const [, list] of bySid) {
    if (list.length > 1) {
      const picked = new Map(Object.entries(ADJUDICATED_SINGLES)).get(list[0].sid);
      if (picked === undefined) {
        throw new Error('singles 双位冲突 [' + list[0].sid + ']：' + list.map((x) => x.dir).join(' | ') + '——人工裁决（ADJUDICATED_SINGLES 登记）');
      }
      const canonical = list.find((x) => x.dir.replaceAll('\\', '/').endsWith(picked));
      if (canonical === undefined) throw new Error('singles 裁决指向不存在 [' + list[0].sid + ']：' + picked);
      list.length = 0;
      list.push(canonical);
    }
  }
  for (const [, list] of bySid) {
    for (const s of list) {
      const agentId = majorityAgentId(s.dir, opts.singleAgentFallback ?? 'default');
      const r = importSession(s.dir, { agentId, uuid: s.sid, participants: [agentId, 'user'], kind: 'user' }, targetRoot, stagingRoot);
      results.push(r); opts.onResult?.(r);
    }
  }
  for (const s of inv.subagents) {
    const agentId = majorityAgentId(s.dir, '__standard__', ['user']);
    const r = importSession(s.dir, { agentId, uuid: s.subId, participants: [agentId, 'user'], kind: 'subagent' }, targetRoot, stagingRoot);
    results.push(r); opts.onResult?.(r);
  }
  for (const u of inv.unknown) {
    const adjudicated = ADJUDICATED_SKIPS[u.conversationId];
    skipped.push({
      key: u.conversationId,
      reason: adjudicated ?? '无法归域：无 ~ 键且无 singles 元数据——人工裁决',
    });
  }
  // agents 树域迁移（cr-547 B 段扩域——cr-540 遗留④收口）
  const agentsTreeResults = opts.agentsTree === true ? importAgentsTree(legacyRoot, targetRoot) : undefined;
  // user 账本投影（cr-547：singles 会话的 webui 读面补齐；await 落盘契约）
  const userProjectionStats = opts.userProjection === true ? await projectUserLedgers(targetRoot) : undefined;
  return { results, skipped, ...(agentsTreeResults !== undefined ? { agentsTreeResults } : {}), ...(userProjectionStats !== undefined ? { userProjectionStats } : {}) };
}

/** 行内 majority 归属提取（singles/subagents 用——旧根只读） */
function majorityAgentId(dir: string, fallback: string, exclude: string[] = []): string {
  try {
    const text = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8');
    const counts = new Map<string, number>();
    for (const line of text.split('\n')) {
      const m = line.match(/"agent_id":"([^"]+)"/);
      if (m === null) continue;
      if (exclude.includes(m[1])) continue;
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    let best = fallback; let bestN = 0;
    for (const [k, n] of counts) { if (n > bestN) { best = k; bestN = n; } }
    return best;
  } catch {
    return fallback;
  }
}
