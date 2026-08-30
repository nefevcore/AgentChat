// ============================================================
// ac-dev-tools/src/index.ts —— 开发辅助工具行
// （read_logs / reload / reload_modules）
//
// src dev 平移（输出归一 {ok, output/interrupt}）。preview 形态差异：
//   · read_logs 数据源 = ctx.logger.exporter 注册的环形缓冲（订阅型，
//     随本行 fiber 卸载撤销——替代 src 的全局日志缓冲单例）
//   · reload / reload_modules 走 M11 语义化中断通道：工具体不执行
//     宿主级热重载，返回 ToolResult.interrupt，loop 收束后宿主执行
//     （fiber 回滚重载天然覆盖 reload 场景——ADR-2）
// 能力门禁：requires ['dev']（ac-security 行执行；缺省放行 base）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';

/** 环形缓冲容量（对齐 src「最近 2000 条」） */
export const LOG_BUFFER_SIZE = 2000;

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
        text: Logger_formatPlainText(message),
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
      try {
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
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
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
}

/** Message → 纯文本（不渲染颜色；日志检索用） */
function Logger_formatPlainText(message: {
  type: string;
  name: string;
  args: unknown[];
}): string {
  return message.args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')
    .replace(/\n/g, '\\n');
}
