// ============================================================
// webui-layer.ts —— webui 装配文档分层合成（cr-905 / cr-901 v2.1
// 批3 切片三，docs/design/ui-plugin-form.md §四）
//
// 分层（前端侧求值——boot graph 端点内做）：
//   基座(profile/webui.patch.yml——工厂通道出厂清单)
//     → webui-custom.patch.yml（用户 disable/override）
//     → installed.patch.yml(scope:webui 条目——第三方 web 面)
//     → 目录扫描对账：文档点名而物化缺席 = 警告 + 跳过 + 上报；
//       物化在场而文档未点名 = 警告 + 兼容窗口仍下发（v1 存量
//       manifest 插件不经文档安装——双读窗口语义，批 6 收口）。
//
// 基座缺席（旧式数据根）= 纯目录扫描透传（行为等价——部署链未跑处
// 不改装配语义）。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { assembleBootGraph, type BootGraphEntry } from './manifest.ts';

/** 基座/custom 文档内条目（官方方言骨架——id 定位 + disable 面） */
interface LayerEntry {
  id: string;
  disabled?: boolean;
  [key: string]: unknown;
}

/** installed.patch.yml 内 webui 面 条目（ac-plugin-core 词形子集） */
interface InstalledWebuiEntry {
  id: string;
  scope?: string;
  disabled?: boolean;
}

function readLayerDoc(file: string): LayerEntry[] | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return null; // 缺席 = 无该层（基座缺席 = 旧式透传语义）
  }
  const data = yaml.load(text) as unknown;
  if (!Array.isArray(data)) {
    throw new Error('webui 装配文档顶层必须是条目数组：' + file);
  }
  return data.filter((e): e is LayerEntry =>
    e !== null && typeof e === 'object' && !Array.isArray(e) && typeof (e as LayerEntry).id === 'string');
}

/** webui 分层求值（纯函数 + fs）：文档意志 × 目录物化 → boot graph */
export function synthesizeWebuiGraph(pluginsDir: string, profileDir: string): {
  graph: BootGraphEntry[];
  warnings: string[];
} {
  const scan = assembleBootGraph(pluginsDir);
  const base = readLayerDoc(path.join(profileDir, 'webui.patch.yml'));
  if (base === null) {
    return scan; // 旧式数据根：部署链未跑，纯目录扫描透传（行为等价）
  }
  const warnings: string[] = [...scan.warnings];
  const custom = readLayerDoc(path.join(profileDir, 'webui-custom.patch.yml')) ?? [];
  let installed: InstalledWebuiEntry[] = [];
  try {
    const raw = yaml.load(fs.readFileSync(path.join(profileDir, 'installed.patch.yml'), 'utf-8')) as unknown;
    if (Array.isArray(raw)) installed = raw as InstalledWebuiEntry[];
  } catch {
    // installed 缺席 = 无第三方 web 面（坏文件已在安装器读路径 fail-loud）
  }
  const disabled = new Set([
    ...custom.filter((e) => e.disabled === true).map((e) => e.id),
    ...installed.filter((e) => e.disabled === true).map((e) => e.id),
  ]);
  const desired = new Set<string>([
    ...base.map((e) => e.id),
    ...installed.filter((e) => e.scope === 'webui').map((e) => e.id),
  ]);
  for (const id of disabled) desired.delete(id);
  const graph: BootGraphEntry[] = [];
  const scannedNames = new Set(scan.graph.map((e) => e.name));
  for (const entry of scan.graph) {
    // 显式停用赢过一切（custom/installed disabled——含存量兼容窗口）
    if (disabled.has(entry.name)) {
      warnings.push('webui 条目被装配文档停用（跳过）：' + entry.name);
      continue;
    }
    if (desired.has(entry.name)) {
      graph.push(entry);
      continue;
    }
    // 物化在场而文档未点名：v1 存量（manifest 流安装、不经文档）兼容窗口
    warnings.push('webui 装配文档未点名而目录在场（v1 存量兼容窗口仍下发）：' + entry.name);
    graph.push(entry);
  }
  for (const id of desired) {
    if (!scannedNames.has(id)) {
      warnings.push('webui 装配文档点名而物化缺席（跳过 + 上报）：' + id);
    }
  }
  return { graph, warnings };
}
