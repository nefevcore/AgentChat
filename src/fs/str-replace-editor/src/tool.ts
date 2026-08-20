// ============================================================
// @agentchat/str-replace-editor/src/tool.ts —— str_replace_editor 工具
//
// DSH dsh-tool-str-replace-editor 语义移植（SWE-agent 经典单工具编辑器）：
//   · view：文件 → 带行号文本（cat -n 风格，view_range 支持 [起,止]，
//     止=-1 表示到文件尾）；目录 → 下探两层的浅层列表
//   · create：创建新文件（已存在则拒绝；file_text 必填）
//   · str_replace：字面量精确替换——old_str 必须在文件中恰好出现一次，
//     零匹配/多匹配都会失败（刻意不提供 replace_all）；new_str 缺省为空
//     （即删除 old_str）
//   · insert：插到第 insert_line 行之后（行号 1 基、与 view 显示一致，
//     直接传 view 看到的行号；0=文件开头，=行数=文件尾；new_str 按行
//     splice，不隐式补尾换行）——对齐 DSH 上游参数描述语义
//     （"inserted AFTER the line insert_line"）
//
// AgentChat 落地约定：
//   · 路径走 resolveSafePath（工作区 + security.allowedPaths 白名单 +
//     敏感黑名单，与 read/write/edit/bash 同口径）；相对工作区或沙箱内
//     绝对路径均可
//   · 修改操作后 recordSnapshot（hashline 快照），保证随后 edit 工具
//     的行哈希校验不被陈旧快照误拒（与 write 工具同回归口径 P0-2）
//   · 字面量操作不改动编辑范围外内容：制表符、\r\n 换行风格原样保留
//   · 查看输出超 16000 字符截断（提示先用 grep 定位行号再 view_range）
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { CAPABILITY_BASE, type AgentConfig } from '@agentchat/agent-config';
import { defineTool, resolveSafePath } from '@agentchat/toolkit';
import { recordSnapshot } from '@agentchat/edit';
import type { Tool } from '@agentchat/agent-loop';

/** 查看输出保留的字符上限（与 DSH maxOutputChars 缺省一致） */
export const MAX_OUTPUT_CHARS = 16000;
/** 目录查看下探层数（与 DSH listDirectory 一致） */
const DIR_DEPTH = 2;
/** 目录查看跳过的条目（隐藏项 + node_modules + Python 缓存，与 DSH 一致） */
const DIR_SKIP = new Set(['node_modules', '__pycache__']);

const TRUNCATED_NOTE =
  '<response clipped><NOTE>为节省上下文仅展示了文件的一部分。请先用 grep 工具在文件内搜索以定位目标行号，再用 view_range 查看对应区间。</NOTE>';

interface ViewArgs {
  command?: string;
  path?: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  view_range?: number[];
}

function ok(data: Record<string, unknown>): string {
  return JSON.stringify({ status: 'ok', data });
}
function fail(message: string): string {
  return JSON.stringify({ status: 'error', data: { message } });
}

function maybeTruncate(content: string): string {
  return content.length <= MAX_OUTPUT_CHARS ? content : content.slice(0, MAX_OUTPUT_CHARS) + TRUNCATED_NOTE;
}

/** 参数缺省校验（对齐 DSH requiredForCommand：undefined 报错；allowEmpty 控制空串） */
function requiredFor(value: string | undefined, parameter: string, command: string, allowEmpty = true): string {
  if (value === undefined) throw new Error(`命令 ${command} 缺少必填参数 \`${parameter}\``);
  if (!allowEmpty && value.length === 0) throw new Error(`命令 ${command} 的参数 \`${parameter}\` 不能为空`);
  return value;
}

/** 找出 search 在 content 中全部出现偏移 */
function matchOffsets(content: string, search: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (;;) {
    const idx = content.indexOf(search, offset);
    if (idx < 0) return offsets;
    offsets.push(idx);
    offset = idx + search.length;
  }
}

/** 偏移 → 1 基行号（多匹配报错时指明位置） */
function lineNumbersAt(content: string, offsets: number[]): number[] {
  let line = 1;
  let cursor = 0;
  return offsets.map((offset) => {
    while (cursor < offset) {
      if (content[cursor] === '\n') line += 1;
      cursor += 1;
    }
    return line;
  });
}

