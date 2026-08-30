// ============================================================
// ac-str-replace-editor/src/index.ts —— str_replace_editor 工具行
//
// DSH dsh-tool-str-replace-editor 语义原样移植（src 平移，输出归一 {ok, output}）：
//   · view：文件 → 带行号文本（view_range [起,止]，-1 到文件尾）；
//     目录 → 下探两层的浅层列表（d/f 前缀）
//   · create：创建新文件（已存在拒绝）
//   · str_replace：字面量精确替换（old_str 须唯一；new_str 缺省空 = 删除）
//   · insert：插到第 insert_line 行之后（1 基，与 view 行号一致；0=开头）
// 修 src 已知缺口（地图 §3.4）：写操作经 ac-edit-core 突变队列串行化
// （同文件并行编辑交错风险收敛——与 read/write/edit 共享同一把锁）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import { createSandboxResolver, type SandboxResolverOptions } from 'ac-sandbox-core';
import { withFileMutationQueue } from 'ac-edit-core';

export interface StrReplaceEditorRowOptions extends SandboxResolverOptions {}

/** 查看输出保留的字符上限（与 DSH maxOutputChars 缺省一致） */
export const MAX_OUTPUT_CHARS = 16000;
/** 目录查看下探层数（与 DSH listDirectory 一致） */
const DIR_DEPTH = 2;
/** 目录查看跳过的条目（隐藏项 + node_modules + Python 缓存，与 DSH 一致） */
const DIR_SKIP = new Set(['node_modules', '__pycache__']);

const TRUNCATED_NOTE =
  '<response clipped><NOTE>为节省上下文仅展示了文件的一部分。请先用 grep 工具在文件内搜索以定位目标行号，再用 view_range 查看对应区间。</NOTE>';

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

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** 文件查看：cat -n 风格行号（6 宽右对齐 + 两空格） */
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
  const key = (row: string) => row.slice(row.indexOf('\t') + 1);
  rows.sort((left, right) => {
    const l = key(left);
    const r = key(right);
    return l < r ? -1 : l > r ? 1 : 0;
  });
  return maybeTruncate(
    `以下是 ${displayPath} 下最深两层的文件与目录（不含隐藏项、node_modules 与 Python 缓存目录）:\n${rows.join('\n')}\n`,
  );
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

export const name = 'ac-str-replace-editor';

export const inject = ['tools'];

