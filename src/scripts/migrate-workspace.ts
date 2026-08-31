// ============================================================
// preview/scripts/migrate-workspace.ts —— src workspace → preview data 一次性迁移
//
// 用途：把 src 轨道的工作区数据（如 workspace/default）转换成 preview
// 轨道格式，写入目标数据根（AGENTCHAT_DATA_ROOT 给定则用之，缺省
// preview/data/——M18 数据根约定）。
//
// 【M21/D13 中性格式】会话行输出 = preview 中性词表：一切真实发言 =
// role:'agent' + agent_id=说话人端点（src 本就是中性语义——role:'agent'
// + agent_id 直通；user/assistant 旧行归一；trigger → event；error 直通
// 保留归属）+ 会话头行 session-header（v1 即中性）+ 单调 seq 回填。
// 工具调用对重建为 steps[]（刷新后工具卡片不丢）；孤 tool 行保留
// （agent_id=桶缺省说话人，name=工具名，tool_call_id 配对）。
//
// M19 全对键桶模型（D5）：一切双端会话迁移为对桶 sessions/<pairKey(a,b)>：
//   sessions/chat~<a>~<b>/ → sessions/<pairKey(a,b)>/（agent⇄agent 委托桶
//     双向同键；user 只是端点之一）
//   sessions/chat~group__<gid>~<member>/ 与 group~<gid>/
//     → 双写：sessions/<gid>/（会话桶）+ groups/<gid>/messages.jsonl（本体）
//   sessions/single~<sid>/ → sessions/<sid>/（singles 启动后自动上架）
//   归档分段：src sessions/<key>/archive/history_N.jsonl → <root>/archive/
//     <target>/（preview ac-archive 正位——segments/尾锚去重可见）+
//     SUMMARY.md → sessions/<target>/summary.md（compaction 概要头）
//   usage 行 conversationId = pairKey(对方端, agent)（counterpart 推导）；
//     群 gid 原样
//
// 映射表（src → preview，其余域不变）：
//   agents/<id>/config.json  {agent_id,name,llm,system,timer.entries,tags,...}
//     → AgentConfig {id,description,model,system?,tags?...} + timer entry（{entries}）
//     + avatar.* / AGENT.md 原样拷（presets/hooks 不迁——语义不同）
//   config.json 池/全局域（增量合并，marker 之前执行——幂等补齐）
//   singles/<sid>/session.json → 同路径（model 对象形态 → 字符串）
//   groups/<gid>/group.json → {id,members,createdAt}
//   workspaces/<uuid>/workspace.json → workspaces.json 数组
//   files/ 整目录合并拷
//
// 跳过：timer-state.json、.env/凭据（不擅自迁移——preview 凭据住
//   credentials.json 机器绑定库，需另行带迁或经 UI 重设）、memory 域
//   （src 无此目录）、note/plugins（src 专属命名空间）、其余命名空间缺省。
//
// 幂等：data/.migrated-src marker（记录源路径）；已迁移则跳过（--force 重迁）。
// 用法：AGENTCHAT_DATA_ROOT=<目标根> pnpm exec tsx src/scripts/migrate-workspace.ts [源目录=../workspace/preview 相对 src/]
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const force = args.includes('--force');
// 脚本位于 src/scripts/ → DST 缺省 = src/data；AGENTCHAT_DATA_ROOT
// 给定则用之（M18 数据根约定：迁移写到实际数据根）。
// 源缺省 = 仓库根 workspace/preview
const SCRIPTS_DIR = fileURLToPath(new URL('.', import.meta.url)); // …/src/scripts/
const TRACK_DIR = path.resolve(SCRIPTS_DIR, '..');
const DST = process.env.AGENTCHAT_DATA_ROOT
  ? path.resolve(process.env.AGENTCHAT_DATA_ROOT)
  : path.join(TRACK_DIR, 'data');
const srcArg = args.find((a) => !a.startsWith('--'));
const SRC = path.resolve(TRACK_DIR, srcArg ?? '../workspace/preview');
const MARKER = path.join(DST, '.migrated-src');

/** fallback 模型（src 无显式 llm 的 Agent 占位；UI 可显示，设置面板可改） */
const FALLBACK_MODEL = 'deepseek-v4-flash';

if (!fs.existsSync(path.join(SRC, 'sessions'))) {
  console.error(`[migrate] 源不是 src 工作区目录（缺 sessions/）：${SRC}`);
  process.exit(1);
}