/** 文件查看：cat -n 风格行号（6 宽右对齐 + 两空格，与 DSH formatFileView 一致） */
function formatFileView(displayPath: string, content: string, viewRange?: number[]): string {
  const allLines = content.split('\n');
  let lines = allLines;
  let initialLine = 1;
  let finalLine: number;
  let header = `以下是 ${displayPath} 的内容（共 ${allLines.length} 行，带行号）`;
  if (viewRange !== undefined) {
    const [start, end] = viewRange;
    if (viewRange.length !== 2 || start === undefined || end === undefined || !viewRange.every(Number.isInteger)) {
      throw new Error('无效的 view_range：应为两个整数组成的数组，如 [11, 12] 或 [11, -1]');
    }
    initialLine = start;
    finalLine = end;
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(`无效的 view_range [${viewRange.join(', ')}]：首元素 ${initialLine} 超出文件行范围 [1, ${allLines.length}]`);
    }
    if (finalLine !== -1 && finalLine > allLines.length) {
      throw new Error(`无效的 view_range [${viewRange.join(', ')}]：次元素 ${finalLine} 超出文件行范围 [1, ${allLines.length}]`);
    }
    if (finalLine !== -1 && finalLine < initialLine) {
      throw new Error(`无效的 view_range [${viewRange.join(', ')}]：次元素 ${finalLine} 应不小于首元素 ${initialLine}（-1 表示到文件尾）`);
    }
    lines = finalLine === -1 ? allLines.slice(initialLine - 1) : allLines.slice(initialLine - 1, finalLine);
    header += `，view_range=[${initialLine}, ${finalLine}]`;
  }
  const numbered = lines.map((line, idx) => `${String(initialLine + idx).padStart(6, ' ')}  ${line}`).join('\n');
  return maybeTruncate(`${header}:\n${numbered}\n`);
}

/** 目录查看：下探两层浅层列表（跳过隐藏/node_modules/__pycache__；d/f 前缀；按路径排序） */
function formatDirectoryView(displayPath: string, rootAbs: string): string {
  const rows: string[] = [];
  const visit = (dirAbs: string, depth: number): void => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of dirents) {
      if (ent.name.startsWith('.') || DIR_SKIP.has(ent.name)) continue;
      const abs = path.join(dirAbs, ent.name);
      const type = ent.isDirectory() ? 'd' : ent.isFile() ? 'f' : '?';
      rows.push(`${type}\t${toPosix(abs)}`);
      if (ent.isDirectory() && depth < DIR_DEPTH) visit(abs, depth + 1);
    }
  };
  rows.push(`d\t${toPosix(rootAbs)}`);
  visit(rootAbs, 1);
  rows.sort((left, right) => codepointCompare(left.slice(left.indexOf('\t') + 1), right.slice(right.indexOf('\t') + 1)));
  return maybeTruncate(
    `以下是 ${displayPath} 下最深两层的文件与目录（不含隐藏项、node_modules 与 Python 缓存目录）:\n${rows.join('\n')}\n`,
  );
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** str_replace_editor 工具（per-Agent 烘焙 config：沙箱根） */
export function makeStrReplaceEditorTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'str_replace_editor', label: '字符串替换编辑器', requires: [CAPABILITY_BASE],
    description:
      '单工具文件编辑器，含四个命令。view：查看文件（带行号；view_range=[起,止] 可选，1 基行号，止=-1 表示到文件尾）或目录（下探两层列表）。create：创建新文件（路径已存在则失败；不能用它覆盖）。str_replace：把 old_str 精确替换为 new_str——old_str 必须与原文完全一致（注意空白/缩进！）且在文件中恰好出现一次，零匹配或多匹配都会失败且不落盘；new_str 缺省为空（删除 old_str）。insert：把 new_str 插到第 insert_line 行之后——行号 1 基、与 view 显示一致：要插在你看到的第 L 行之后，直接传 L 即可，无需换算；0=插到文件开头（第 1 行之前）；=总行数=插到文件尾（文件以换行结尾时行数含一空尾行，与 view 的 total_lines 一致）。new_str 不自动补尾换行。路径相对工作区（或沙箱内绝对路径）；修改操作保留编辑范围外的一切内容（含制表符与 CRLF 换行）。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['view', 'create', 'str_replace', 'insert'],
          description: '要执行的命令：view / create / str_replace / insert',
        },
        path: { type: 'string', description: '目标文件或目录路径（相对工作区；view 目录时为目录路径）' },
        file_text: { type: 'string', description: 'create 命令必填：新文件的完整内容' },
        old_str: { type: 'string', description: 'str_replace 命令必填：要被替换的原文（须与文件内容逐字一致且唯一）' },
        new_str: { type: 'string', description: 'str_replace 可选（缺省删除 old_str）；insert 命令必填：要插入的文本' },
        insert_line: { type: 'integer', description: 'insert 命令必填：new_str 插到第 insert_line 行之后。行号 1 基、与 view 显示一致——要插在 view 里看到的第 L 行之后，直接传 L，无需换算；0=插到文件开头；=总行数=插到文件尾' },
        view_range: {
          type: 'array',
          items: { type: 'integer' },
          description: 'view 命令可选（仅文件）：[起始行, 结束行]，1 基；结束行 -1 表示到文件尾',
        },
      },
      required: ['command', 'path'],
    },
    extractLabel: (args) => `${args.command ?? ''} ${String(args.path ?? '')}`,
    execute: async (rawArgs) => {
      try {
        const args = rawArgs as ViewArgs;
        const command = String(args.command ?? '');
        const pathInput = String(args.path ?? '');
        if (!pathInput.trim()) return fail('path 不能为空');
        const target = resolveSafePath(config, pathInput);

        switch (command) {
          case 'view':
            return await viewPath(pathInput, target, args.view_range);
          case 'create':
            return await createFile(pathInput, target, args.file_text);
          case 'str_replace':
            return await replaceInFile(pathInput, target, args.old_str, args.new_str);
          case 'insert':
            return await insertInFile(pathInput, target, args.insert_line, args.new_str);
          default:
            return fail(`未知 command "${command}"（允许：view / create / str_replace / insert）`);
        }
      } catch (err: any) {
        return fail(err?.message ?? String(err));
      }
    },
  });
}