export function apply(ctx: Context, options: StrReplaceEditorRowOptions = {}) {
  // 沙箱解析基准（M18 反馈 #3）：Agent 专用空间（ac-workspace.sandboxWorkdir
  // 唯一事实源；缺 → 行缺省）。按基准缓存解析器。
  const resolvers = new Map<string, ReturnType<typeof createSandboxResolver>>();
  function sandboxOf(call: { agentId?: string }): ReturnType<typeof createSandboxResolver> {
    const ws = ctx.get('workspace') as
      | { sandboxWorkdir(id?: string): string | undefined }
      | undefined;
    const base = ws?.sandboxWorkdir(call.agentId) ?? options.workdir;
    const key = base !== undefined ? String(base) : '(default)';
    let r = resolvers.get(key);
    if (!r) {
      r = createSandboxResolver({ ...options, ...(base !== undefined ? { workdir: base } : {}) });
      resolvers.set(key, r);
    }
    return r;
  }

  ctx.tools.register({
    name: 'str_replace_editor',
    description:
      '四合一文件编辑器：view 查看文件（带行号）或目录、create 创建文件、str_replace 精确文本替换、insert 按行号插入。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['view', 'create', 'str_replace', 'insert'],
          description: '命令：view / create / str_replace / insert',
        },
        path: { type: 'string', description: '目标文件或目录路径' },
        file_text: { type: 'string', description: 'create：新文件的完整内容' },
        old_str: { type: 'string', description: 'str_replace：要替换的原文（须唯一）' },
        new_str: { type: 'string', description: 'str_replace：替换后的文本（空 = 删除）；insert：要插入的文本' },
        insert_line: { type: 'integer', description: 'insert：插到第几行之后（与 view 显示的行号一致，0 = 文件开头）' },
        view_range: {
          type: 'array',
          items: { type: 'integer' },
          description: 'view：[起始行, 结束行]，-1 表示到文件尾',
        },
      },
      required: ['command', 'path'],
    },
    async execute(args, call) {
      try {
        const command = String(args.command ?? '');
        const pathInput = String(args.path ?? '');
        if (!pathInput.trim()) return { ok: false, error: 'path 不能为空' };
        const target = sandboxOf(call).resolve(pathInput);

        switch (command) {
          case 'view': {
            const kind = statExisting(pathInput, target, 'view');
            if (kind === 'directory') {
              if (args.view_range !== undefined) return { ok: false, error: 'view_range 仅在 path 为文件时可用' };
              return {
                ok: true,
                output: { path: pathInput, type: 'directory', content: formatDirectoryView(pathInput, target) },
              };
            }
            const viewRange = args.view_range as number[] | undefined;
            const content = fs.readFileSync(target, 'utf-8');
            const totalLines = content.split('\n').length;
            return {
              ok: true,
              output: {
                path: pathInput,
                type: 'file',
                total_lines: totalLines,
                content: formatFileView(pathInput, content, viewRange),
              },
            };
          }
          case 'create': {
            const content = requiredFor(args.file_text as string | undefined, 'file_text', 'create');
            if (fs.existsSync(target)) {
              return {
                ok: false,
                error: `文件已存在: ${pathInput}（create 不能覆盖已有文件；修改请用 str_replace/insert）`,
              };
            }
            await withFileMutationQueue(target, async () => {
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, content, 'utf-8');
            });
            return {
              ok: true,
              output: {
                message: `已创建文件 ${pathInput}`,
                path: pathInput,
                bytes: Buffer.byteLength(content, 'utf-8'),
              },
            };
          }
          case 'str_replace': {
            const oldValue = requiredFor(args.old_str as string | undefined, 'old_str', 'str_replace', false);
            const newValue = (args.new_str as string | undefined) ?? '';
            statExisting(pathInput, target, 'str_replace');

            const before = fs.readFileSync(target, 'utf-8');
            const offsets = matchOffsets(before, oldValue);
            if (offsets.length === 0) {
              return {
                ok: false,
                error: `未执行替换：old_str 未在 ${pathInput} 中逐字出现。请检查空白/缩进/换行是否与原文完全一致`,
              };
            }
            if (offsets.length > 1) {
              const lines = lineNumbersAt(before, offsets).join(', ');
              return {
                ok: false,
                error: `未执行替换：old_str 在 ${pathInput} 中出现 ${offsets.length} 次（行 [${lines}]）。请扩大 old_str 上下文使其唯一`,
              };
            }
            const offset = offsets[0];
            const after = before.slice(0, offset) + newValue + before.slice(offset + oldValue.length);
            await withFileMutationQueue(target, async () => {
              fs.writeFileSync(target, after, 'utf-8');
            });
            return { ok: true, output: { message: `已替换 ${pathInput} 中的 1 处匹配`, path: pathInput, replacements: 1 } };
          }
          case 'insert': {
            const insertLine = args.insert_line as number | undefined;
            if (insertLine === undefined || !Number.isInteger(insertLine)) {
              return { ok: false, error: 'insert 命令缺少必填参数 `insert_line`（整数）' };
            }
            const value = requiredFor(args.new_str as string | undefined, 'new_str', 'insert');
            statExisting(pathInput, target, 'insert');

            const before = fs.readFileSync(target, 'utf-8');
            const lines = before.split('\n');
            if (insertLine < 0 || insertLine > lines.length) {
              return {
                ok: false,
                error: `无效的 insert_line ${insertLine}：应在文件行边界范围内 [0, ${lines.length}]`,
              };
            }
            const after = [...lines.slice(0, insertLine), ...value.split('\n'), ...lines.slice(insertLine)].join('\n');
            await withFileMutationQueue(target, async () => {
              fs.writeFileSync(target, after, 'utf-8');
            });
            // 位置双表述（自校验用；0/尾部分支单独措辞，避免"第 0 行之后"式歧义）
            const where =
              insertLine === 0
                ? '文件开头（第 1 行之前）'
                : insertLine === lines.length
                  ? `文件尾（原第 ${lines.length} 行之后）`
                  : `第 ${insertLine} 行之后 / 第 ${insertLine + 1} 行之前`;
            return {
              ok: true,
              output: {
                message: `已在 ${pathInput} 插入文本（insert_line=${insertLine} → ${where}；文件现 ${after.split('\n').length} 行）`,
                path: pathInput,
                insert_line: insertLine,
              },
            };
          }
          default:
            return { ok: false, error: `未知 command "${command}"（允许：view / create / str_replace / insert）` };
        }
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
