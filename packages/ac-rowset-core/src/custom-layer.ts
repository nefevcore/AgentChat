// ============================================================
// custom-layer.ts —— <proc>.patch.yml 用户全局差量层（cr-909 / cr-1003
// 词形扩展 / cr-1004 文件族改名：原 <proc>-custom.patch.yml——「patch」
// 中缀专属差量文档，装配+管控混名的旧名退役）。写者 = 设置 UI/用户
//（repo 不部署本文件——用户域；数据根 profile/ 下）。
//
// 词形（cr-1004 §四——全层共用一套，cordis 方言邻接；层权限表在
// assembly-governance.md §一）：
//   - { id }                              加法（行 id / 工具名 / 捆绑词）
//   - { id, config: {...} }               行内配置（levels 归位——cordis 原生）
//   - { id, disabled: true }              停用基座行（全局减法）
//   - { id, disabled: true, except: [agentId…] }
//                                         停用豁免——「全局关、单个
//                                         Agent 开」；否决权与豁免权都
//                                         住用户手写文档（仅壳面消费：
//                                         宿主无 Agent 维度，except 忽略）
//   - { id, replace: 'link:<dir>' ∨ 裸包名 }
//                                         实现替换——id 不变、path 换向
//                                         （词形分轨同 installed 单源）；
//                                         授权住用户域：插件 manifest 不
//                                         得自述替换基座（保留字护栏）。
//                                         替换件 manifest.rows 声明同 id
//                                         条目时覆盖 tools/requires，未
//                                         声明 = 纯实现替换（继承基座面）。
//   恒并基座席位停用拒绝生效——防「能 boot 缺收信面」的静默半激活
//   （席位替换允许——这正是 replace 的主场景）；护栏由求值引擎经
//   seatIds 注入（cr-1004 evaluate.ts）。
//
// 全层 fail-soft：用户域文件缺席/损坏/词形冲突 = 警告 + 降级继续，不
// 阻断 boot（设置 UI 可自修复）。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { materializedDirOf, rowDescriptorsOfDir } from './installed-rows.ts';
import type { AssemblyEntry } from './evaluate.ts';
import type { RowDescriptor } from './rowset.ts';

/** 用户全局差量层（disabled/except/config 归 evaluate 消费；replace 由
 * resolveReplacements 先行换向解析——引擎不见 fs） */
export interface AssemblyPatchLayer {
  entries: AssemblyEntry[];
  /** 实现替换：基座行 id → 实现目录词（link: ∨ 裸包名——词形分轨同 installed） */
  replace: Map<string, string>;
  warnings: string[];
}

/** 读 <proc>.patch.yml（缺席 = 空层；损坏 = 空层 + 警告——用户域
 * 文件不阻断 boot，设置 UI 可自修复）。旧名 <proc>-custom.patch.yml
 * 只读兼容（cr-1004 改名窗口——用户手写域无单写者，不强制迁移）。 */
export function readAssemblyPatch(profileDir: string, proc: 'host' | 'shell' | 'webui'): AssemblyPatchLayer {
  let file = path.join(profileDir, proc + '.patch.yml');
  if (!fs.existsSync(file)) file = path.join(profileDir, proc + '-custom.patch.yml');
  if (!fs.existsSync(file)) return { entries: [], replace: new Map(), warnings: [] }; // 缺席 = 空层（常态）
  const label = path.basename(file);
  let entries: AssemblyEntry[];
  let raw: Array<Record<string, unknown>>;
  try {
    const data = yaml.load(fs.readFileSync(file, 'utf-8')) as unknown;
    if (!Array.isArray(data)) {
      return { entries: [], replace: new Map(), warnings: [label + ' 顶层非数组（按空层继续）'] };
    }
    raw = data.filter((e): e is Record<string, unknown> =>
      e !== null && typeof e === 'object' && typeof (e as Record<string, unknown>).id === 'string');
  } catch (err: unknown) {
    return { entries: [], replace: new Map(), warnings: [label + ' 不可读（按空层继续）：' + (err instanceof Error ? err.message : String(err))] };
  }
  const entriesOut: AssemblyEntry[] = [];
  const replace = new Map<string, string>();
  const warnings: string[] = [];
  for (const obj of raw) {
    const entry: AssemblyEntry = { id: obj.id as string };
    const exceptList = stringsOf(obj.except);
    if (exceptList !== undefined && obj.disabled !== true) {
      warnings.push(entry.id + '：except 只随 disabled 生效——已忽略');
    }
    if (obj.disabled === true) {
      entry.disabled = true;
      if (exceptList !== undefined) entry.except = exceptList;
    }
    if (obj.config !== null && typeof obj.config === 'object' && !Array.isArray(obj.config)) {
      entry.config = obj.config as Record<string, unknown>;
    }
    if (typeof obj.replace === 'string' && obj.replace !== '') {
      if (obj.disabled === true) {
        warnings.push(entry.id + '：disabled 与 replace 互斥（同条目）——按停用生效，replace 已忽略');
      } else {
        replace.set(entry.id, obj.replace);
      }
    }
    entriesOut.push(entry);
  }
  return { entries: entriesOut, replace, warnings };
}

/** 字符串数组字段（非数组/含非字符串/空 → undefined） */
function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v === '')) return undefined;
  const list = value as string[];
  return list.length > 0 ? list : undefined;
}

/**
 * replace 先行换向解析（§四：replace 在 <base>.patch.yml 层先行换向，
 * agent.patch.yml 对换向后的行正常加法点名）：id 不变、path 换向；席位
 * 替换的主场景在此放行。全程警告降级，不 throw——用户域 fail-soft。
 */
export function resolveReplacements(
  rows: RowDescriptor[],
  replace: Map<string, string>,
  dataRoot: string,
): { rows: RowDescriptor[]; replacedIds: Set<string>; warnings: string[] } {
  const warnings: string[] = [];
  let out = rows;
  const replacedIds = new Set<string>();
  if (replace.size === 0) return { rows: out, replacedIds, warnings };
  const next = [...out];
  for (const [id, name] of replace) {
    const index = next.findIndex((row) => row.id === id);
    if (index < 0) {
      warnings.push('replace 点名不在基座菜单（跳过）：' + id);
      continue;
    }
    const dir = materializedDirOf(dataRoot, name);
    if (!fs.existsSync(dir)) {
      warnings.push('replace 物化缺席，保留基座行（跳过）：' + id + '（' + name + '）');
      continue;
    }
    const decls = rowDescriptorsOfDir({ id, name }, dir, warnings);
    const decl = decls.find((row) => row.id === id);
    if (decls.length > 1) {
      warnings.push(id + '：替换件声明多行条目，仅同 id 条目生效，其余忽略');
    }
    const base = next[index]!;
    next[index] = {
      ...base,
      path: dir,
      ...(decl !== undefined && decl.tools !== undefined ? { tools: decl.tools } : {}),
      ...(decl !== undefined && decl.requires !== undefined ? { requires: decl.requires } : {}),
    };
    replacedIds.add(id);
  }
  out = next;
  return { rows: out, replacedIds, warnings };
}
