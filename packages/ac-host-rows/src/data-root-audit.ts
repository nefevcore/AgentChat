// ============================================================
// data-root-audit.ts —— 数据根分层契约的 boot doctor（数据分层 cr）
//
// 契约文档 = docs/design/assembly/data-root-layers.md（分类表 + 三条操作规则）。
// 本模块是它的机器面：boot 扫数据根顶层，未知目录/文件 warn——
// 「清投影连源数据一起清」类事故的前置哨兵（新顶层名要么进契约，
// 要么是误建）。
//
// 只 warn 不拒启：未知项可能是用户自放文件（judge 不了的以可见性
// 代替裁决——契约文档才是裁决面）。
// ============================================================
import * as fs from 'node:fs';

/**
 * 顶层已知项（契约口径，见 docs/design/assembly/data-root-layers.md）。
 * 兼容窗项（groups / timer / remote / conv-settings / workspaces.json
 * ——迁居 meta/ 前的旧位置）收录但不新增：读侧回落认它们，全部迁出
//  版本后移除并改 warn。
 */
const KNOWN_DIRS = new Set([
  'agents', // 第一层：真值账本（必须备份）
  'meta', // 第二层：小而珍贵、不可重建（必须备份）
  'exports', // 第二层：source 物化面（cr-1165 timer 源触发——按视图重建，备份随源
  'credentials', // 第二层特殊成员：独立隔离（加密/备份策略不同）
  'viewer', // 第三层：纯投影（整树可删、boot 自愈）
  'usage', // 派生流水（半可重建）
  'files', // 第一层附件：工作产物（必须备份）
  'file-snapshots', // 第一层附件（必须备份）
  'sap-adt', // 第一层附件（必须备份）
  'outbox', // durable 队列（勿清！在途 run）
  'profile', // 装配文档（生成物 + 用户编辑件）
  '.runtime', // 运行态（随时可丢）
  'plugins', // UI 插件目录（缺省 <dataRoot>/plugins）
  'skills', // 技能目录（数据根直读面）
  // ---- 迁居兼容窗（旧位置，读侧回落；全部迁出后移除并改 warn）----
  'groups',
  'timer',
  'remote',
  'conv-settings',
]);

const KNOWN_FILES = new Set([
  'config.json', // 全局配置（留根级）
  'workspaces.json', // 兼容窗旧位置（新 = meta/workspaces.json）
  'host-rows.json', // 宿主行集偏好
  'row-catalog.json', // 行集目录投影（cr-1033 B2 部署链随行物化——能力行归包携带面）
]);

/**
 * 扫描数据根顶层：返回未知项名（同时经 warn 逐项告警——注入面便于测试）。
 * 数据根本身缺席/不可读 = 空清单（boot 前置已 mkdir）。
 */
export function auditDataRootLayers(dataRoot: string, warn: (message: string) => void = () => {}): string[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dataRoot, { withFileTypes: true }); } catch { return []; }
  const unknown: string[] = [];
  for (const e of entries) {
    const known = e.isDirectory() ? KNOWN_DIRS.has(e.name) : KNOWN_FILES.has(e.name);
    if (!known) unknown.push(e.name);
  }
  for (const name of unknown) {
    warn('数据根顶层未知项「' + name + '」——不在分层契约内（docs/design/assembly/data-root-layers.md）：' +
      '若为新数据域请入契约/迁 meta/；若是误建请清理。可整树删的只有 viewer/ 与 .runtime/。');
  }
  return unknown;
}
