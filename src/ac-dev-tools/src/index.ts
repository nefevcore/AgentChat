// ============================================================
// ac-dev-tools/src/index.ts —— 开发辅助工具行
// （read_logs / reload / reload_modules）
//
// src dev 平移（输出归一 {ok, output/interrupt}）。preview 形态差异：
//   · read_logs 数据源 = ctx.logger.exporter 注册的环形缓冲（订阅型，
//     随本行 fiber 卸载撤销——替代 src 的全局日志缓冲单例）
//   · reload / reload_modules 走 M11 语义化中断通道：工具体不执行
//     宿主级热重载，返回 ToolResult.interrupt，loop 收束后本行宿主半边
//     执行（include.refresh / hmr.reloadFiles）并回投续跑通知——
//     会话不因语义化中断断流（2026-09-02 反馈 #1 补齐）
// 能力门禁：requires ['dev']（ac-security 行执行；缺省放行 base）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 环形缓冲容量（对齐 src「最近 2000 条」） */
const LOG_BUFFER_SIZE = 2000;

interface LogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  name: string;
  text: string;
}

const LEVEL_ORDER: Record<LogEntry['level'], number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 渲染一条日志为文本行（read_logs 输出形状） */
function renderLine(e: LogEntry): string {
  const time = new Date(e.ts).toISOString().replace('T', ' ').replace('Z', '');
  return `[${time}] [${e.level.toUpperCase()}] [${e.name}] ${e.text}`;
}

export interface DevToolsRowOptions {
  /** 环形缓冲容量（缺省 2000） */
  bufferSize?: number;
}

export const name = 'ac-dev-tools';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'dev-tools',
  label: '开发辅助工具',
  description: '开发辅助工具行（read_logs / reload / reload_modules）',
};

export const inject = ['tools'];

export function apply(ctx: Context, options: DevToolsRowOptions = {}) {
  const capacity = options.bufferSize ?? LOG_BUFFER_SIZE;
  const buffer: LogEntry[] = [];

  // 日志环形缓冲：注册 exporter（随本行 fiber 卸载撤销）。
  // levels.default = DEBUG（数值阈值：3 = 全量收集——数值越大越啰嗦）
  ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      buffer.push({
        ts: message.ts,
        level: message.type,
        name: message.name,
        text: formatPlainText(message),
      });
      if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
    },
  });

  // ---- read_logs：环形缓冲查询（级别/关键词/条数/清空） ----
  ctx.tools.register({
    name: 'read_logs',
    description: '查看后端运行日志（环形缓冲最近条目，可按级别/关键词过滤）。',
    requiredTags: ['dev'],
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数（默认 100，最大 500）', minimum: 1, maximum: 500 },
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: '最低日志级别' },
        keyword: { type: 'string', description: '关键词过滤' },
        clear: { type: 'boolean', description: '先清空缓冲再收集（默认 false）' },
      },
    },
    execute(args) {
      // 工具体抛错由 ac-tools 统一收敛为 { ok:false, error }——不整体 try/catch
      if (args.clear === true) buffer.length = 0;
      let entries = [...buffer];
      const level = args.level as LogEntry['level'] | undefined;
      if (level && level in LEVEL_ORDER) {
        const min = LEVEL_ORDER[level];
        entries = entries.filter((e) => LEVEL_ORDER[e.level] >= min);
      }
      if (typeof args.keyword === 'string' && args.keyword) {
        entries = entries.filter((e) => e.text.includes(args.keyword as string) || e.name.includes(args.keyword as string));
      }
      const limit = Math.min(500, Math.max(1, Number(args.limit) || 100));
      const shown = entries.slice(-limit);
      if (shown.length === 0) {
        return { ok: true, output: { message: '日志缓冲为空' } };
      }
      return { ok: true, output: { count: shown.length, logs: shown.map(renderLine) } };
    },
  });

  // ---- reload：配置热加载（语义化中断） ----
  ctx.tools.register({
    name: 'reload',
    description: '重新加载组合配置（改了 cordis.yml / Agent 配置后调用）。改了源码请用 reload_modules。',
    requiredTags: ['dev'],
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['self', 'global', 'all'],
          description: '范围：self 本 Agent / global 全部 / all 两者（默认）',
        },
      },
    },
    execute(args): ToolResult {
      const scope = (args.scope || 'all') as 'self' | 'global' | 'all';
      return {
        ok: true,
        output: { message: '已请求热重载配置：run 收束后由宿主执行' },
        interrupt: { type: 'reload', reason: `scope=${scope}` },
      };
    },
  });

  // ---- reload_modules：模块热重载（语义化中断） ----
  ctx.tools.register({
    name: 'reload_modules',
    description: '热重载已变更的模块源码（run 收束后由宿主经 fiber 回滚重载执行）。',
    requiredTags: ['dev'],
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '要重载的模块路径（缺省 = 自动探测变更）' },
        // src 兼容参数（M15 对账：src 工具名为 files[]+reason——别名收编）
        files: { type: 'array', items: { type: 'string' }, description: '同 paths（src 参数名兼容）' },
        reason: { type: 'string', description: '重载原因（记入日志）' },
      },
    },
    execute(args): ToolResult {
      const paths = (Array.isArray(args.paths) && args.paths.length > 0
        ? args.paths
        : Array.isArray(args.files)
          ? args.files
          : []) as string[];
      const reason = typeof args.reason === 'string' && args.reason ? args.reason : undefined;
      return {
        ok: true,
        output: { message: '已请求模块热重载：run 收束后由宿主执行' },
        interrupt: {
          type: 'reload-modules',
          ...(paths.length > 0 ? { paths } : {}),
          ...(reason ? { reason } : {}),
        },
      };
    },
  });

  // ---- 宿主半边（2026-09-02 反馈 #1 补齐）：run 收束后执行热重载 + 回投续跑 ----
  // 工具体只发语义化中断（"已请求热重载：run 收束后由宿主执行"），此前
  // 宿主侧无人消费——中断后既没执行重载也没唤醒会话（表现为"会话没有
  // 继续"，且承诺的热重载静默落空）。对齐 ac-restart / ac-plugin-registry
  // 的宿主半边模式：
  //   · reload        → include.refresh()（cordis.yml 重读，行增删事务性应用）
  //   · reload-modules→ ctx.hmr.reloadFiles(paths ?? 水位线发现)（无 hmr 行
  //                     如实报告——非 dev 进程没有模块热重载能力）
  //   · 完成后向原会话回投 [系统通知]（source:'event'，job-wakeup 同款）——
  //     会话不因语义化中断断流，Agent 醒来即知重载结果并可继续任务。
  ctx.on('loop/after-run', (request, result) => {
    if (result.finish !== 'interrupted') return;
    const ti = result.interruptReason?.toolInterrupt;
    if (ti?.type !== 'reload' && ti?.type !== 'reload-modules') return;
    void executeReloadInterrupt(ctx, request.agent, request.conversationId, ti).catch((err: unknown) => {
      ctx.logger.warn('[dev-tools] 热重载执行失败: %C', String(err));
    });
  }, { description: '收束检测 reload 意图 → 宿主热重载 + 回投续跑通知' });
}

