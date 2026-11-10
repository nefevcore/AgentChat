// ============================================================
// plugin-rows.ts —— 插件行集条目投影（8.8 前置第六批 cr-543；cr-1001
// 镜像窗口退役后仅存 manifest 投影 + 目录合并纯函数）
//
// install = 授权动作（A7/A10）：已安装插件的行集条目由其 manifest.rows
// 声明，经 installed.patch.yml 菜单进壳行集派生
//（installed-rows.ts——cr-908 装配菜单合流后的唯一装载输入）。
//
// 三条判据（承 R0a 判据 1「agent 代码零宿主驻留」+ 保留字护栏 F13/G1）：
//   · 插件行恒 tree='shell'——插件代码只在壳进程内装载，宿主装配面
//     不出现第三方行（manifest 自述 tree 一律忽略）；
//   · path 恒 = 安装目录（单源）——指纹（R-7）与装配寻址按此定位，
//     插件不得自述路径（否则指纹可指向任意目录）；
//   · 撞名出厂行 = 丢弃并告警——动态行不许覆盖出厂行（保留字护栏）。
// ============================================================
import type { RowDescriptor, RowsetCatalog } from './rowset.ts';

/** manifest.rows 条目（插件自述的行集条目） */
export interface PluginRowDeclaration {
  /** 行 id（两树同命名域；param-case） */
  id: string;
  /** 行提供的工具名清单 */
  tools?: string[];
  /** 捆绑词（fs / infra 类按组消解） */
  bundle?: string;
  /** 硬依赖行 id 清单（行集闭包） */
  requires?: string[];
  /** 一句话描述 */
  description?: string;
}

const ROW_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 字符串数组字段（非数组/含非字符串 → undefined 并告警） */
function stringsOf(value: unknown, field: string, owner: string, warnings: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v === '')) {
    warnings.push(owner + '：manifest.rows 的 ' + field + ' 必须是字符串数组——已忽略');
    return undefined;
  }
  const list = (value as string[]).slice();
  return list.length > 0 ? list : undefined;
}

/**
 * 读插件 manifest 的行集声明（fail-soft：非法条目告警跳过）。
 * 未声明 rows = 无行集条目（插件只提供工具时不必声明）。
 */
export function readPluginRowDeclarations(manifestRaw: unknown): {
  decls: PluginRowDeclaration[];
  warnings: string[];
} {
  const warnings: string[] = [];
  if (manifestRaw === null || typeof manifestRaw !== 'object') {
    return { decls: [], warnings };
  }
  const rowsRaw = (manifestRaw as Record<string, unknown>).rows;
  if (rowsRaw === undefined) return { decls: [], warnings };
  if (!Array.isArray(rowsRaw)) {
    warnings.push('manifest.rows 必须是数组——已忽略');
    return { decls: [], warnings };
  }
  const decls: PluginRowDeclaration[] = [];
  for (const item of rowsRaw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push('manifest.rows 条目必须是对象——已跳过');
      continue;
    }
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id.trim() : '';
    if (!ROW_ID_RE.test(id)) {
      warnings.push('manifest.rows 条目 id 非法（param-case）：' + JSON.stringify(obj.id) + '——已跳过');
      continue;
    }
    const decl: PluginRowDeclaration = { id };
    const tools = stringsOf(obj.tools, 'tools', id, warnings);
    if (tools !== undefined) decl.tools = tools;
    const requires = stringsOf(obj.requires, 'requires', id, warnings);
    if (requires !== undefined) decl.requires = requires;
    if (typeof obj.bundle === 'string' && obj.bundle !== '') decl.bundle = obj.bundle;
    if (typeof obj.description === 'string' && obj.description !== '') decl.description = obj.description;
    decls.push(decl);
  }
  return { decls, warnings };
}

/**
 * 插件行集条目（树归属恒 shell + 路径恒安装目录单源）。
 * @param installDir 安装目录（绝对路径——指纹寻址与装配 import 的基址）
 */
export function pluginRowsOf(
  pluginName: string,
  installDir: string,
  manifestRaw: unknown,
): { rows: RowDescriptor[]; warnings: string[] } {
  const { decls, warnings } = readPluginRowDeclarations(manifestRaw);
  const rows: RowDescriptor[] = decls.map((decl) => ({
    id: decl.id,
    tree: 'shell',
    ...(decl.tools !== undefined ? { tools: decl.tools } : {}),
    ...(decl.bundle !== undefined ? { bundle: decl.bundle } : {}),
    ...(decl.requires !== undefined ? { requires: decl.requires } : {}),
    ...(decl.description !== undefined ? { description: decl.description } : {}),
    path: installDir,
  }));
  return { rows, warnings: warnings.map((w) => pluginName + '：' + w) };
}

/**
 * 目录合并（出厂目录 ∪ 插件行集）：撞名丢弃插件行（保留字护栏）。
 * 出厂目录优先，插件行其次；插件行内部重复 id 后到丢弃。
 */
export function mergeRowsetCatalog(
  base: RowsetCatalog,
  extra: RowDescriptor[],
): { catalog: RowsetCatalog; warnings: string[] } {
  const warnings: string[] = [];
  const known = new Set(base.rows.map((r) => r.id));
  const appended: RowDescriptor[] = [];
  for (const row of extra) {
    if (known.has(row.id)) {
      warnings.push('插件行与既有行撞名，已丢弃：' + row.id);
      continue;
    }
    known.add(row.id);
    appended.push(row);
  }
  return { catalog: { rows: [...base.rows, ...appended] }, warnings };
}

