// ============================================================
// ac-fs-tools/src/index.ts —— 文件读写工具行（read/write/edit）
//
// src fs + edit 包平移（输出形态归一：工具体返回 {ok, output:<src data
// 形状>}；展示词汇由 web 表面订阅 tool/after-execute 自取——地图 §3.4 #6）。
// 沙箱基线（access-tier §9.3 执行面分层）：
//   · read 读不设防（§9.1 放宽）：脱离工作区沙箱——相对路径仍按锚点
//     （sandboxWorkdir）解析，只过双黑名单（accessDeny 全档 + readDeny
//     非 full 档）；
//   · write/edit 写侧防线不动：沙箱白名单 + denyPatterns（full 档/
//     审批 elevation 跳过白名单，accessDeny 不跳过）。
// M18 起 per-call 基准经 ac-workspace.sandboxWorkdir（Agent 专用空间
// files/<id>；行缺省 cwd 仅在无执行身份/未装 workspace 行时兜底）。
// per-Agent 档位门/询问提权归 ac-security 行（needPermission 标注：
// write/edit=true）。
// 算法住纯库：ac-edit-core（编辑引擎）+ ac-text-budget（token 截断）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import {
  accessDenyPatterns,
  createAgentSandboxCache,
  denyExtrasOf,
  isDeniedPath,
  readDenyPatterns,
  type SandboxResolverOptions,
  type SandboxWorkdirSource,
} from 'ac-sandbox-core';
import { effectiveTierOf } from 'ac-agents';
import type { AgentConfig } from 'ac-agents';
import { applyEditBatch, countLineChanges, withFileMutationQueue } from 'ac-edit-core';
import { estimateTokens, safeClipByTokens } from 'ac-text-budget';

export interface FsToolsRowOptions extends SandboxResolverOptions {
  /** 追加访问黑名单（读+写双禁；系统默认表随 workspace 锚定自动内置） */
  accessDenyPaths?: string[];
  /** 追加读黑名单（仅读禁；默认表 .env 系/密钥文件模式自动内置） */
  readDenyPaths?: string[];
}

/** read 输出的 token 预算（防大文件撑爆上下文；超出安全截断并标注） */
const READ_TOKEN_BUDGET = 24000;

/** 兼容旧 camelCase 入参的兜底读取 */
function readPathArg(args: Record<string, unknown>): string {
  const p = args.file_path ?? args.filePath ?? args.path;
  if (typeof p !== 'string' || !p) {
    throw new Error('缺少 file_path 参数（目标文件路径，相对工作区）。');
  }
  return p;
}

export const name = 'ac-fs-tools';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'fs-tools',
  label: '文件读写',
  description: '文件读写工具行（read/write/edit 等）',
};

export const inject = ['tools'];

/** @ 路径引用约定（DSH FILE_REFERENCE_PROMPT 同族）：read 的 owner 行
 *  教语法——条件安装（Agent 生效工具集含 read 才注入，不教做不到的事）；
 *  只依赖工具集 → KV 前缀随工具集稳定。 */
const FILE_MENTION_GUIDE =
  '[引用约定] 用户消息中的 @<路径>（含空格形如 @"路径"，目录以尾斜杠标识）是用户明确引用的文件/目录：'
  + '需要内容时用 read 读取（read 目录即列表）；未读取前不要声称已查看其内容。';

