// ============================================================
// legacy.ts —— 旧格式读取器（R-10「旧格式知识圈禁」的代码化）
//
// 旧格式知识（pairKey 构造 / 段行形态 / marker 形态 / 三文件布局）
// 只活在 ac-import 包内——新系统运行时零旧格式知识（ac-ledger 等
// 新纯库对旧形态零引用）。cutover 后本包随旧主线归档封存。
//
// 旧数据根布局（src/ac-session 实况）:
//   <root>/sessions/<conversationId>/messages.jsonl   对话定稿流
//   <root>/sessions/<conversationId>/partials.jsonl   run 周期台账（旧三文件）
//   <root>/sessions/<conversationId>/subcalls.jsonl   子调用永久档案
//   <root>/sessions/<conversationId>/summary.md       概要
//   <root>/sessions/<shelf>/<conversationId>/         上架（.shelves.json 索引）
//   <root>/subagents/<subId>/messages.jsonl           子代理会话（v3 目录化）
//   <root>/singles/<sid>/session.json                 独立会话元数据（ac-singles）
//   <root>/agents-store/agents.json                   agent 注册表（活注册表）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 旧会话行（宽容形状——未知字段原样携带，恒等门全字段校验消费） */
export interface LegacyRow {
  role: 'agent' | 'context' | 'system' | 'tool' | 'error' | 'event' | 'user' | 'assistant';
  content: string;
  message_id: string;
  timestamp: string;
  agent_id?: string;
  name?: string;
  source?: string;
  label?: string;
  reasoning_content?: string;
  steps?: Array<LegacyStep>;
  seq?: number;
  partial?: boolean;
  run?: string;
  requestId?: string;
  /** 段行 run 关联（settlement 物化产物）——未知字段原样携带（恒等门全字段校验） */
  [k: string]: unknown;
}

export interface LegacyStep {
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string; result?: unknown }>;
  [k: string]: unknown;
}

/** 旧 journal 行（partials.jsonl——步行/inject/补行，多形态宽容） */
export interface LegacyJournalRow {
  type?: string;
  run?: string;
  seq?: number;
  [k: string]: unknown;
}

/** 旧 run-settled 判别行（messages.jsonl 原子提交点）——宽容形状：其余字段原样携带 */
export interface LegacyRunSettled {
  type: 'run-settled';
  run: string;
  seq?: number;
  [k: string]: unknown;
}

/** 旧根扫描发现项 */
export interface LegacyInventory {
  /** 1v1 对话（含群成员转录流 gid~member） */
  pairs: Array<{ conversationId: string; dir: string }>;
  /** 独立会话（直下桶或 shelf 内会话；元数据 = 顶层 singles/<sid>/session.json，可缺席） */
  singles: Array<{ sid: string; dir: string; metaPath: string | null }>;
  /** 群本体账本（sessions/groups/<gid>/——群名册视角的全部成员发言流） */
  groups: Array<{ gid: string; dir: string }>;
  /** 无法归域的会话目录（无 ~ 且无 singles 元数据——fail-loud 上报人工裁决） */
  unknown: Array<{ conversationId: string; dir: string }>;
  /** 子代理会话（subagents/<subId>/） */
  subagents: Array<{ subId: string; dir: string }>;
  /** agent 注册表（agents-store/agents.json——旧活注册表） */
  agentsStorePath: string | null;
}

/** 会话目录内已知三文件以外的文件（恒等拷贝面） */
const KNOWN_FILES = ['messages.jsonl', 'partials.jsonl', 'subcalls.jsonl', 'summary.md', '.migrated'];

/** 尾段提取：pairKey `a~b`（排序）→ 右起首 ~ 后段 = agent id（成员恒最右——群转录流同形） */
export function agentIdOfPairKey(conversationId: string): string {
  const i = conversationId.lastIndexOf('~');
  if (i === -1) throw new Error('非 pairKey 形态的会话键：' + conversationId);
  return conversationId.slice(i + 1);
}

