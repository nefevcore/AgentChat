// ============================================================
// view.ts —— 会话读面视图组装（cr-768 读面优化回填）
//
// 归位数据拥有者 ac-ledger（web-api 传输层只透传参数——cr-95 D2
// 「投影归位」同款裁决的 cutover 后重现）：
//   · assembleSessionView：fold 单源 webui 投影的薄包装（cr-974 起——
//     读方配平与 v1/v2 归一化同源；cr-998 起 parity 夹具退役）；
//   · historyView：跨域 stat 复合指纹（fingerprint 短路判据，原
//     2026-09-19 切换重入优化回填）。
// ============================================================

/**
 * 渲染契约数据行(cr-1110 / docs/design/webui/render-contract.md 方案 A):
 * foldViewRecords 输出的类型化形态——盘上事实 + 确定性派生(bytes),
 * **不含渲染裁决**(通道判定在前端注册表 + 兜底链)。ProjectedStep 先例:
 * 字段即契约。
 */
export interface ViewRow {
  /** 行角色(盘上事实投影):user/assistant 发言;context 注入材料;error 错误;event 机制通知 */
  role: 'user' | 'assistant' | 'context' | 'error' | 'event';
  content: string;
  /** 说话人/归属端点 */
  agent_id?: string;
  /** run 关联键(轨迹联查/拆轮锚) */
  run?: string;
  /** run 墙钟耗时(毫秒,终稿行) */
  runMs?: number;
  /** 行级单调序号 */
  seq?: number;
  /** ReAct 步投影(assistant 终稿行/活投影/盲区行) */
  steps?: import('./records.ts').ProjectedStep[];
  /** 未收束 run 配平标记(仅读侧投影,不落盘) */
  partial?: boolean;
  /** context 行来源决策词(开放——卡片注册 match 键) */
  source?: string;
  /** context 行 UI 文案(与直播帧同源) */
  label?: string;
  /** 结构化载荷(公共数据面,键域随 source 词开放) */
  payload?: unknown;
  /** 注入体字节数(投影派生 content.length——与直播帧定义恒等) */
  bytes?: number;
  message_id?: string;
  requestId?: string;
  timestamp?: string;
  /** 挂靠锚（cr-1132：无 run 锚 context 行携带——时间线上最近后续 agent
   *  发言行 message_id；投影层全会话视野派生，前端据此挂轮不猜） */
  anchor?: string;
}
import * as fs from 'node:fs';
import * as path from 'node:path';
import { conversationDirs } from './manage.ts';
import { foldSession, foldViewRecords } from './fold.ts';
import type { JournalToolResult } from './records.ts';

/** 活跃 run 聚集行（face-ops collectRunning 形状子集） */
export interface RunningEntry {
  agentId: string;
  conversationId: string;
  runId: string | null;
}

export interface SessionViewOptions {
  /** 视图参数化（cr-973，纯函数零存储差异）：lite = steps 超长字段截断
   *  摘要（移动端瘦身）；plain = DSH 式无气泡视图——无气泡是前端渲染
   *  参数，记录面与 chat 同构（服务端等值透传，不另立投影）。 */
  view?: 'chat' | 'plain' | 'lite';
  /** 活壳 run 聚集（journal 活投影门控——runId 精确命中才投在途步） */
  running?: RunningEntry[];
  /** subcall 档案定向读钩子（cr-973 索引辅助）：给该域该 run 的
   *  subcalls.jsonl 行（seek 定位）；undefined = 该域档案未索引 → 调用方
   *  回落全文件读。返回数组（可空）= 已索引，直接采用。 */
  subcallsOf?: (domain: string, run: string) => JournalToolResult[] | undefined;
}

/**
 * 会话读面视图组装（session/history 的投影体）。
 * cr-974（cr-972 第二刀）起 = fold 单源的 webui 投影（fold.ts——读方配平
 * 与 v1/v2 归一化同源；cr-998 起 parity 夹具 assembleSessionViewLegacy
 * 退役——v1 存量文件形态由归一化层直接覆盖）。
 */
export function assembleSessionView(
  dataRoot: string,
  conversationId: string,
  opts: SessionViewOptions = {},
): ViewRow[] {
  return foldViewRecords(foldSession(dataRoot, conversationId), dataRoot, conversationId, {
    ...(opts.view !== undefined ? { view: opts.view } : {}),
    ...(opts.running !== undefined ? { running: opts.running } : {}),
    ...(opts.subcallsOf !== undefined ? { subcallsOf: opts.subcallsOf } : {}),
  });
}

/**
 * 会话视图指纹（fingerprint 短路判据；原 2026-09-19 优化回填，cr-768）：
 * 全部域账本/journal/subcalls 文件的 size:mtimeMs 复合串（域序排序归一
 * ——跨平台 readdir 顺序不定）。append-only 下文件未变 = 读面输入未变；
 * 任何变化（新行/收束/compact 重写）必变 mtime 或 size。
 */
export interface HistoryViewMeta {
  /** agent 域 id 集（投影派生源——不含 'viewer'） */
  domains: string[];
  fingerprint: string;
}

export function historyView(dataRoot: string, conversationId: string): HistoryViewMeta {
  const domains: string[] = [];
  const parts: string[] = [];
  // viewer 域文件也进指纹（replay 的输入——终稿层变化必须使短路失效）；
  // domains（派生源参数）只含 agent 域。
  for (const dir of conversationDirs(dataRoot, conversationId, { includeJournalOnly: true })) {
    const domain = path.basename(path.dirname(path.dirname(dir)));
    if (domain !== 'viewer') domains.push(domain);
    for (const file of [path.join(dir, 'messages.jsonl'), path.join(dir, 'journal', 'partials.jsonl'), path.join(dir, 'subcalls.jsonl')]) {
      try {
        const st = fs.statSync(file);
        parts.push(file + ':' + st.size + ':' + st.mtimeMs);
      } catch { /* 缺席文件不参与 */ }
    }
  }
  return { domains, fingerprint: parts.sort().join('|') };
}
