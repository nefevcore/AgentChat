// ============================================================
// ac-bench/src/suites/bfcl.ts —— BFCL 单轮套件适配器
//
// 把 Berkeley Function Calling Leaderboard 单轮类目（simple/multiple/
// parallel/parallel-multiple/java/javascript/…）翻译成中性 BenchCase：
//   · question —— v3 消息列表（含嵌套轮次）或 v1 内嵌函数文档的整串；
//   · function —— 工具表：v3 裸 {name,description,parameters}、
//     OpenAI 包装 {type:'function',function:{…}} 或 JSON 字符串均可；
//   · ground_truth / answer —— v1 调用串列表（"func(a=1)"）或
//     v3 结构化列表（[{func: {参数: [可接受值…]}}]）；
//   · 答案分离形态（v3 官方 possible_answer/ 文件）经 answerFiles
//     按 id join。
// 数据下载（gorilla 仓库）：
//   curl -L -o BFCL_v3_simple.json \
//     https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/data/BFCL_v3_simple.json
//   curl -L -o BFCL_v3_simple.answer.json \
//     https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/data/possible_answer/BFCL_v3_simple.json
//   pnpm bench --file BFCL_v3_simple.json --answers BFCL_v3_simple.answer.json --model …
// ============================================================
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BenchCallSpec, BenchCase, BenchSuite, BenchToolDef } from '../contract.ts';
import { parseCallString } from '../eval.ts';

/** 内置样例数据集（包内锚定，不受 cwd 影响） */
export const DEFAULT_BFCL_SAMPLE = fileURLToPath(new URL('../../data/bfcl-sample.json', import.meta.url));

export interface BfclSuiteOptions {
  /** 题目文件（JSON 数组或 JSONL；缺省 = 内置样例） */
  files?: string[];
  /** 答案文件（possible_answer/ 形态，按 id join；缺省用题目内联答案） */
  answerFiles?: string[];
}

interface RawQuestion {
  id?: number | string;
  question?: unknown;
  function?: unknown;
  answer?: unknown;
  ground_truth?: unknown;
}

interface RawAnswer {
  id?: number | string;
  ground_truth?: unknown;
}

/** 读文件 → 原始条目数组（JSON 数组或 JSONL 双形态） */
function readEntries(file: string): Array<Record<string, unknown>> {
  const text = fs.readFileSync(file, 'utf-8').trim();
  if (!text) return [];
  try {
    const whole = JSON.parse(text) as unknown;
    if (Array.isArray(whole)) return whole.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');
    if (whole && typeof whole === 'object') return [whole as Record<string, unknown>];
  } catch {
    // 落到 JSONL
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as unknown;
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
    } catch {
      // 坏行跳过（JSONL 混杂注释/空行容错）
    }
  }
  return out;
}

/** 消息列表展平（v3 question 可能嵌套轮次数组） */
function flattenMessages(x: unknown, out: Array<{ role?: string; content?: string }>): void {
  if (Array.isArray(x)) {
    for (const item of x) flattenMessages(item, out);
    return;
  }
  if (x && typeof x === 'object') {
    const m = x as { role?: unknown; content?: unknown };
    out.push({ role: typeof m.role === 'string' ? m.role : undefined, content: typeof m.content === 'string' ? m.content : undefined });
  }
}

/** 工具表条目 → BenchToolDef（v3 裸形态 / OpenAI 包装 / JSON 字符串） */
function parseToolDef(item: unknown): BenchToolDef | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  // OpenAI 包装形态：{type:'function', function:{…}}
  const inner =
    rec.function && typeof rec.function === 'object' ? (rec.function as Record<string, unknown>) : rec;
  if (typeof inner.name !== 'string' || !inner.name) return null;
  const parameters =
    inner.parameters && typeof inner.parameters === 'object'
      ? normalizeToolSchema(inner.parameters as Record<string, unknown>)
      : undefined;
  // 根节点必须是 object 规格（函数参数语义；dict 已映射，无 type 的补齐）
  if (parameters && parameters.type === undefined) parameters.type = 'object';
  return {
    name: sanitizeToolName(inner.name),
    ...(typeof inner.description === 'string' ? { description: inner.description } : {}),
    ...(parameters ? { parameters } : {}),
  };
}

// ---- schema 归一化（BFCL 遗留 Python 类型词 → JSON Schema 合法类型词） ----
//
// 实测 BFCL_v3 题目文件的 type 词全集：any/array/boolean/dict/float/
// integer/string/tuple——其中 dict/tuple/any 是 OpenAI 兼容端点严格
// 校验会 400 的非法词（2026-09-11 真实跑批 0/400 全灭的根因）。
// 单源映射 + 递归（items/properties/组合词），未知词删除（空约束 =
// 任意类型，宽松端点也接受）；根节点缺 type 补 object。

