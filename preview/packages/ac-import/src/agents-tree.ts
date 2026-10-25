// ============================================================
// agents-tree.ts —— B 段 agents 树域迁移（cr-540 遗留④ + cr-547）
//
// 旧形态（主线 ac-agent-store）：agents/<id>/ 扁平混居——config.json /
// todo.json / timer.json …（机制 entries）与 AGENTS.md / avatar.*（身份
// 文档）同层。新形态（D4.1 + cr-540 布局单源）：机制 entries 归拢
// entries/<key>.json，身份文件留树根。旧键归一：见 KEY_ALIASES。
//
// tags → tools 换轨（〈tag 机制解体〉七职能①：行装载信号归行集派生）：
// 旧 tags 是 requiredTags AND 门禁词表（装载词 + 档位词 + 行内档位词
// 混居）；新词形 = tools: [行引用 ∨ 工具名]（A10）。换轨规则：
//   · 装载词 → 行引用（数据驱动：TAG_TO_ROWS 快照表——主线 requiredTags
//     实况 2026-10-19 扫描；真实数据根 tags 词频全对账，无未映射词）
//   · 档位词（full-access / sandbox-access / tc-programmatic / tc-none）
//     → 留 tags（tierOf / toolModeOf 消费面在，词汇非装载面）
//   · 行内档位词（web observe/manipulate/inject、collab admin、dev）
//     → settings 行内档位（七职能③行自治词汇）——browser 行档位走
//     settings.browser，collab admin 走 settings.collab
//   · model/provider 原样保留（null = 显式无模型——不物化默认连接）
//
// 迁移三性质（R-10 同承）：旧根只读；目标已存在 = 幂等跳过（不静默
// 覆盖）；恒等拷贝面 = 身份文档与头像逐字节 copyFile。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathSegment } from './writer.ts';

/** 机制 entries 旧文件名 → 新键名（旧键归一——cr-540「旧键归一」项） */
const ENTRY_ALIASES: Record<string, string> = {
  // 主线扁平键与新键一致（todo.json / timer.json / goal.json /
  // timer-archive.json）——无更名实例；别名表留空作归一锚点，旧键
  // hooks/conductor 归一进 entries 时在此登记。
};

/** 身份文件（树根留驻——非机制 entries）：文档双名 + 头像扩展名族 */
const IDENTITY_FILES = [/^AGENTS?\.md$/i, /^avatar\.(svg|png|jpe?g)$/i];

/** 机制 entries 键（新布局 entries/<key>.json 的 key 全集——旧扁平文件白名单） */
const ENTRY_KEYS = ['todo', 'timer', 'goal', 'timer-archive'];

/**
 * 旧 tags 装载词 → shell 行引用（cr-547 数据驱动快照——主线 requiredTags
 * 实况扫描 2026-10-19 + 真实数据根词频对账）。词不在表 = 非装载词。
 */
const TAG_TO_ROWS = new Map<string, readonly string[]>([
  ['shell', ['shell-tools']],
  ['delegation', ['harness-tools']],
  ['sap-adt', ['sap-adt']],
  ['fs', ['fs-tools', 'fs-search']],
  ['memory', ['memory']],
  ['history', ['session-query']],
  ['collab', ['collab-tools']],
  ['infra', ['math', 'skill', 'todo', 'goal', 'datetime', 'ask-questions']],
  ['web', ['web-tools']],
  ['fs_minimal', ['str-replace-editor']],
  ['issue-report', ['issue-tools']],
  ['harness', ['harness-tools']],
]);

/** 档位词（tierOf / toolModeOf 消费——留 tags） */
const TIER_TAGS = new Set(['full-access', 'sandbox-access', 'tc-programmatic', 'tc-none', 'tc-base']);

/** 行内档位词 → settings 键（七职能③：行自治词汇归 settings） */
const ROW_LEVEL_TAGS = new Map<string, { settingsKey: string; value: string }>([
  ['observe', { settingsKey: 'browser', value: 'observe' }],
  ['manipulate', { settingsKey: 'browser', value: 'manipulate' }],
  ['inject', { settingsKey: 'browser', value: 'inject' }],
  ['dev', { settingsKey: 'dev-tools', value: 'enabled' }],
  ['admin', { settingsKey: 'collab', value: 'admin' }],
]);

/**
 * 单 agent config 换轨（纯函数——tags→tools + 行内档位→settings）。
 * tags 装载词展开为行引用并入 rows（旧 tools/rows 均缺席 = 行集全集
 * 语义 → 换轨后 rows = 装载行集，档位词留 tags；◐b cr-691 输出恒 rows
 * 键）。未知词 fail-loud（不静默丢弃——映射表漂移即中止）。
 */