// ── 0. config 域增量合并（P1；marker 之前执行——幂等补齐）──
// 池逐条目合并 / 指针与 timer 逐任务合并：preview 侧已有值一律保留
// （UI 编辑优先），只补缺失。池条目不含凭据（密钥住 .env/credentials，
// 本脚本不迁）。重跑安全；批量域（agents/sessions/...）仍受 marker 门。
const configAdded = { pools: 0, pointers: 0, timerTasks: 0 };
{
  const srcConfig = readJson<Record<string, unknown>>(path.join(SRC, 'config.json'));
  if (srcConfig) {
    const dstFile = path.join(DST, 'config.json');
    const dst = readJson<Record<string, unknown>>(dstFile) ?? {};
    let changed = false;

    // 池（llmProviders / searchProviders）：逐条目合并
    for (const key of ['llmProviders', 'searchProviders']) {
      const srcPool = srcConfig[key];
      if (!srcPool || typeof srcPool !== 'object' || Array.isArray(srcPool)) continue;
      const dstPool = { ...((dst[key] ?? {}) as Record<string, unknown>) };
      for (const [name, entry] of Object.entries(srcPool as Record<string, unknown>)) {
        if (dstPool[name] === undefined) {
          dstPool[name] = entry;
          configAdded.pools++;
          changed = true;
        }
      }
      if (Object.keys(dstPool).length > 0) dst[key] = dstPool;
    }

    // 默认指针（llm / tool.web_search）：缺省才写（点路径嵌套）
    const getPtr = (obj: Record<string, unknown>, key: string): unknown =>
      key.split('.').reduce<unknown>((acc, part) => {
        return acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined;
      }, obj);
    const setPtr = (obj: Record<string, unknown>, key: string, value: unknown): void => {
      const parts = key.split('.');
      let cursor = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        const next = cursor[parts[i]];
        if (next === null || typeof next !== 'object' || Array.isArray(next)) cursor[parts[i]] = {};
        cursor[parts[i]] = { ...(cursor[parts[i]] as Record<string, unknown>) };
        cursor = cursor[parts[i]] as Record<string, unknown>;
      }
      cursor[parts[parts.length - 1]] = value;
    };
    for (const key of ['llm', 'tool.web_search']) {
      if (getPtr(dst, key) === undefined && srcConfig[key] !== undefined) {
        setPtr(dst, key, srcConfig[key]);
        configAdded.pointers++;
        changed = true;
      }
    }

    // timer（enabled + tasks 逐任务合并；身份 = time + hint）
    // 任务形状 = src UI 形状（time/hint/targets/builtin）∪ ac-timer
    // configEntries 要求（id/enabled/mode/target）——补齐缺省字段使
    // 迁移任务既在设置面板可显示、又被 timers 服务真实排程。
    const srcTimer = srcConfig.timer;
    if (srcTimer && typeof srcTimer === 'object' && !Array.isArray(srcTimer)) {
      const srcT = srcTimer as { enabled?: unknown; tasks?: unknown };
      const dstTimer = { ...((dst.timer ?? {}) as Record<string, unknown>) };
      if (dstTimer.enabled === undefined && srcT.enabled !== undefined) {
        dstTimer.enabled = srcT.enabled;
        changed = true;
      }
      const taskKey = (t: unknown): string => {
        const e = (t ?? {}) as { time?: unknown; hint?: unknown };
        return `${typeof e.time === 'string' ? e.time : ''}|${typeof e.hint === 'string' ? e.hint.trim() : ''}`;
      };
      const slug = (s: string): string =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'task';
      /** 补缺省字段（不动已有值；time 缺失的 delay 型任务保持原样跳过补 id） */
      const normalizeTask = (t: unknown): unknown => {
        const e = { ...((t ?? {}) as Record<string, unknown>) };
        const time = typeof e.time === 'string' ? e.time : '';
        const hint = typeof e.hint === 'string' ? e.hint : '';
        const targets = Array.isArray(e.targets) ? e.targets.map(String) : [];
        const out = { ...e };
        if ((typeof e.id !== 'string' || e.id === '') && time) {
          out.id = `cfg-${time.replace(':', '')}-${slug(hint)}`;
        }
        if (out.enabled === undefined) out.enabled = true;
        if (typeof e.mode !== 'string') out.mode = 'time';
        if (e.target === undefined) out.target = targets.length ? targets.join(',') : '*';
        return out;
      };
      const srcTasks = Array.isArray(srcT.tasks) ? srcT.tasks : [];
      const dstTasks = Array.isArray(dstTimer.tasks) ? [...(dstTimer.tasks as unknown[])] : [];
      const srcByKey = new Map(srcTasks.map((t) => [taskKey(t), t]));
      const known = new Set(dstTasks.map(taskKey));
      // 升级既有同键任务（补 id/mode/target）+ 追加缺失任务
      const merged = dstTasks.map((t) => {
        const srcTask = srcByKey.get(taskKey(t));
        if (!srcTask) return t; // preview 独有（UI 新建）→ 原样
        const next = normalizeTask(t);
        if (JSON.stringify(next) !== JSON.stringify(t)) configAdded.timerTasks++;
        return next;
      });
      for (const [key, t] of srcByKey) {
        if (!known.has(key)) {
          merged.push(normalizeTask(t));
          configAdded.timerTasks++;
        }
      }
      if (configAdded.timerTasks > 0) changed = true;
      if (merged.length > 0) dstTimer.tasks = merged;
      dst.timer = dstTimer;
    }

    if (changed) {
      fs.mkdirSync(DST, { recursive: true });
      fs.writeFileSync(dstFile, `${JSON.stringify(dst, null, 2)}\n`, 'utf-8');
      console.log(
        `[migrate] config 域增量合并：池条目 +${configAdded.pools}、默认指针 +${configAdded.pointers}、全局定时任务 +${configAdded.timerTasks}`,
      );
    } else {
      console.log('[migrate] config 域无缺失（已是最新）');
    }
  }
}