/** 解析已存在目标（view 允许目录；修改命令仅限常规文件） */
function statExisting(pathInput: string, target: string, command: string): 'file' | 'directory' {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`路径不存在: ${pathInput}（${command} 需要已存在的目标）`);
  }
  if (stat.isDirectory() && command !== 'view') {
    throw new Error(`path 是目录（${pathInput}）：只有 view 命令可用于目录`);
  }
  return stat.isDirectory() ? 'directory' : 'file';
}

async function viewPath(pathInput: string, target: string, viewRange?: number[]): Promise<string> {
  const kind = statExisting(pathInput, target, 'view');
  if (kind === 'directory') {
    if (viewRange !== undefined) return fail('view_range 仅在 path 为文件时可用');
    return ok({ path: pathInput, type: 'directory', content: formatDirectoryView(pathInput, target) });
  }
  const content = fs.readFileSync(target, 'utf-8');
  recordSnapshot(target, content); // 与 read 工具同口径：查看即记录 hashline 快照
  const totalLines = content.split('\n').length;
  return ok({ path: pathInput, type: 'file', total_lines: totalLines, content: formatFileView(pathInput, content, viewRange) });
}

async function createFile(pathInput: string, target: string, fileText: string | undefined): Promise<string> {
  const content = requiredFor(fileText, 'file_text', 'create');
  if (fs.existsSync(target)) {
    return fail(`文件已存在: ${pathInput}（create 不能覆盖已有文件；修改请用 str_replace/insert）`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
  recordSnapshot(target, content);
  return ok({ message: `已创建文件 ${pathInput}`, path: pathInput, bytes: Buffer.byteLength(content, 'utf-8') });
}

async function replaceInFile(pathInput: string,
  target: string,
  oldStr: string | undefined,
  newStr: string | undefined,
): Promise<string> {
  const oldValue = requiredFor(oldStr, 'old_str', 'str_replace', false);
  const newValue = newStr ?? '';
  statExisting(pathInput, target, 'str_replace');

  const before = fs.readFileSync(target, 'utf-8');
  const offsets = matchOffsets(before, oldValue);
  if (offsets.length === 0) {
    return fail(`未执行替换：old_str 未在 ${pathInput} 中逐字出现。请检查空白/缩进/换行是否与原文完全一致`);
  }
  if (offsets.length > 1) {
    const lines = lineNumbersAt(before, offsets).join(', ');
    return fail(`未执行替换：old_str 在 ${pathInput} 中出现 ${offsets.length} 次（行 [${lines}]）。请扩大 old_str 上下文使其唯一`);
  }
  const offset = offsets[0];
  const after = before.slice(0, offset) + newValue + before.slice(offset + oldValue.length);
  fs.writeFileSync(target, after, 'utf-8');
  recordSnapshot(target, after);
  return ok({ message: `已替换 ${pathInput} 中的 1 处匹配`, path: pathInput, replacements: 1 });
}

async function insertInFile(pathInput: string,
  target: string,
  insertLine: number | undefined,
  newStr: string | undefined,
): Promise<string> {
  if (insertLine === undefined || !Number.isInteger(insertLine)) {
    return fail('insert 命令缺少必填参数 `insert_line`（整数）');
  }
  const value = requiredFor(newStr, 'new_str', 'insert');
  statExisting(pathInput, target, 'insert');

  const before = fs.readFileSync(target, 'utf-8');
  const lines = before.split('\n');
  if (insertLine < 0 || insertLine > lines.length) {
    return fail(`无效的 insert_line ${insertLine}：应在文件行边界范围内 [0, ${lines.length}]`);
  }
  const after = [...lines.slice(0, insertLine), ...value.split('\n'), ...lines.slice(insertLine)].join('\n');
  fs.writeFileSync(target, after, 'utf-8');
  recordSnapshot(target, after);
  // 位置双表述（自校验用；0/尾部分支单独措辞，避免"第 0 行之后"式歧义）
  const where = insertLine === 0
    ? '文件开头（第 1 行之前）'
    : insertLine === lines.length
      ? `文件尾（原第 ${lines.length} 行之后）`
      : `第 ${insertLine} 行之后 / 第 ${insertLine + 1} 行之前`;
  return ok({
    message: `已在 ${pathInput} 插入文本（insert_line=${insertLine} → ${where}；文件现 ${after.split('\n').length} 行）`,
    path: pathInput,
    insert_line: insertLine,
  });
}