/** 热重载中断执行体：reload（include.refresh）/ reload-modules（hmr.reloadFiles） */
async function executeReloadInterrupt(
  ctx: Context,
  agent: string | undefined,
  conversationId: string | undefined,
  ti: { type: string; paths?: unknown; reason?: unknown },
): Promise<void> {
  let report: string;
  if (ti.type === 'reload') {
    // include 子树定位（ecosystem.findIncludeEntry 同款判定：subtree 带
    // refresh + filename）→ 配置热刷新（内容未变 no-op；变更事务性增删行）
    const loader = ctx.get('loader', false) as
      | { entries(): Array<{ subtree?: unknown }> }
      | undefined;
    const include = loader && [...loader.entries()].find((e) => {
      const t = e.subtree;
      return !!t && typeof t === 'object' && 'refresh' in t && 'filename' in t;
    })?.subtree as { refresh(): Promise<void>; filename: string } | undefined;
    if (!include) {
      report = '配置热重载未执行（未找到 include 配置子树——非 yml 驱动的 boot 形态）；';
    } else {
      try {
        await include.refresh();
        report = `配置热重载完成（${include.filename} 已重读，行增删事务性应用）；`;
      } catch (err: unknown) {
        report = `配置热重载失败（${err instanceof Error ? err.message : String(err)}）；`;
      }
    }
  } else {
    const hmr = ctx.get('hmr', false) as
      | { reloadFiles(urls: string[]): Promise<{ ok: boolean; reloaded: string[]; error?: string }>; changedSinceWatermark(): Promise<string[]> }
      | undefined;
    if (!hmr) {
      report = '模块热重载未执行（HMR 未启用——需 --expose-internals 的 dev 进程；改了源码请改用 system_restart）；';
    } else {
      try {
        const paths = Array.isArray(ti.paths) ? (ti.paths as unknown[]).map(String) : [];
        const urls = paths.length > 0
          ? paths.map((p) => pathToFileURL(resolve(process.cwd(), p)).href)
          : await hmr.changedSinceWatermark();
        if (urls.length === 0) {
          report = '模块热重载完成（水位线后无源码变更，无需重载）；';
        } else {
          const outcome = await hmr.reloadFiles(urls);
          report = outcome.ok
            ? `模块热重载完成（${outcome.reloaded.length} 个文件：${outcome.reloaded.slice(0, 10).join(', ')}${outcome.reloaded.length > 10 ? '…' : ''}）；`
            : `模块热重载失败（已回滚，沿用旧版本）：${outcome.error ?? '未知错误'}；`;
        }
      } catch (err: unknown) {
        report = `模块热重载失败：${err instanceof Error ? err.message : String(err)}；`;
      }
    }
  }
  // 回投续跑（原会话唤醒——语义化中断不吞会话）
  const conversation = ctx.get('conversation', false) as
    | { deliver(agent: string, message: string, options: Record<string, unknown>): Promise<unknown> }
    | undefined;
  if (agent && conversationId && conversation) {
    await conversation.deliver(agent, `[系统通知] ${report}可继续刚才的任务。`, {
      sender: agent,
      source: 'event',
      conversationId,
    });
  }
}

/** Message → 纯文本（不渲染颜色；日志检索用） */
function formatPlainText(message: {
  type: string;
  name: string;
  args: unknown[];
}): string {
  return message.args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')
    .replace(/\n/g, '\\n');
}