/** 旧根扫描：四域枚举（坏目录跳过计 warning，不中止——宁慢勿丢） */
export function scanLegacyRoot(dataRoot: string): LegacyInventory {
  const inv: LegacyInventory = { pairs: [], singles: [], unknown: [], groups: [], subagents: [], agentsStorePath: null };
  const singlesMeta = path.join(dataRoot, 'singles');
  const sessionsRoot = path.join(dataRoot, 'sessions');
  if (fs.existsSync(sessionsRoot)) {
    // 递归下探：sessions/ 下三层混合形态（直下会话 / singles/<ws|ungrouped>/<sid>/
    // shelf——781 例实测 / groups/<gid>/ 群本体账本），以 messages.jsonl 所在目录归域。
    const walk = (d: string, zone: 'root' | 'shelf' | 'groups'): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (!entry.isDirectory()) continue;
        if (entry.name === '.shelf' || entry.name.startsWith('.')) continue;
        const hasMessages = fs.existsSync(path.join(p, 'messages.jsonl'));
        const nextZone = entry.name === 'singles' ? 'shelf' : entry.name === 'groups' ? 'groups' : zone;
        if (hasMessages && nextZone === 'root') {
          // 直下会话：含 ~ = pairKey（1v1 / 群转录流 gid~member——右起首 ~ 后段 = agent）；
          // 无 ~ + 顶层 singles/<sid>/session.json = singles 消息桶。目录名原键即新 uuid。
          if (entry.name.includes('~')) inv.pairs.push({ conversationId: entry.name, dir: p });
          else if (fs.existsSync(path.join(singlesMeta, entry.name, 'session.json'))) {
            inv.singles.push({ sid: entry.name, dir: p, metaPath: path.join(singlesMeta, entry.name, 'session.json') });
          } else {
            inv.unknown.push({ conversationId: entry.name, dir: p });
          }
        } else if (hasMessages && nextZone === 'shelf') {
          // shelf 内会话：sid 目录即会话（元数据同查顶层 singles/<sid>/session.json）
          inv.singles.push({ sid: entry.name, dir: p, metaPath: fs.existsSync(path.join(singlesMeta, entry.name, 'session.json')) ? path.join(singlesMeta, entry.name, 'session.json') : null });
        } else if (hasMessages && nextZone === 'groups') {
          inv.groups.push({ gid: entry.name, dir: p });
        } else {
          walk(p, nextZone);
        }
      }
    };
    walk(sessionsRoot, 'root');
  }
  // subagents 域
  const subsRoot = path.join(dataRoot, 'subagents');
  if (fs.existsSync(subsRoot)) {
    for (const entry of fs.readdirSync(subsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(subsRoot, entry.name);
      if (fs.existsSync(path.join(dir, 'messages.jsonl'))) {
        inv.subagents.push({ subId: entry.name, dir });
      }
    }
  }
  // agent 注册表（旧活注册表——M8 切换时 8.9 消费）
  const storePath = path.join(dataRoot, 'agents-store', 'agents.json');
  if (fs.existsSync(storePath)) inv.agentsStorePath = storePath;
  return inv;
}

/** 会话目录读全量：messages（行宽容解析，坏行原样保留报 warning）+ partials + subcalls + 概要 + 未知文件清单 */
export interface LegacySessionFiles {
  /** 旧 header 首行的 createdAt（缺席 = null——投影时回落首行 timestamp / now） */
  headerCreatedAt: string | null;
  rows: Array<LegacyRow | LegacyRunSettled>;
  partials: LegacyJournalRow[];
  subcalls: LegacyRow[];
  summary: string | null;
  /** 恒等拷贝面（KNOWN_FILES 以外的文件名） */
  extraFiles: string[];
  marker: boolean;
}

export function readLegacySession(dir: string): LegacySessionFiles {
  const out: LegacySessionFiles = { headerCreatedAt: null, rows: [], partials: [], subcalls: [], summary: null, extraFiles: [], marker: false };
  const mainFile = path.join(dir, 'messages.jsonl');
  if (fs.existsSync(mainFile)) {
    for (const line of fs.readFileSync(mainFile, 'utf-8').split('\n')) {
      if (line.trim() === '') continue;
      if (line.trimStart().startsWith('{"type":"session-header"')) {
        try {
          const h = JSON.parse(line) as { type: string; version?: number; createdAt?: string };
          if (typeof h.createdAt === 'string') out.headerCreatedAt = h.createdAt;
        } catch { /* 坏 header 忽略 */ }
        continue;
      }
      if (line.trimStart().startsWith('{"type":"run-settled"')) {
        out.rows.push(JSON.parse(line) as LegacyRunSettled);
        continue;
      }
      try {
        out.rows.push(JSON.parse(line) as LegacyRow);
      } catch {
        // 坏行保留原文（content = 原始行文本，role 标记坏行——投影面如实处理）
        out.rows.push({ role: 'context', content: line, message_id: '', timestamp: '', source: 'corrupt-line' });
      }
    }
  }
  const partFile = path.join(dir, 'partials.jsonl');
  if (fs.existsSync(partFile)) {
    for (const line of fs.readFileSync(partFile, 'utf-8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.partials.push(JSON.parse(line) as LegacyJournalRow);
      } catch {
        out.partials.push({ content: line, corrupt: true });
      }
    }
  }
  const subFile = path.join(dir, 'subcalls.jsonl');
  if (fs.existsSync(subFile)) {
    for (const line of fs.readFileSync(subFile, 'utf-8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.subcalls.push(JSON.parse(line) as LegacyRow);
      } catch {
        out.subcalls.push({ role: 'context', content: line, message_id: '', timestamp: '', source: 'corrupt-line' });
      }
    }
  }
  const summaryFile = path.join(dir, 'summary.md');
  if (fs.existsSync(summaryFile)) out.summary = fs.readFileSync(summaryFile, 'utf-8');
  for (const entry of fs.readdirSync(dir)) {
    if (entry === '.migrated') { out.marker = true; continue; }
    if (KNOWN_FILES.includes(entry)) continue;
    out.extraFiles.push(entry);
  }
  return out;
}