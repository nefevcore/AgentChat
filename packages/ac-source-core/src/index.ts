// ============================================================
// ac-source-core —— source 采集域 owning 包（cr-1165 timer-v3 再下一批）
//
// 三段架构（timer-v3 §二）：采集层（本包，受信代码）→ 触发层
// （timers 行，哑）→ 判定/执行层（Agent run）。本包承载：
//   · 物化契约与纯函数 —— materialize.ts（rows.jsonl / meta.json、
//     快照 diff、seq 单调、滚动、readRowsSince）
//   · 事件目录 —— events.ts（source/updated emit）
//   · fs-source 万能适配行 —— watch 任意目录物化 rows + 发事件的
//     适配器（OS cron / 任意外部工具写目录 → timer 可见，平台零执行）
//
// 采集与探测正交（§五）：采集节奏（行配置 cadence）与触发节奏（条目）
// 互不绑架；采集失败只导致导出陈旧（staleAfter），不进 timer 错误链。
// 摘除良定义降级：导出停更 → 订阅条目 stale 唤醒或 dormant。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import { parseInterval } from 'ac-timer-core';
import { materializeSnapshot, type FsSnapshotInput } from './materialize.ts';

export { readMeta, readRowsSince, materializeSnapshot, MAX_SOURCE_ROWS } from './materialize.ts';
export type { SourceMeta, FsSnapshotInput } from './materialize.ts';
export type { SourceUpdatedPayload } from './events.ts';
// 契约出口：事件目录类型增强（events.ts）
export type {} from './events.ts';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'fs-source',
  label: 'fs 采集行',
  description: '目录快照物化（exports/fs/<view>/）+ source/updated 事件——外部工具写目录即可被 timer 触发（配置 source.fs.roots）',
  automatic: true,
};

/** 行配置 */
export interface FsSourceRowOptions {
  /** 数据根（物化落 <dataRoot>/exports/fs/；缺省 AGENTCHAT_DATA_ROOT ?? './data'） */
  dataRoot?: string;
  /** 扫描节奏覆盖（测试注入；缺省读配置 source.fs.cadence，再缺省 30s） */
  cadenceMs?: number;
}

/** 采集源配置（config.json source.fs 域——用户数据非代码配置） */
interface FsSourceConfig {
  roots: Array<{ id: string; root: string; glob?: string }>;
  cadence?: string;
}

const DEFAULT_CADENCE_MS = 30_000;

/** 读源配置（非法项跳过——fail-soft：采集面单源坏不拖全行） */
function readFsConfig(raw: unknown): { roots: FsSourceConfig['roots']; cadenceMs: number } {
  const cfg = raw !== null && typeof raw === 'object' && Array.isArray((raw as FsSourceConfig).roots)
    ? (raw as FsSourceConfig)
    : { roots: [] };
  const roots = cfg.roots.filter((r) => typeof r.id === 'string' && r.id !== '' && typeof r.root === 'string' && r.root !== '');
  const cadenceMs = parseInterval(typeof cfg.cadence === 'string' ? cfg.cadence : '') ?? DEFAULT_CADENCE_MS;
  return { roots, cadenceMs };
}

/**
 * 扫描目录为快照行（相对路径稳定键；glob v1 = 后缀匹配如 '*.md'——
 * 前缀/字符类不进 v1，防词汇表癌变）。
 */
function scanRoot(root: string, glob: string | undefined): FsSnapshotInput[] {
  const suffix = glob !== undefined && glob.startsWith('*.') ? glob.slice(1) : null;
  const out: FsSnapshotInput[] = [];
  const walk = (dir: string, rel: string): void => {
    let names: fs.Dirent[];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of names) {
      const relPath = rel === '' ? ent.name : rel + '/' + ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full, relPath); continue; }
      if (!ent.isFile()) continue;
      if (suffix !== null && !ent.name.endsWith(suffix)) continue;
      try {
        const st = fs.statSync(full);
        out.push({ path: relPath, mtime: Math.round(st.mtimeMs), size: st.size });
      } catch { /* 竞态消失跳过 */ }
    }
  };
  walk(root, '');
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

export const name = 'ac-source-core';

/**
 * fs-source 行（Service 形态——static inject = ['timer','config']：
 * ctx.interval 由 cordis-timer 服务激活后挂上、roots 配置面恒在场；
 * fiber 依赖等待保证构造期两者就位，cr-282 start-time 软取坑）。
 * 按配置节奏扫描 roots → 快照 diff 物化 → 变化即 source/updated。
 * 无 roots = 空行（零定时器）；config/changed 热重载 roots（增删源不重启）。
 */
export class FsSourceService extends Service {
  static inject = ['timer', 'config'];

  private readonly dataRoot: string;
  private timerDispose?: () => void;

  constructor(ctx: Context, options: FsSourceRowOptions = {}) {
    super(ctx, 'fs-source');
    this.dataRoot = path.resolve(options.dataRoot ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');
    ctx.on('config/changed', () => this.reschedule(options));
    this.reschedule(options);
    ctx.fiber.effect(() => () => this.timerDispose?.(), 'fs-source.stop');
  }

  private reschedule(options: FsSourceRowOptions): void {
    if (this.timerDispose !== undefined) { this.timerDispose(); this.timerDispose = undefined; }
    const config = this.ctx.get('config') as { get<T>(key: string, fallback?: T): T | undefined } | undefined;
    const { roots, cadenceMs } = readFsConfig(config?.get('source.fs'));
    if (roots.length === 0) return; // 无源 = 零定时器（空闲自退）
    const cadence = options.cadenceMs ?? cadenceMs;
    this.sweep(roots, cadence);
    this.timerDispose = this.ctx.interval(() => this.sweep(roots, cadence), cadence);
  }

  private sweep(roots: FsSourceConfig['roots'], cadenceMs: number): void {
    for (const r of roots) {
      const dir = path.join(this.dataRoot, 'exports', 'fs', r.id);
      try {
        const res = materializeSnapshot(dir, scanRoot(path.resolve(r.root), r.glob), cadenceMs * 2);
        if (res.appended > 0) {
          this.ctx.emit('source/updated', { source: 'fs', view: r.id, seq: res.seq });
        }
      } catch (err: unknown) {
        // 采集失败只导致导出陈旧（不进 timer 错误链——正交原则）
        this.ctx.logger.warn('[fs-source] 物化失败（' + r.id + '）：' + (err instanceof Error ? err.message : String(err)));
      }
    }
  }
}

/** 插件入口（loader 形态）：apply → ctx.plugin(FsSourceService)——inject 声明在类上 */
export function apply(ctx: Context, options: FsSourceRowOptions = {}) {
  ctx.plugin(FsSourceService, options);
}
