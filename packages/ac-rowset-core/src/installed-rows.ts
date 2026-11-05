// ============================================================
// installed-rows.ts —— installed.patch.yml → 行集菜单投影（cr-908 /
// cr-901 v2.1 批6 切片一：装配菜单合流——安装器代写的登记文档进壳
// 行集派生，plugin-rows.json 转纯镜像窗口〔拆旧收口件〕）
//
// owner 锚（§4.3）：行仅进 owner Agent 候选集（非 owner 壳不解析
// 不装载）；scope 面：shell（缺省）进壳菜单，host/webui 不在本投影。
// 词形分轨（§4.2）：name = link:<目录>（目录形态）∨ 裸包名（npm 形态
// → <dataRoot>/profile/node_modules/<name>）。物化缺席 = 警告 + 跳过
// + 上报（降级语义——禁止阻断 boot）。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { readPluginRowDeclarations } from './plugin-rows.ts';
import type { RowDescriptor } from './rowset.ts';

/** installed.patch.yml 条目（装载菜单消费面子集——写侧全形状见
 * ac-plugin-core/src/installed.ts） */
interface InstalledMenuEntry {
  id: string;
  name: string;
  owner?: string;
  scope?: string;
  disabled?: boolean;
}

function readInstalledMenu(dataRoot: string): InstalledMenuEntry[] {
  try {
    const data = yaml.load(fs.readFileSync(path.join(dataRoot, 'profile', 'installed.patch.yml'), 'utf-8')) as unknown;
    if (!Array.isArray(data)) return []; // 缺席/坏形 = 空菜单（安装器读路径已 fail-loud）
    return data.filter((e): e is InstalledMenuEntry =>
      e !== null && typeof e === 'object' && typeof (e as InstalledMenuEntry).id === 'string');
  } catch {
    return [];
  }
}

/** 条目 → 物化目录（词形分轨单源：link: 目录形态 / 裸名 npm 形态） */
function materializedDirOf(dataRoot: string, name: string): string {
  if (name.startsWith('link:')) return name.slice('link:'.length);
  return path.join(dataRoot, 'profile', 'node_modules', name);
}

/** 目录 → 行描述符投影（manifest.rows 声明优先；package 形态经
 * provides.tools 投影——ac.faces.node.entry 为装载面，行集面词形同源） */
function rowDescriptorsOfDir(entry: InstalledMenuEntry, dir: string, warnings: string[]): RowDescriptor[] {
  const manifestPath = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const { decls, warnings: w } = readPluginRowDeclarations(raw);
      warnings.push(...w);
      return decls.map((d) => ({ ...d, tree: 'shell' as const, path: dir }));
    } catch {
      warnings.push(entry.id + '：manifest.json 坏 JSON——跳过');
      return [];
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as {
      ac?: { provides?: { tools?: string[] }; faces?: { node?: { entry?: string } } };
    };
    const tools = pkg.ac?.provides?.tools ?? [];
    return [{ id: entry.id, tree: 'shell' as const, ...(tools.length > 0 ? { tools } : {}), path: dir }];
  } catch {
    warnings.push(entry.id + '：manifest/package 声明均缺席——跳过');
    return [];
  }
}

/** installed.patch.yml → 行集菜单（owner 锚过滤 + 降级语义） */
export function installedRowDescriptors(dataRoot: string, agentId: string): { rows: RowDescriptor[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: RowDescriptor[] = [];
  for (const entry of readInstalledMenu(dataRoot)) {
    if (entry.disabled === true) continue; // custom 层停用
    if (entry.scope !== undefined && entry.scope !== 'shell') continue; // host/webui 面
    if (entry.owner !== undefined && entry.owner !== agentId) continue; // owner 锚
    const dir = materializedDirOf(dataRoot, entry.name);
    if (!fs.existsSync(dir)) {
      warnings.push('installed.patch 点名而物化缺席（跳过 + 上报）：' + entry.id + '（' + entry.name + '）');
      continue;
    }
    rows.push(...rowDescriptorsOfDir(entry, dir, warnings));
  }
  return { rows, warnings };
}