/** Python 风格类型词 → JSON Schema 类型词（其余合法词透传） */
const TYPE_WORD_MAP: Record<string, string> = {
  str: 'string',
  int: 'integer',
  float: 'number',
  bool: 'boolean',
  dict: 'object',
  list: 'array',
  tuple: 'array',
  set: 'array',
};

/** JSON Schema 合法类型词（映射后的白名单；不在表内 = 删 type） */
const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

function normalizeTypeWord(word: string): string | undefined {
  const mapped = TYPE_WORD_MAP[word] ?? word;
  return VALID_TYPES.has(mapped) ? mapped : undefined; // any/未知词 → undefined（删）
}

/** 递归归一化一个 schema 节点（properties 值/items/组合词全走） */
export function normalizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type') {
      if (typeof value === 'string') {
        const normalized = normalizeTypeWord(value);
        if (normalized !== undefined) out.type = normalized;
      } else if (Array.isArray(value)) {
        const words = value
          .filter((w): w is string => typeof w === 'string')
          .map(normalizeTypeWord)
          .filter((w): w is string => w !== undefined);
        if (words.length > 0) out.type = words.length === 1 ? words[0] : words;
      }
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
        // 属性值裸类型词简写（"location": "str"）→ 规格化
        props[pk] =
          typeof pv === 'string'
            ? { ...(normalizeTypeWord(pv) !== undefined ? { type: normalizeTypeWord(pv)! } : {}) }
            : normalizeToolSchema(pv as Record<string, unknown>);
      }
      out.properties = props;
      continue;
    }
    if (key === 'items' && typeof value === 'string') {
      const normalized = normalizeTypeWord(value);
      out.items = normalized !== undefined ? { type: normalized } : {};
      continue;
    }
    if ((key === 'items' || key === 'additionalProperties') && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = normalizeToolSchema(value as Record<string, unknown>);
      continue;
    }
    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      out[key] = value.map((v) =>
        v && typeof v === 'object' && !Array.isArray(v) ? normalizeToolSchema(v as Record<string, unknown>) : v,
      );
      continue;
    }
    out[key] = value; // description/enum/required/default 等透传
  }
  return out;
}

/** v1 内嵌题目串：截 "Question:" 之后的正文 */
function promptFromEmbedded(text: string): string {
  const idx = text.lastIndexOf('Question:');
  return (idx >= 0 ? text.slice(idx + 'Question:'.length) : text).trim();
}