export function convertConfig(agentId: string, old: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...old };
  const tags = Array.isArray(old.tags) ? old.tags as string[] : [];
  const rows: string[] = [];
  const keepTags: string[] = [];
  const settingsPatch: Record<string, Record<string, unknown>> = {};
  const unknown: string[] = [];
  for (const t of tags) {
    const rowList = TAG_TO_ROWS.get(t);
    if (rowList !== undefined) { for (const r of rowList) if (!rows.includes(r)) rows.push(r); continue; }
    if (TIER_TAGS.has(t)) { keepTags.push(t); continue; }
    const level = ROW_LEVEL_TAGS.get(t);
    if (level !== undefined) {
      const cur = settingsPatch[level.settingsKey] ?? {};
      cur[level.value] = true;
      settingsPatch[level.settingsKey] = cur;
      continue;
    }
    unknown.push(t);
  }
  if (unknown.length > 0) throw new Error('tags 装载词换轨失败 [' + agentId + ']：未知词 ' + unknown.join(',') + '——映射表须扩（fail-loud）');
  // 旧 tools/rows 均缺席 = 全集语义；换轨后 rows = 装载行集（点名单）。
  // 旧 tools 在场（legacy 主线形态）= 与装载行并集后落 rows 键。
  if (old.tools === undefined && old.rows === undefined) {
    if (rows.length > 0) out.rows = rows;
  } else {
    const prior = Array.isArray(old.rows) ? old.rows : Array.isArray(old.tools) ? (old.tools as string[]) : [];
    if (rows.length > 0 || prior.length > 0) out.rows = [...new Set([...prior, ...rows])];
    else delete out.rows;
  }
  // 档位词只剩 tier 轴（空 = 删键——tags 非必填）
  if (keepTags.length > 0) out.tags = keepTags; else delete out.tags;
  // 行内档位归 settings（与既有 settings 深合并——旧值优先（用户配置））
  if (Object.keys(settingsPatch).length > 0) {
    const oldSettings = (old.settings ?? {}) as Record<string, unknown>;
    out.settings = { ...settingsPatch, ...oldSettings };
  }
  return out;
}

/** 单 agent 树迁移结果 */
export interface AgentTreeResult {
  agentId: string;
  configConverted: boolean;
  entriesMoved: number;
  identityFilesCopied: number;
}

/**
 * 单 agent 树迁移：旧 agents/<id>/ 扁平混居 → 新 config.json +
 * entries/<key>.json + 身份文件树根留驻。旧根只读（copyFile）；目标
 * config 已存在 = 幂等跳过（reimport 不改写——用户后续编辑优先）。
 */
export function importAgentTree(legacyAgentDir: string, targetRoot: string): AgentTreeResult {
  const dirName = path.basename(legacyAgentDir);
  const targetDir = path.join(targetRoot, 'agents', pathSegment(dirName));
  const result: AgentTreeResult = { agentId: dirName, configConverted: false, entriesMoved: 0, identityFilesCopied: 0 };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(legacyAgentDir, { withFileTypes: true });
  } catch {
    return result; // 空目录/不可读——无迁移面
  }
  // ① config 换轨（目标已存在 = 幂等跳过）
  const configFile = path.join(legacyAgentDir, 'config.json');
  if (fs.existsSync(configFile)) {
    const targetConfig = path.join(targetDir, 'config.json');
    if (!fs.existsSync(targetConfig)) {
      const old = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
      const converted = convertConfig(dirName, old);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetConfig, JSON.stringify(converted, null, 2) + '\n', 'utf-8');
      result.configConverted = true;
    }
  }
  // ② 机制 entries 归拢（旧扁平 <key>.json → entries/<key>.json；幂等跳过）
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = e.name.match(/^(.+)\.json$/);
    if (m === null) continue;
    const key = ENTRY_ALIASES[m[1]] ?? m[1];
    if (!ENTRY_KEYS.includes(key)) continue;
    const target = path.join(targetDir, 'entries', key + '.json');
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(legacyAgentDir, e.name), target);
    result.entriesMoved++;
  }
  // ③ 身份文件恒等拷贝（文档双名 + 头像——树根留驻；幂等跳过）
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!IDENTITY_FILES.some((re) => re.test(e.name))) continue;
    const target = path.join(targetDir, e.name);
    if (fs.existsSync(target)) continue;
    fs.copyFileSync(path.join(legacyAgentDir, e.name), target);
    result.identityFilesCopied++;
  }
  return result;
}

/**
 * agents 树域全量迁移（旧 <legacyRoot>/agents/ → 新 <targetRoot>/agents/）。
 * 无 config.json 的目录（会话-only 域）不建 config——壳 boot 读 config 失败
 * = 未注册语义，会话账本照常回放（历史 agent 保留账本不保留身份是既定
 * 语义：账本身份键 = 端点，与 config 在场无关）。
 */
export function importAgentsTree(legacyRoot: string, targetRoot: string): AgentTreeResult[] {
  const legacyAgents = path.join(legacyRoot, 'agents');
  if (!fs.existsSync(legacyAgents)) return [];
  const out: AgentTreeResult[] = [];
  for (const e of fs.readdirSync(legacyAgents, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    out.push(importAgentTree(path.join(legacyAgents, e.name), targetRoot));
  }
  return out;
}