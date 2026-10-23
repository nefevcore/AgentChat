// ============================================================
// manage.ts —— 会话账本的管理面改写（cr-566）
//
// 与 append 主链分工：writer 串行队列只追加尾部新行；这里是「按 message_id
// 定位 → 原子重写整个 messages.jsonl」——服务 UI 的显式裁断（删消息 / 行内
// 编辑截断 / 会话分支拷贝）。
//
// 物理布局（D4 端点轴）两侧各自持账本：
//   users/user/sessions/<conversationId>/messages.jsonl   user 终稿投影
//   agents/<agentId>/sessions/<conversationId>/messages.jsonl  agent 域账本
// 一次用户动作对「该会话的全部账本」生效（否则对端仍记得被删的行）。
//
// 竞态边界：在途 run 的追加只落尾部新行，重写窗口内到达的行会随重写丢失——
// 管理面动作本就是用户显式裁断（主线 truncateAfter 同语义），不做锁。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

const MESSAGES_FILE = 'messages.jsonl';
const USER_SESSIONS = ['users', 'user', 'sessions'];

/** 某会话在数据根内的全部账本目录（存在的才算；agent 侧按 agents/<agentId>/sessions/<id> 扫描） */
export function conversationDirs(dataRoot: string, conversationId: string): string[] {
  if (!isSafeId(conversationId)) throw new Error('conversationId "' + conversationId + '" 非法（禁路径分隔 / ..）');
  const out: string[] = [];
  const userDir = path.join(dataRoot, ...USER_SESSIONS, conversationId);
  if (fs.existsSync(path.join(userDir, MESSAGES_FILE))) out.push(userDir);
  let agents: fs.Dirent[] = [];
  try { agents = fs.readdirSync(path.join(dataRoot, 'agents'), { withFileTypes: true }); } catch { /* 无 agents 域 */ }
  for (const a of agents) {
    if (!a.isDirectory()) continue;
    const dir = path.join(dataRoot, 'agents', a.name, 'sessions', conversationId);
    if (fs.existsSync(path.join(dir, MESSAGES_FILE))) out.push(dir);
  }
  return out;
}

function isSafeId(id: string): boolean {
  return id !== '' && !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

/** 一行 JSON 的解析（坏行原样保留——不静默丢用户数据） */
type Row = Record<string, unknown>;
interface Line { raw: string; row: Row | null }

function readLines(dir: string): Line[] {
  let text: string;
  try { text = fs.readFileSync(path.join(dir, MESSAGES_FILE), 'utf-8'); } catch { return []; }
  const out: Line[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let row: Row | null = null;
    try { const parsed: unknown = JSON.parse(raw); if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) row = parsed as Row; } catch { /* 坏行保留 */ }
    out.push({ raw, row });
  }
  return out;
}

function writeLines(dir: string, lines: Line[]): void {
  const file = path.join(dir, MESSAGES_FILE);
  if (lines.length === 0) { fs.rmSync(file, { force: true }); return; }
  const body = lines.map((l) => l.raw).join('\n') + '\n';
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, file);
}

/** 行是否命中给定 id（message_id 优先；兼容 requestId —— 前端 persistedMsgId 两种都可能是） */
function hits(line: Line, messageId: string): boolean {
  if (line.row === null) return false;
  return line.row.message_id === messageId || line.row.requestId === messageId;
}

const isHeader = (line: Line): boolean => line.row?.type === 'session-header';

/** 截断：删掉命中行及其后全部行（表头保留）；返回删除行数（0 = 未命中） */
export function truncateConversation(dir: string, messageId: string): number {
  const lines = readLines(dir);
  const at = lines.findIndex((l) => hits(l, messageId));
  if (at < 0) return 0;
  const kept = lines.slice(0, at);
  const headers = kept.filter(isHeader);
  const rows = kept.filter((l) => !isHeader(l));
  const removed = lines.length - kept.length;
  writeLines(dir, [...headers, ...rows]);
  return removed;
}

/** 单行删除（表头与其余行保留）；返回删除行数 */
export function deleteConversationRow(dir: string, messageId: string): number {
  const lines = readLines(dir);
  const kept = lines.filter((l) => !hits(l, messageId));
  const removed = lines.length - kept.length;
  if (removed > 0) writeLines(dir, kept);
  return removed;
}

/**
 * 分支拷贝：复制表头 + 锚点行（含）之前的全部行到新会话目录。
 * anchor 缺省/空 = 到最新一条（全量复制）；锚点未命中 → 抛错（不静默全量复制）。
 * 返回复制的消息行数（不含表头）。
 */
export function forkConversation(fromDir: string, toDir: string, anchorMessageId?: string): number {
  const lines = readLines(fromDir);
  const headers = lines.filter(isHeader);
  const rows = lines.filter((l) => !isHeader(l));
  let picked = rows;
  if (anchorMessageId !== undefined && anchorMessageId !== '') {
    const at = rows.findIndex((l) => hits(l, anchorMessageId));
    if (at < 0) throw new Error('锚点消息未命中：' + anchorMessageId);
    picked = rows.slice(0, at + 1);
  }
  fs.mkdirSync(toDir, { recursive: true });
  writeLines(toDir, [...headers, ...picked]);
  return picked.length;
}