/** v1 内嵌题目串：提取函数文档 JSON 数组（首个平衡的 [...] 块） */
function toolsFromEmbedded(text: string): BenchToolDef[] {
  const start = text.indexOf('[');
  if (start < 0) return [];
  let depth = 0;
  let inString: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"') inString = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
          if (Array.isArray(parsed)) return parsed.map(parseToolDef).filter((t): t is BenchToolDef => t !== null);
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

/**
 * 工具名清洗：OpenAI 兼容端点合法集 `^[a-zA-Z0-9_-]+$`（实测
 * 2026-09-11：BFCL 的 Python 风格点名 `math.factorial` 被 400 打回，
 * 249/400 例全灭根因）。非法字符统一替换 `_`，确定性映射——工具定义
 * 与期望规格两侧同源清洗，对拍天然一致。
 */
export function sanitizeToolName(name: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(name) ? name : name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** ground_truth 单条 → 调用规格（v1 字符串 / v3 结构化对象；工具名同源清洗） */
function parseGroundTruthItem(item: unknown): BenchCallSpec | null {
  if (typeof item === 'string') {
    const spec = parseCallString(item);
    return spec ? { ...spec, name: sanitizeToolName(spec.name) } : null;
  }
  if (!item || typeof item !== 'object') return null;
  // v3 结构化：{funcName: {参数: 可接受值 | [可接受值…]}}
  const entries = Object.entries(item as Record<string, unknown>);
  if (entries.length !== 1) return null;
  const [name, rawArgs] = entries[0];
  if (!rawArgs || typeof rawArgs !== 'object') return { name: sanitizeToolName(name) };
  const argsSpec: Record<string, unknown[]> = {};
  for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
    argsSpec[key] = Array.isArray(value) ? value : [value];
  }
  return { name: sanitizeToolName(name), ...(Object.keys(argsSpec).length > 0 ? { argsSpec } : {}) };
}

function parseGroundTruth(raw: unknown): BenchCallSpec[] | null {
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  const specs: BenchCallSpec[] = [];
  for (const item of list) {
    const spec = parseGroundTruthItem(item);
    if (!spec) return null; // 形态不认识——整条跳过（记 skipped）
    specs.push(spec);
  }
  return specs;
}

export interface BfclSuite extends BenchSuite {
  /** 最近一次 load 的跳过明细（文件:原因；诊断用） */
  skippedReasons(): string[];
}

/** BFCL 单轮套件工厂（files 缺省 = 内置样例数据集） */
export function createBfclSuite(options: BfclSuiteOptions = {}): BfclSuite {
  const files = options.files && options.files.length > 0 ? options.files : [DEFAULT_BFCL_SAMPLE];
  let skipped: string[] = [];

  return {
    name: 'bfcl',
    description: 'Berkeley Function Calling Leaderboard 单轮类目（simple/multiple/parallel/parallel-multiple 形态）',
    skippedReasons: () => [...skipped],
    async load(): Promise<BenchCase[]> {
      skipped = [];
      // 答案文件按 id join（v3 官方分离形态）
      const answers = new Map<string, unknown>();
      for (const answerFile of options.answerFiles ?? []) {
        for (const entry of readEntries(answerFile)) {
          const raw = entry as unknown as RawAnswer;
          if (raw.id !== undefined) answers.set(String(raw.id), raw.ground_truth);
        }
      }
      const cases: BenchCase[] = [];
      for (const file of files) {
        const entries = readEntries(file);
        const label = file.split(/[\\/]/).at(-1) ?? file;
        entries.forEach((entry, index) => {
          const raw = entry as unknown as RawQuestion;
          const parsed = parseBfclEntry(raw, answers.get(String(raw.id)), index, label);
          if ('skip' in parsed) {
            skipped.push(`${label}#${raw.id ?? index}: ${parsed.skip}`);
            return;
          }
          cases.push(parsed.case);
        });
      }
      return cases;
    },
  };
}

type ParseOutcome = { case: BenchCase } | { skip: string };

/** 单条目解析（题目 + 工具表 + 答案 → 中性 BenchCase；不可解析 → skip 原因） */
function parseBfclEntry(
  raw: RawQuestion,
  joinedGroundTruth: unknown,
  index: number,
  label: string,
): ParseOutcome {
  // ---- 题目：v3 消息列表 / v1 内嵌串 ----
  let prompt = '';
  let systemHint: string | undefined;
  if (typeof raw.question === 'string') {
    prompt = promptFromEmbedded(raw.question);
  } else if (raw.question != null) {
    const messages: Array<{ role?: string; content?: string }> = [];
    flattenMessages(raw.question, messages);
    const systems = messages.filter((m) => m.role === 'system' && m.content).map((m) => m.content as string);
    const users = messages.filter((m) => m.role === 'user' && m.content).map((m) => m.content as string);
    if (users.length === 0 && messages.length > 0 && messages.at(-1)?.content) {
      users.push(messages.at(-1)!.content as string); // 无角色标注的尾消息按 user 兜底
    }
    prompt = users.at(-1) ?? '';
    systemHint = systems.length > 0 ? systems.join('\n\n') : undefined;
  }
  if (!prompt.trim()) return { skip: '无有效 user 提示词' };

  // ---- 工具表：function 字段 / v1 内嵌 ----
  let tools: BenchToolDef[] = [];
  if (raw.function !== undefined) {
    const fnRaw = raw.function;
    const fnList =
      typeof fnRaw === 'string'
        ? (() => {
            try {
              const parsed = JSON.parse(fnRaw) as unknown;
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          })()
        : Array.isArray(fnRaw)
          ? fnRaw
          : [fnRaw];
    tools = fnList.map(parseToolDef).filter((t): t is BenchToolDef => t !== null);
  } else if (typeof raw.question === 'string') {
    tools = toolsFromEmbedded(raw.question);
  }
  if (tools.length === 0) return { skip: '无有效函数定义' };
  // 清洗后工具名碰撞（如 a.b 与 a_b 同场）→ 注册重名会炸，显式跳过留诊断
  const toolNames = tools.map((t) => t.name);
  if (new Set(toolNames).size !== toolNames.length) return { skip: '工具名清洗后碰撞' };

  // ---- 答案：内联 answer/ground_truth > join 的 possible_answer ----
  const gtRaw = raw.answer ?? raw.ground_truth ?? joinedGroundTruth;
  const expected = parseGroundTruth(gtRaw);
  if (expected === null) return { skip: `答案形态不可解析（${typeof gtRaw}）` };

  return {
    case: {
      id: `bfcl-${label}#${raw.id ?? index}`,
      prompt,
      ...(systemHint ? { systemHint } : {}),
      tools,
      expected,
    },
  };
}