// ── 0b. tags 增量回填（P6）——preview 档案缺 tags 时从 src 同名 Agent 补 ──
// 只补缺失（已有 tags 数组——含显式空——一律不覆盖），其余字段不动；
// 与 config 域同理走 marker 之前，重跑安全。
{
  const srcAgentsDir = path.join(SRC, 'agents');
  const dstAgentsDir = path.join(DST, 'agents');
  if (fs.existsSync(srcAgentsDir) && fs.existsSync(dstAgentsDir)) {
    let backfilled = 0;
    for (const d of fs.readdirSync(dstAgentsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const srcCfg = readJson<SrcAgentConfig>(path.join(srcAgentsDir, d.name, 'config.json'));
      const tags = Array.isArray(srcCfg?.tags)
        ? srcCfg.tags.filter((t): t is string => typeof t === 'string')
        : [];
      if (tags.length === 0) continue;
      const dstFile = path.join(dstAgentsDir, d.name, 'config.json');
      const dstCfg = readJson<Record<string, unknown>>(dstFile);
      if (!dstCfg || Array.isArray(dstCfg.tags)) continue;
      dstCfg.tags = tags;
      fs.writeFileSync(dstFile, `${JSON.stringify(dstCfg, null, 2)}\n`, 'utf-8');
      backfilled++;
    }
    if (backfilled > 0) console.log(`[migrate] tags 增量回填：${backfilled} 个 Agent`);
  }
}

if (!force && fs.existsSync(MARKER)) {
  console.log(`[migrate] 已迁移过（${fs.readFileSync(MARKER, 'utf-8').trim()}）；--force 重迁（批量域跳过）`);
  process.exit(0);
}
fs.mkdirSync(DST, { recursive: true });

let stats = { agents: 0, sessions: 0, groups: 0, singles: 0, usageLines: 0, workspaces: 0, files: 0 };

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

// ── 1. agents：config.json 字段映射 + timer entry + avatar/AGENT.md ──

interface SrcAgentConfig {
  agent_id: string;
  name?: string;
  llm?: string | { model?: string; $ref?: string; [k: string]: unknown };
  system?: string;
  virtual?: boolean;
  maxSteps?: number;
  tags?: unknown;
  timer?: { entries?: Array<Record<string, unknown>> };
}

function modelOf(llm: SrcAgentConfig['llm']): string {
  if (typeof llm === 'string') return llm;
  if (llm && typeof llm === 'object') {
    if (typeof llm.model === 'string') return llm.model;
    if (typeof llm.$ref === 'string') return llm.$ref;
  }
  return FALLBACK_MODEL;
}

const agentsDir = path.join(SRC, 'agents');
const timerEntryKeys = ['id', 'enabled', 'mode', 'time', 'delay', 'delayMin', 'delayMax', 'repeatCount', 'hint', 'task', 'target', 'source'];

if (fs.existsSync(agentsDir)) {
  for (const d of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const raw = readJson<SrcAgentConfig>(path.join(agentsDir, d.name, 'config.json'));
    if (!raw || typeof raw.agent_id !== 'string') continue;
    const id = raw.agent_id;
    const dstDir = path.join(DST, 'agents', id);
    fs.mkdirSync(dstDir, { recursive: true });

    const config: Record<string, unknown> = {
      id,
      description: raw.name ?? '',
      model: modelOf(raw.llm),
      ...(raw.virtual === true ? { virtual: true } : {}),
      ...(typeof raw.system === 'string' ? { system: raw.system } : {}),
      ...(typeof raw.maxSteps === 'number' ? { maxSteps: raw.maxSteps } : {}),
      // 能力标签（P6）：requires 门禁词表 + UI 徽章；非串元素滤除
      ...(Array.isArray(raw.tags)
        ? { tags: raw.tags.filter((t): t is string => typeof t === 'string') }
        : {}),
    };
    fs.writeFileSync(path.join(dstDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

    // timer entry（字段白名单过滤）
    const entries = (raw.timer?.entries ?? []).map((e) => {
      const out: Record<string, unknown> = {};
      for (const k of timerEntryKeys) if (e[k] !== undefined) out[k] = e[k];
      return out;
    });
    if (entries.length > 0) {
      fs.writeFileSync(path.join(dstDir, 'timer.json'), `${JSON.stringify({ entries }, null, 2)}\n`, 'utf-8');
    }

    // 头像 / AGENT.md（persona 文档）
    for (const f of fs.readdirSync(path.join(agentsDir, d.name))) {
      if (/^avatar\.(png|jpe?g|svg|webp|gif)$/i.test(f) || f === 'AGENT.md') {
        fs.copyFileSync(path.join(agentsDir, d.name, f), path.join(dstDir, f));
      }
    }
    stats.agents++;
  }
}

// ── 2. sessions：键规约转换 + 行格式转换（M19 对桶 × M21 中性格式） ──

interface SrcToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  // src 兼容扁平形
  name?: string;
  arguments?: unknown;
}

interface SrcLine {
  role: string;
  content: string;
  message_id: string;
  agent_id?: string;
  timestamp: string;
  tool_calls?: SrcToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  label?: string;
  name?: string;
  source?: unknown;
}

/** 对键（与后端 pairKey 同款：排序 `~` 连接） */
function pairKey(a: string, b: string): string {
  return [a, b].sort().join('~');
}

/** 会话头行（M21/D8 版本锚点：v1 即中性格式 D13） */
function sessionHeader(): string {
  return JSON.stringify({ type: 'session-header', version: 1, createdAt: new Date().toISOString() });
}

/** src tool_calls（OpenAI 形/扁平形）→ 步记录形（arguments 归一为 JSON 字符串） */
function toStepToolCalls(tcs: SrcToolCall[] | undefined): Array<{ id: string; name: string; arguments: string }> {
  if (!Array.isArray(tcs)) return [];
  return tcs.map((tc) => {
    const name = tc.function?.name ?? tc.name ?? '';
    const args = tc.function?.arguments ?? tc.arguments ?? '{}';
    return {
      id: tc.id ?? `call-mig-${name}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    };
  });
}

/**
 * src 行 → preview 中性 SessionRecord（M21/D13，§2.2-2.3）：
 * · role:'agent' + agent_id → 直通（src 本就是中性语义——真实发言
 *   role:'agent'，归属 agent_id：用户发言 agent_id='user'、Agent 出站
 *   agent_id=<agent>，与 preview 词表同构）
 * · role:'user'/'assistant'（src 远古导入行）→ 归一 role:'agent'，
 *   agent_id = 行内 agent_id ?? (user→'user' / assistant→defaultSpeaker)
 * · role:'trigger' → role:'event'（机制触发的 preview 词表；<trigger>
 *   包裹文本原样保留——历史痕迹非格式词汇）
 * · role:'event' → 直通 + source 归一字符串 'event'（src source 是
 *   {kind,form,summary} 对象——结构化细节不进 preview 诊断字段）
 * · role:'error' → 直通（error 一等行双侧词表一致）
 * · 无 agent_id 的行 → 归属回落 defaultSpeaker（对桶 = Agent 侧端点；
 *   singles = 会话键；群 = 'user'）
 * · assistant/agent 行带 tool_calls → 重建 steps[]（result 从后续 tool
 *   行按 tool_call_id 匹配回填）；reasoning_content 保留（M4：不回传）
 * · tool 孤行（无认领调用）保留 role:'tool' + name=工具名 + tool_call_id
 */
function toRecords(lines: SrcLine[], defaultSpeaker: string): Array<Record<string, unknown>> {
  const toolResultOf = new Map<string, string>();
  for (const l of lines) {
    if (l.role === 'tool' && typeof l.tool_call_id === 'string') {
      if (!toolResultOf.has(l.tool_call_id)) toolResultOf.set(l.tool_call_id, l.content);
    }
  }
  // 被 assistant 行 tool_calls 认领的调用 id（对应 tool 行并入 steps，不再单列）
  const claimedCallIds = new Set<string>();
  for (const l of lines) {
    for (const tc of toStepToolCalls(l.tool_calls)) claimedCallIds.add(tc.id);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    if (typeof line.content !== 'string' || typeof line.message_id !== 'string') continue;
    const speaker = typeof line.agent_id === 'string' && line.agent_id ? line.agent_id : undefined;
    if (line.role === 'tool') {
      // 已并入 steps 的 tool 行跳过；孤行（无认领调用）保留为 tool 行
      if (typeof line.tool_call_id === 'string' && claimedCallIds.has(line.tool_call_id)) continue;
      out.push({
        role: 'tool',
        content: line.content,
        agent_id: speaker ?? defaultSpeaker,
        message_id: line.message_id,
        timestamp: line.timestamp ?? '',
        ...(line.name !== undefined ? { name: line.name } : {}),
        ...(typeof line.tool_call_id === 'string' ? { tool_call_id: line.tool_call_id } : {}),
      });
      continue;
    }
    if (line.role === 'trigger' || line.role === 'event') {
      out.push({
        role: 'event',
        content: line.content,
        agent_id: speaker ?? defaultSpeaker,
        message_id: line.message_id,
        timestamp: line.timestamp ?? '',
        source: 'event',
      });
      continue;
    }
    if (line.role === 'error') {
      out.push({
        role: 'error',
        content: line.content,
        agent_id: speaker ?? defaultSpeaker,
        message_id: line.message_id,
        timestamp: line.timestamp ?? '',
        source: 'error',
      });
      continue;
    }
    // 真实发言（agent 直通 / user·assistant 远古行归一）
    const agentId =
      speaker ??
      (line.role === 'user' ? 'user' : line.role === 'assistant' ? defaultSpeaker : defaultSpeaker);
    const record: Record<string, unknown> = {
      role: 'agent',
      content: line.content,
      agent_id: agentId,
      message_id: line.message_id,
      timestamp: line.timestamp ?? '',
    };
    const stepCalls = toStepToolCalls(line.tool_calls);
    if (stepCalls.length > 0 || (line.reasoning_content ?? '') !== '') {
      record.steps = [
        {
          content: line.content,
          ...(line.reasoning_content ? { reasoning: line.reasoning_content } : {}),
          ...(stepCalls.length > 0
            ? {
                toolCalls: stepCalls.map((tc) => ({
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.arguments,
                  result: tryJson(toolResultOf.get(tc.id) ?? null),
                })),
              }
            : {}),
        },
      ];
      if (line.reasoning_content) record.reasoning_content = line.reasoning_content;
    }
    out.push(record);
  }
  return out;
}

/** 工具结果原文 → 尽力 JSON 还原（ToolResult 对象语义；失败保留原文） */
function tryJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 读 src 会话目录全部消息行（含在途 messages.jsonl） */
function readSrcLines(dir: string): SrcLine[] {
  const file = path.join(dir, 'messages.jsonl');
  if (!fs.existsSync(file)) return [];
  const out: SrcLine[] = [];
  for (const l of fs.readFileSync(file, 'utf-8').split('\n')) {
    const t = l.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as SrcLine);
    } catch {
      /* 跳过损坏行 */
    }
  }
  return out;
}

/** 写群本体行（GroupMessageRecord 形状不变——与运行时 ac-group 同款，无头行/seq） */
function writeLines(file: string, lines: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

/** 写会话桶（M21：头行 + 单调 seq + 中性行） */
function writeSessionLines(file: string, records: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = records.map((r, i) => JSON.stringify({ seq: i + 1, ...r }));
  fs.writeFileSync(file, [sessionHeader(), ...rows].join('\n') + '\n', 'utf-8');
}

/** 群会话累积（D11 统一布局）：三源合并 → Map<gid, Map<message_id, Row>> */
const groupAcc = new Map<string, Map<string, Record<string, unknown>>>();

/** 群行归一入累积器（去重按 message_id；hint 包装行跳过——本体发言的重复投递形态） */
function ingestGroupRows(gid: string, records: Array<Record<string, unknown>>): void {
  let acc = groupAcc.get(gid);
  if (!acc) {
    acc = new Map();
    groupAcc.set(gid, acc);
  }
  for (const r of records) {
    if (typeof r.content === 'string' && r.content.startsWith('<msg ')) continue;
    if (typeof r.message_id === 'string' && r.message_id && !acc.has(r.message_id)) acc.set(r.message_id, r);
  }
}

/** 旧本体行（GroupMessageRecord）→ 中性行（D11：本体即 sessions 桶） */
function bodyRows(lines: SrcLine[]): Array<Record<string, unknown>> {
  return lines
    .filter((l) => typeof l.content === 'string' && typeof l.message_id === 'string' && l.role !== 'tool')
    .map((l) => ({
      role: 'agent',
      content: l.content,
      agent_id: l.agent_id ?? 'user',
      message_id: l.message_id,
      timestamp: l.timestamp ?? new Date(Date.parse(l.timestamp) || 0).toISOString(),
    }));
}

const groupIds = new Set<string>(
  fs.existsSync(path.join(SRC, 'groups'))
    ? fs.readdirSync(path.join(SRC, 'groups'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [],
);

// ── shelf 基础设施（D11 归位：sessions/groups/ + sessions/singles/<ws>/）──
const shelves: Record<string, string> = {};
{
  const shelvesFile = path.join(DST, 'sessions', '.shelves.json');
  if (fs.existsSync(shelvesFile)) {
    try {
      Object.assign(shelves, JSON.parse(fs.readFileSync(shelvesFile, 'utf-8')) as Record<string, string>);
    } catch {
      /* 损坏按空处理 */
    }
  }
}
function putShelfMarker(shelfRoot: string): void {
  fs.mkdirSync(shelfRoot, { recursive: true });
  const marker = path.join(shelfRoot, '.shelf');
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
}

/** sid → 工作区分层（singles/<sid>/session.json 的 workspaceId；缺省 ungrouped） */
function singlesWorkspaceOf(sid: string): string {
  const meta = readJson<Record<string, unknown>>(path.join(SRC, 'singles', sid, 'session.json'));
  return typeof meta?.workspaceId === 'string' && meta.workspaceId ? meta.workspaceId : 'ungrouped';
}
const singleShelves = new Map<string, string>();

/** src agents 扫描收集的 Agent id 集（对桶缺省说话人推导用） */
const srcAgentIds = new Set<string>(
  fs.existsSync(path.join(SRC, 'agents'))
    ? fs.readdirSync(path.join(SRC, 'agents'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [],
);

/**
 * 对桶缺省说话人（无 agent_id 行的归属回落，§2.3）：
 * user⇄agent → Agent 侧；agent⇄agent → 注册 Agent 侧（首个命中）；
 * 推不出 → 会话键（与 migrate-session-neutral 的 assistant 缺名回落同款）。
 */
function pairDefaultSpeaker(a: string, b: string): string {
  if (a !== 'user' && srcAgentIds.has(a)) return a;
  if (b !== 'user' && srcAgentIds.has(b)) return b;
  if (a !== 'user') return a;
  if (b !== 'user') return b;
  return pairKey(a, b);
}

let pairBuckets = 0;
const sessionsDir = path.join(SRC, 'sessions');
for (const d of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const key = d.name;
  const dir = path.join(sessionsDir, key);
  const lines = readSrcLines(dir);

  let target: string | null = null;
  let defaultSpeaker = '';
  let groupWrite = false;
  if (key.startsWith('group~')) {
    groupWrite = true;
    target = key.slice('group~'.length);
    defaultSpeaker = 'user';
  } else if (key.startsWith('chat~group__')) {
    // src 群成员会话（chat~group__<gid>~<member>）：群本体 + 会话桶同键
    groupWrite = true;
    target = key.split('~')[1]!.slice('group__'.length);
    defaultSpeaker = 'user';
  } else if (key.startsWith('chat~')) {
    const parts = key.split('~').slice(1); // [a, b]
    if (parts.length === 2 && parts[0] && parts[1]) {
      if (groupIds.has(parts[0]) || groupIds.has(parts[1])) {
        // src 早期键形 chat~<gid>~<member>：群视角桶（并入群累积器）
        groupWrite = true;
        target = groupIds.has(parts[0]) ? parts[0] : parts[1];
        defaultSpeaker = 'user';
      } else {
        // M19：一切双端会话（user⇄agent / agent⇄agent / a~a 自会话）→ 对桶
        target = pairKey(parts[0], parts[1]);
        defaultSpeaker = pairDefaultSpeaker(parts[0], parts[1]);
      }
    }
  } else if (key.startsWith('single~')) {
    target = key.slice('single~'.length);
    defaultSpeaker = target; // singles：会话键兜底（同 migrate-session-neutral）
    // D11 归位：会话桶直接落 sessions/singles/<ws|ungrouped>/<sid>/（上架）
    singleShelves.set(target, singlesWorkspaceOf(target));
  }
  if (!target) continue; // legacy 键：跳过

  if (groupWrite) {
    // D11 统一布局：本体行（无包装直取）+ 视角行（toRecords 归一，包装行由
    // ingestGroupRows 跳过）并入累积器——最终统一写 sessions/groups/<gid>/
    ingestGroupRows(target, bodyRows(lines));
    ingestGroupRows(target, toRecords(lines, 'user'));
    stats.groups++;
    continue;
  }

  const records = toRecords(lines, defaultSpeaker);
  if (records.length > 0) {
    const singleShelf = singleShelves.get(target);
    if (singleShelf !== undefined) {
      putShelfMarker(path.join(DST, 'sessions', 'singles'));
      writeSessionLines(
        path.join(DST, 'sessions', 'singles', singleShelf, target, 'messages.jsonl'),
        records,
      );
      shelves[target] = `singles/${singleShelf}`;
    } else {
      writeSessionLines(path.join(DST, 'sessions', target, 'messages.jsonl'), records);
    }
  }

  // 归档分段正位（M21）：src archive/history_N.jsonl → <root>/archive/<target>/
  // （preview ac-archive 的 conversationDir——segments()/尾锚去重直接可见）
  // + 末段末行锚 sidecar（messageId；readLastArchived 零解析路径）
  // + SUMMARY.md（src 位于 archive/SUMMARY.md；会话根兜底）→
  //   sessions/<target>/summary.md（compaction 概要头——history() 注入）
  const archiveDir = path.join(dir, 'archive');
  if (fs.existsSync(archiveDir)) {
    const dstArchiveDir = path.join(DST, 'archive', target);
    const segments = fs
      .readdirSync(archiveDir)
      .filter((f) => /^history_\d+\.jsonl$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    for (const seg of segments) {
      fs.mkdirSync(dstArchiveDir, { recursive: true });
      fs.copyFileSync(path.join(archiveDir, seg), path.join(dstArchiveDir, seg));
    }
    if (segments.length > 0) {
      // 末段末行锚（旧格式无 seq——messageId 锚；readLastArchived 优先消费）
      const lastSeg = path.join(archiveDir, segments[segments.length - 1]);
      const text = fs.readFileSync(lastSeg, 'utf-8').trimEnd();
      const lastLine = text.slice(text.lastIndexOf('\n') + 1);
      try {
        const last = JSON.parse(lastLine) as { message_id?: string };
        fs.mkdirSync(dstArchiveDir, { recursive: true });
        fs.writeFileSync(
          path.join(dstArchiveDir, '.anchor.json'),
          JSON.stringify({ conversationId: target, ...(last.message_id ? { messageId: last.message_id } : {}) }),
          'utf-8',
        );
      } catch {
        /* 末行损坏 → 留给运行时尾读兜底 */
      }
    }
  }
  const summary =
    (fs.existsSync(archiveDir) && fs.existsSync(path.join(archiveDir, 'SUMMARY.md'))
      ? path.join(archiveDir, 'SUMMARY.md')
      : fs.existsSync(path.join(dir, 'SUMMARY.md'))
        ? path.join(dir, 'SUMMARY.md')
        : null);
  if (summary) {
    fs.mkdirSync(path.join(DST, 'sessions', target), { recursive: true });
    fs.copyFileSync(summary, path.join(DST, 'sessions', target, 'summary.md'));
  }

  if (target.includes('~')) pairBuckets++;
  stats.sessions++;
}
if (pairBuckets > 0) console.log(`[migrate] 对桶会话（M19 pairKey）：${pairBuckets} 个`);

// ── 2b. 群本体统一落位（D11）：sessions/groups/<gid>/（shelf 上架）──
// 合并行按时间排序 + 单调 seq；无本体文件（groups/<gid>/ 只剩名册）。
for (const [gid, acc] of groupAcc) {
  const rows = [...acc.values()].sort((a, b) =>
    Date.parse(String(a.timestamp)) - Date.parse(String(b.timestamp)) || (String(a.message_id) < String(b.message_id) ? -1 : 1),
  );
  putShelfMarker(path.join(DST, 'sessions', 'groups'));
  writeSessionLines(
    path.join(DST, 'sessions', 'groups', gid, 'messages.jsonl'),
    rows.map((r, i) => ({ ...r, seq: i + 1 })),
  );
  shelves[gid] = 'groups';
}

// ── 3. groups 名册：group.json 字段映射 ──

const srcGroupsDir = path.join(SRC, 'groups');
if (fs.existsSync(srcGroupsDir)) {
  for (const d of fs.readdirSync(srcGroupsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const raw = readJson<Record<string, unknown>>(path.join(srcGroupsDir, d.name, 'group.json'));
    if (!raw || typeof raw.group_id !== 'string') continue;
    const g = {
      id: raw.group_id,
      name: typeof raw.name === 'string' ? raw.name : raw.group_id,
      members: Array.isArray(raw.participants) ? raw.participants.map(String) : [],
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      createdAt: typeof raw.created_at === 'number' ? raw.created_at : 0,
    };
    const dstDir = path.join(DST, 'groups', g.id);
    fs.mkdirSync(dstDir, { recursive: true });
    fs.writeFileSync(path.join(dstDir, 'group.json'), `${JSON.stringify(g, null, 2)}\n`, 'utf-8');
  }
}

// ── 4. singles 元数据：model 对象形态 → 字符串 ──

const singlesDir = path.join(SRC, 'singles');
if (fs.existsSync(singlesDir)) {
  for (const d of fs.readdirSync(singlesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const raw = readJson<Record<string, unknown>>(path.join(singlesDir, d.name, 'session.json'));
    if (!raw || typeof raw.id !== 'string') continue;
    const meta = { ...raw };
    if (meta.model !== undefined && typeof meta.model !== 'string') {
      const m = meta.model as { model?: string; $ref?: string };
      meta.model = typeof m.model === 'string' ? m.model : typeof m.$ref === 'string' ? m.$ref : undefined;
      if (meta.model === undefined) delete meta.model;
    }
    const dstDir = path.join(DST, 'singles', raw.id);
    fs.mkdirSync(dstDir, { recursive: true });
    fs.writeFileSync(path.join(dstDir, 'session.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
    stats.singles++;
  }
}

// ── 5. usage：token_<date>.jsonl → usage-<date>.jsonl（UsageAuditLine） ──

interface SrcUsageLine {
  timestamp: string;
  agent: string;
  counterpart?: string;
  model: string;
  react_steps?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  accumulated_prompt_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

const usageDir = path.join(SRC, 'usage');
if (fs.existsSync(usageDir)) {
  for (const f of fs.readdirSync(usageDir)) {
    const m = /^token_(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (!m) continue;
    const outLines: string[] = [];
    for (const l of fs.readFileSync(path.join(usageDir, f), 'utf-8').split('\n')) {
      const t = l.trim();
      if (!t) continue;
      const src = readJson<SrcUsageLine>('') ?? (JSON.parse(t) as SrcUsageLine);
      // M19 对桶：counterpart 推导端点对（user 直答 / agent 委托 / 自会话）；
      // 群 gid 原样
      let convId: string;
      if (src.counterpart && groupIds.has(src.counterpart)) {
        convId = src.counterpart;
      } else if (src.counterpart && src.counterpart !== 'user' && src.counterpart !== src.agent) {
        convId = pairKey(src.counterpart, src.agent);
      } else if (src.counterpart && src.counterpart === src.agent) {
        convId = pairKey(src.agent, src.agent);
      } else {
        convId = pairKey('user', src.agent);
      }
      const line = {
        timestamp: src.timestamp,
        agent: src.agent,
        model: src.model,
        finish: 'stop',
        usage: {
          prompt: src.prompt_tokens ?? 0,
          completion: src.completion_tokens ?? 0,
          total: src.total_tokens ?? 0,
          promptAccumulated: src.accumulated_prompt_tokens ?? 0,
          steps: src.react_steps ?? 0,
          ...(src.prompt_cache_hit_tokens !== undefined ? { cacheHit: src.prompt_cache_hit_tokens } : {}),
          ...(src.prompt_cache_miss_tokens !== undefined ? { cacheMiss: src.prompt_cache_miss_tokens } : {}),
        },
        conversationId: convId,
      };
      outLines.push(JSON.stringify(line));
      stats.usageLines++;
    }
    if (outLines.length > 0) {
      const dstFile = path.join(DST, 'usage', `usage-${m[1]}.jsonl`);
      fs.mkdirSync(path.dirname(dstFile), { recursive: true });
      // 追加式（同日已有 preview 流水则续写）
      fs.appendFileSync(dstFile, outLines.join('\n') + '\n', 'utf-8');
    }
  }
}

// ── 6. workspaces：分散登记 → workspaces.json 数组 ──

const wsDir = path.join(SRC, 'workspaces');
if (fs.existsSync(wsDir)) {
  const list: Array<Record<string, unknown>> = [];
  for (const d of fs.readdirSync(wsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const raw = readJson<Record<string, unknown>>(path.join(wsDir, d.name, 'workspace.json'));
    if (raw && typeof raw.id === 'string') list.push(raw);
  }
  const dstFile = path.join(DST, 'workspaces.json');
  const existing = readJson<Array<Record<string, unknown>>>(dstFile) ?? [];
  const merged = [...existing, ...list.filter((w) => !existing.some((e) => e.id === w.id))];
  fs.writeFileSync(dstFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
  stats.workspaces = list.length;
}

// ── 7. files：整目录合并（布局两轨一致） ──

const filesDir = path.join(SRC, 'files');
if (fs.existsSync(filesDir)) {
  fs.cpSync(filesDir, path.join(DST, 'files'), { recursive: true });
  stats.files = 1;
}

// ── 7b. shelf 索引落盘（D11：sessions/groups + sessions/singles/<ws>）──
if (Object.keys(shelves).length > 0) {
  fs.mkdirSync(path.join(DST, 'sessions'), { recursive: true });
  const tmp = `${path.join(DST, 'sessions', '.shelves.json')}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(shelves, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, path.join(DST, 'sessions', '.shelves.json'));
}

fs.writeFileSync(MARKER, `${SRC} @ ${new Date().toISOString()}\n`, 'utf-8');
console.log(
  `[migrate] 完成：agents=${stats.agents} sessions=${stats.sessions} groups=${stats.groups} ` +
    `singles=${stats.singles} usageLines=${stats.usageLines} workspaces=${stats.workspaces} files=merged`,
);
console.log(`[migrate] 源=${SRC} → 目标=${DST}`);