export function apply(ctx: Context, options: FsToolsRowOptions = {}) {
  // 沙箱解析基准（M18 反馈 #3）：Agent 专用空间 <root>/files/<agentId>
  // （ac-workspace.sandboxWorkdir 唯一事实源；无执行身份/未装 workspace 行
  // → 行缺省 cwd）。按基准缓存解析器（共用实现住 ac-sandbox-core）。
  const sandboxOf = createAgentSandboxCache(options, () =>
    ctx.get('workspace') as SandboxWorkdirSource | undefined,
  );

  /** agents 软依赖（档位判定 tierOf 单源） */
  const agentsOf = (): { get(id: string): AgentConfig | undefined } | undefined =>
    ctx.get('agents', false) as { get(id: string): AgentConfig | undefined } | undefined;

  /**
   * 文件首见快照软依赖（方案 C）：write/edit 写路径前调 ensure——
   * 会话×文件首见时存磁盘内容（前端文件编辑面板的存量初版 diff 底）。
   * 本行缺席（ctx.get 可选探测）/ 无会话上下文 = 静默跳过，不阻断写。
   */
  function snapshotBefore(call: { conversationId?: string }, file: string): void {
    if (!call.conversationId) return;
    const svc = ctx.get('fileSnapshots', false) as
      | { ensure(conversationId: string, absPath: string): boolean }
      | undefined;
    void svc?.ensure(call.conversationId, file);
  }

  /** effectiveTier（§3.2）：call.elevation（机制提权/审批注入）?? tierOf(agent)
   *  ——与 ac-security 加严层共用单源（effectiveTierOf），防基线与复检漂移 */
  function tierOfCall(call: { agentId?: string; elevation?: string }): 'full-access' | 'sandbox-access' | 'base-access' {
    const agent = call.agentId !== undefined ? agentsOf()?.get(call.agentId) : undefined;
    return effectiveTierOf(
      agent,
      call.elevation === 'full-access' ? 'full-access' : call.elevation === 'sandbox-access' ? 'sandbox-access' : undefined,
    );
  }

  /** workspace 不可用的告警只发一次（基线 best-effort；ac-security 加严层
   *  对 workspace 缺失 fail-closed 兜底） */
  let warnedNoWorkspace = false;

  /** 双黑名单装配（基线端，per-call）：workspace 可用时锚定系统域默认表
   *  （控制面 + 持久化域树）；不可用 = 系统部分缺失（best-effort）。
   *  追加项 = 行配置 ∪ settings['security']（denyExtrasOf 单源读取）。 */
  function denyListsOf(call: { agentId?: string }): { accessDeny: string[]; readDeny: string[] } {
    // root 防御性校验：mock/部分实现可能无 root（非 string = 视同未装，
    // best-effort 跳过系统部分——加严层 fail-closed 兜底）
    const wsRaw = ctx.get('workspace') as { root?: unknown } | undefined;
    const root = typeof wsRaw?.root === 'string' ? wsRaw.root : undefined;
    const agents = agentsOf() as ({ settingsOf?(id: string, name?: string): unknown } | undefined);
    const s = call.agentId !== undefined ? agents?.settingsOf?.(call.agentId, 'security') : undefined;
    const extras = denyExtrasOf(s);
    const accessExtra = [...(options.accessDenyPaths ?? []), ...extras.accessDenyPaths];
    const readExtra = [...(options.readDenyPaths ?? []), ...extras.readDenyPaths];
    if (root === undefined && !warnedNoWorkspace) {
      warnedNoWorkspace = true;
      ctx.logger.warn(
        '[fs-tools] workspace 服务不可用：访问黑名单系统域部分（控制面/持久化域）无法锚定数据根——基线仅检查追加项（best-effort；ac-security 行如装载则 fail-closed 兜底）。',
      );
    }
    return {
      accessDeny: root !== undefined ? accessDenyPatterns(root, accessExtra) : accessExtra,
      readDeny: readDenyPatterns(readExtra),
    };
  }

  /** 读路径黑名单判定（read/glob/grep 共用口径；full 档跳过 readDeny） */
  function readDeniedMessage(
    call: { agentId?: string; elevation?: string },
    file: string,
    raw: string,
  ): string | undefined {
    const deny = denyListsOf(call);
    if (isDeniedPath(deny.accessDeny, file)) {
      return `路径被访问黑名单拒绝（系统域读+写双禁）：${raw}`;
    }
    if (tierOfCall(call) !== 'full-access' && isDeniedPath(deny.readDeny, file)) {
      return `路径被读黑名单拒绝（用户域机密；full-access 档跳过）：${raw}`;
    }
    return undefined;
  }

  // ---- @ 路径引用指引（read 的 owner 行条件注入；见 FILE_MENTION_GUIDE）----
  ctx.on('loop/before-run', (call, next) => {
    const names = new Set(call.request.tools ?? ctx.tools.list().map((t) => t.name));
    if (names.has('read')) {
      call.request = {
        ...call.request,
        system: call.request.system ? `${call.request.system}\n${FILE_MENTION_GUIDE}` : FILE_MENTION_GUIDE,
      };
    }
    return next();
  }, { description: '注入 @ 路径引用约定（Agent 有 read 时）' });

  // ---- read：文件（行号分页 + token 预算截断）或目录列表 ----
  // fs 标签（2026-09-16 全量标签化）：文件族门禁——存量 Agent 由
  // agent-store 读边界归一补 'fs'；程序化模式 include 用 tag:fs 引用
  ctx.tools.register({
    name: 'read',
    requiredTags: ['fs'],
    description:
      '读取文本文件并返回带行号的内容（output: { path, content: "1:…\\n2:…", size, total_lines, … }）；'
      + 'file_path 是目录时返回条目清单（output: { path, type: "directory", items: Array<{ name, type: "file"|"directory" }>, count }——目录在前、按名排序，条目是对象数组不是字符串数组）。',
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
        // 读不设防（§9.1）：脱离工作区沙箱——相对路径按锚点解析（与写侧
        // 基线同源锚点），只过双黑名单（无 allowed-roots 越界判定）
        const file = path.resolve(sandboxOf(call).workdir, p);
        const denied = readDeniedMessage(call, file, p);
        if (denied) return { ok: false, error: denied };
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
    requiredTags: ['fs'],
    needPermission: true,
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
      // 行变更统计（队列回调内赋值；扩散进结果——undefined 时省略键）
      let writeDiffStat: { diff_added: number; diff_removed: number } | undefined;
      try {
        const p = readPathArg(args);
        const content = args.content;
        if (typeof content !== 'string') {
          return { ok: false, error: '缺少 content 参数（文件完整内容）' };
        }
        // 写基线 tierOf 感知（§9.3）：full 档/审批 elevation 跳过沙箱白名单
        // （accessDeny 不跳过——域规则与档位正交）；base/sandbox 沙箱内
        const sandbox = sandboxOf(call);
        const file = tierOfCall(call) === 'full-access'
          ? path.resolve(sandbox.workdir, p)
          : sandbox.resolve(p);
        const deny = denyListsOf(call);
        if (isDeniedPath(deny.accessDeny, file)) {
          return { ok: false, error: `路径被访问黑名单拒绝（系统域读+写双禁，不随档位跳过）：${p}` };
        }
        snapshotBefore(call, file); // 首见快照（方案 C——覆盖写前存底；幂等）
        await withFileMutationQueue(file, async () => {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          // 旧内容快照（行变更统计 +N/-M 数据源；不存在/二进制读失败按新建计）
          let prev = '';
          let existed = false;
          try {
            prev = fs.readFileSync(file, 'utf-8');
            existed = true;
          } catch { /* 新建文件 */ }
          fs.writeFileSync(file, content, 'utf-8');
          const { added, removed } = existed ? countLineChanges(prev, content) : { added: content.split('\n').length, removed: 0 };
          writeDiffStat = { diff_added: added, diff_removed: removed };
        });
        return { ok: true, output: { message: `已写入 ${p}`, path: p, ...(writeDiffStat ?? {}) } };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  // ---- edit：old_string/new_string 文本匹配编辑（编辑引擎住 ac-edit-core） ----
  ctx.tools.register({
    name: 'edit',
    requiredTags: ['fs'],
    needPermission: true,
    description: '通过替换文本内容来编辑文本文件（old_string 必须唯一且从 read 输出原样复制，且须与 new_string 不同；行首缩进不同的文本会被拒绝；json/代码文件写回前做语法预检）。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '要替换的原文' },
        new_string: { type: 'string', description: '替换后的文本（须与 old_string 不同）' },
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

        // 写基线 tierOf 感知（§9.3，与 write 同款）：full/审批 elevation
        // 跳过沙箱白名单；accessDeny 不随档位跳过
        const sandbox = sandboxOf(call);
        const file = tierOfCall(call) === 'full-access'
          ? path.resolve(sandbox.workdir, filePath)
          : sandbox.resolve(filePath);
        const deny = denyListsOf(call);
        if (isDeniedPath(deny.accessDeny, file)) {
          return { ok: false, error: `路径被访问黑名单拒绝（系统域读+写双禁，不随档位跳过）：${filePath}` };
        }
        snapshotBefore(call, file); // 首见快照（方案 C——编辑前存底；幂等）
        call.onProgress?.(`正在编辑: ${filePath}（1 处文本匹配）...\n`);
        const { diff, firstChangedLine, fuzzyMatches, diffAdded, diffRemoved, readback } = await applyEditBatch(file, {
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
            ...(fuzzyMatches > 0
              ? {
                  note:
                    '⚠️ 本次编辑含归一化模糊匹配（old_string 非原文精确复制）：编辑落点可能偏离预期，' +
                    '请核对下方 readback 与预期位置是否一致；连续编辑同一文件时 old_string 必须重新 read 获取。',
                }
              : {}),
            first_changed_line: firstChangedLine,
            diff_added: diffAdded,
            diff_removed: diffRemoved,
            diff,
            ...(readback !== undefined ? { readback } : {}),
          },
        };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
