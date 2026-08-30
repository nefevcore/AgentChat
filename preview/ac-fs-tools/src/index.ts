// ============================================================
// ac-fs-tools/src/index.ts —— 文件读写工具行（read/write/edit）
//
// src fs + edit 包平移（输出形态归一：工具体返回 {ok, output:<src data
// 形状>}；展示词汇由 web 表面订阅 tool/after-execute 自取——地图 §3.4 #6）。
// 沙箱基线：本行自带 createSandboxResolver（workdir/allowedPaths/
// denyPatterns 行配置）——read/write/edit 的路径解析全部过沙箱（src
// resolveSafePath 语义）。M18 起 per-call 基准经 ac-workspace.
// sandboxWorkdir（Agent 专用空间 files/<id>；行缺省 cwd 仅在无执行身份/
// 未装 workspace 行时兜底）。per-Agent 收紧（能力门禁/更窄白名单/bash
// 扫描）归 ac-security 行。算法住纯库：ac-edit-core（编辑引擎）+
// ac-text-budget（token 截断）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import { createSandboxResolver, type SandboxResolverOptions } from 'ac-sandbox-core';
import { applyEditBatch, withFileMutationQueue } from 'ac-edit-core';
import { estimateTokens, safeClipByTokens } from 'ac-text-budget';

export interface FsToolsRowOptions extends SandboxResolverOptions {}

/** read 输出的 token 预算（防大文件撑爆上下文；超出安全截断并标注） */
export const READ_TOKEN_BUDGET = 24000;

/** 兼容旧 camelCase 入参的兜底读取 */
function readPathArg(args: Record<string, unknown>): string {
  const p = args.file_path ?? args.filePath ?? args.path;
  if (typeof p !== 'string' || !p) {
    throw new Error('缺少 file_path 参数（目标文件路径，相对工作区）。');
  }
  return p;
}

export const name = 'ac-fs-tools';

export const inject = ['tools'];

export function apply(ctx: Context, options: FsToolsRowOptions = {}) {
  // 沙箱解析基准（M18 反馈 #3）：Agent 专用空间 <root>/files/<agentId>
  // （ac-workspace.sandboxWorkdir 唯一事实源；无执行身份/未装 workspace 行
  // → 行缺省 cwd）。按基准缓存解析器。
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

  // ---- read：文件（行号分页 + token 预算截断）或目录列表 ----
  ctx.tools.register({
    name: 'read',
    description: '读取文本文件并返回带有行号的内容（目录则返回列表）。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件或目录路径' },
        offset: { type: 'number', description: '起始行号（默认 1）', minimum: 1 },
        limit: { type: 'number', description: '最多返回的行数（默认 2000，最大 5000）', minimum: 1, maximum: 5000 },
      },
      required: ['file_path'],
    },
    async execute(args, call) {
      try {
        const p = readPathArg(args);
        const file = sandboxOf(call).resolve(p);
        const stat = fs.statSync(file);
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(file, { withFileTypes: true });
          const items = entries.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
          }));
          items.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          return { ok: true, output: { path: p, type: 'directory', items, count: items.length } };
        }
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');
        const total = lines.length;

        // 分段读取（offset 1 基；limit 缺省 2000）
        const start = Math.max(1, Math.floor(Number(args.offset) || 1));
        const maxLines = Math.min(5000, Math.max(1, Math.floor(Number(args.limit) || 2000)));
        const slice = lines.slice(start - 1, start - 1 + maxLines);
        const truncated = start - 1 + maxLines < total;

        const numbered = slice.map((l, idx) => `${start + idx}:${l}`).join('\n');
        // token 预算截断（地图 §3.4 缺口收敛）：超出预算保头截断 + 标注
        let text = numbered;
        const notes: string[] = [];
        if (estimateTokens(text) > READ_TOKEN_BUDGET) {
          text = safeClipByTokens(text, READ_TOKEN_BUDGET, false);
          notes.push(`内容超出 token 预算（${READ_TOKEN_BUDGET}），已截断；用 offset/limit 分段读取`);
        }
        if (truncated) notes.push(`共 ${total} 行，仅返回 ${slice.length} 行；next_offset=${start + maxLines}`);

        return {
          ok: true,
          output: {
            path: p,
            content: text,
            size: stat.size,
            total_lines: total,
            ...(notes.length > 0 ? { note: notes.join('；') } : {}),
            ...(truncated ? { truncated: true, next_offset: start + maxLines } : {}),
          },
        };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  // ---- write：创建/覆盖文件（同文件经突变队列串行化） ----
  ctx.tools.register({
    name: 'write',
    description: '创建或覆盖文本文件。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件完整内容' },
      },
      required: ['file_path', 'content'],
    },
    async execute(args, call) {
      try {
        const p = readPathArg(args);
        const content = args.content;
        if (typeof content !== 'string') {
          return { ok: false, error: '缺少 content 参数（文件完整内容）' };
        }
        const file = sandboxOf(call).resolve(p);
        await withFileMutationQueue(file, async () => {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, content, 'utf-8');
        });
        return { ok: true, output: { message: `已写入 ${p}`, path: p } };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  // ---- edit：old_string/new_string 文本匹配编辑（编辑引擎住 ac-edit-core） ----
  ctx.tools.register({
    name: 'edit',
    description: '通过替换文本内容来编辑文本文件（old_string 必须唯一；引号/空白差异可自动归一化）。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '要替换的原文' },
        new_string: { type: 'string', description: '替换后的文本' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    async execute(args, call) {
      let filePath = '';
      try {
        // 已移除的旧形态：明确迁移引导（而非神秘报错）
        if (typeof args.input === 'string' && args.input.trim().length > 0) {
          return {
            ok: false,
            error: 'Hashline DSL（input 参数）已移除。请改用 old_string/new_string 文本匹配：先 read 复制原文，再 edit(file_path, old_string, new_string)。',
          };
        }
        if (Array.isArray(args.edits) && args.edits.length > 0) {
          return {
            ok: false,
            error: 'edits[] 批量编辑已移除。多处修改请并行发多个 edit 调用（每次 edit(file_path, old_string, new_string) 改一处）。',
          };
        }
        filePath = readPathArg(args);
        const oldText = args.old_string ?? args.oldString;
        const newText = args.new_string ?? args.newString;
        if (typeof oldText !== 'string' || oldText.length === 0) {
          return { ok: false, error: '缺少 old_string 参数（要替换的原文，可从 read 输出复制）。' };
        }
        if (typeof newText !== 'string') {
          return { ok: false, error: '缺少 new_string 参数（替换后的新文本；传空字符串表示删除 old_string）。' };
        }

        const file = sandboxOf(call).resolve(filePath);
        call.onProgress?.(`正在编辑: ${filePath}（1 处文本匹配）...\n`);
        const { diff, firstChangedLine, fuzzyMatches } = await applyEditBatch(file, {
          textEdits: [{ oldText, newText }],
        });
        const appliedCount = diff === '（无变更）' ? 0 : 1;
        call.onProgress?.(
          `编辑完成，${appliedCount} 处替换` + (fuzzyMatches > 0 ? `（含 ${fuzzyMatches} 处模糊匹配）` : '') + '\n',
        );
        return {
          ok: true,
          output: {
            path: filePath,
            file: path.basename(file),
            edits_applied: appliedCount,
            fuzzy_matches: fuzzyMatches,
            first_changed_line: firstChangedLine,
            diff,
          },
        };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
