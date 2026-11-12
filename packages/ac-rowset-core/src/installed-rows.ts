// ============================================================
// installed-rows.ts —— installed.yml 登记簿 → 反向适配分析（cr-908 /
// cr-1001 菜单合流 / cr-1004 §三：基座分析包，非包投影基座）
//
// 登记的是事实，适配是求值：installed.yml 只记 id/name/owner/disabled
//（无 scope 投影——双源漂移面消灭）；每个基座求值器反向分析包声明
// 命中自己的 face（ac.faces.<face> / manifest.rows 声明）：
//   fit(installed.yml, base) = { row | p ∈ installed ∧ p 未 disabled
//     ∧ p 的包声明命中本基座 face ∧ owner 锚放行 }
// 不适配 = 自然跳过 + 警告（降级语义，同「点名缺席」口径）。
// face 词表随基座泛化（processes.json 注册新进程种类零改动）；
// host 面 fail-closed（assembly-governance.md §二——宿主是信任域）。
//
// owner 锚（§4.3）：行仅进 owner Agent 候选集（非 owner 壳不解析
// 不装载）。词形分轨（§4.2）：name = link:<目录>（目录形态）∨ 裸包名
//（npm 形态 → <dataRoot>/profile/node_modules/<name>）。物化缺席 =
// 警告 + 跳过 + 上报（降级语义——禁止阻断 boot）。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import yaml from 'js-yaml';
import { readPluginRowDeclarations } from './plugin-rows.ts';
import type { RowDescriptor } from './rowset.ts';

/** installed.yml 条目（装载菜单消费面子集——写侧全形状见
 * ac-plugin-core/src/installed.ts；replace 消费复用同形） */
export interface InstalledMenuEntry {
  id: string;
  name: string;
  owner?: string;
  disabled?: boolean;
}

/** 基座 → face 键（cr-1004 §三：各基座求值器独立查自己的键，零干扰；
 * host 面 fail-closed——第三方宿主行不开放〔assembly-governance §二〕） */
const PROC_FACE: Record<string, string | null> = { shell: 'node', webui: 'web', host: null };

function readInstalledMenu(dataRoot: string): InstalledMenuEntry[] {
  const profile = path.join(dataRoot, 'profile');
  // installed.yml 单源；旧名 installed.patch.yml 只读兼容（安装器单写者
  // 首次写新名即消亡——cr-1004 文件族改名窗口）
  let file = path.join(profile, 'installed.yml');
  if (!fs.existsSync(file)) file = path.join(profile, 'installed.patch.yml');
  try {
    const data = yaml.load(fs.readFileSync(file, 'utf-8')) as unknown;
    if (!Array.isArray(data)) return []; // 缺席/坏形 = 空菜单（安装器读路径已 fail-loud）
    return data.filter((e): e is InstalledMenuEntry =>
      e !== null && typeof e === 'object' && typeof (e as InstalledMenuEntry).id === 'string');
  } catch {
    return [];
  }
}

/** 条目 → 物化目录（词形分轨单源：link: 目录形态 / 裸名 npm 形态；
 * shell.patch.yml replace 词形同源消费） */
export function materializedDirOf(dataRoot: string, name: string): string {
  if (name.startsWith('link:')) return name.slice('link:'.length);
  return path.join(dataRoot, 'profile', 'node_modules', name);
}

/** 包声明是否命中 face（反向适配判据单源：ac.faces.<face> 在场 ∨
 * manifest.rows 声明〔行集面声明的包即 node face〕；package 形态的
 * ac.provides.tools 投影同认——历史容忍面） */
export function packageDeclaresFace(dir: string, face: string): boolean {
  let pkg: { ac?: { faces?: Record<string, unknown>; provides?: { tools?: string[] } } } | null = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
  } catch {
    pkg = null; // 无 package.json（纯 manifest 形态）——继续走 manifest 判据
  }
  if (pkg?.ac?.faces?.[face] !== undefined) return true;
  if (face === 'node' && (pkg?.ac?.provides?.tools ?? []).length > 0) return true;
  if (face !== 'node') return false;
  return fs.existsSync(path.join(dir, 'manifest.json'));
}

/** 目录 → 行描述符投影（manifest.rows 声明优先；package 形态经
 * provides.tools 投影——ac.faces.node.entry 为装载面，行集面词形同源；
 * shell.patch.yml replace 消费同款投影） */
export function rowDescriptorsOfDir(entry: InstalledMenuEntry, dir: string, warnings: string[]): RowDescriptor[] {
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
    return [{ id: entry.id, tree: 'shell' as const, path: dir }];
  } catch {
    warnings.push(entry.id + '：manifest/package 声明均缺席——跳过');
    return [];
  }
}



/** 存在合成基线指纹（cr-1004 §五 `# ac-base` 戳单源）：本基座文档
 * + installed 登记的规范化内容哈希（sha256 前 16 hex）。agent.patch.yml
 * 差量恒对戳对应的存在合成求值——漂移 = rebase（迁移/编辑器重算戳），
 * 基座/安装态演化对存量实例不静默传导。 */
export function assemblyBaseStamp(dataRoot: string, proc: string): string {
  const profile = path.join(dataRoot, 'profile');
  const readOpt = (file: string): string => {
    try {
      return fs.readFileSync(file, 'utf-8');
    } catch {
      return '';
    }
  };
  const baseText = readOpt(path.join(profile, proc + '.yml'))
    || readOpt(path.join(profile, proc + '.patch.yml'));
  const installedText = readOpt(path.join(profile, 'installed.yml'))
    || readOpt(path.join(profile, 'installed.patch.yml'));
  return crypto.createHash('sha256').update(baseText + String.fromCharCode(0) + installedText).digest('hex').slice(0, 16);
}

/** installed.yml → fit(installed × 本基座 face) 行集（owner 锚过滤 +
 * 反向适配分析 + 降级语义；host 面 fail-closed = 空集） */
export function fitInstalledRows(dataRoot: string, proc: string, agentId: string): { rows: RowDescriptor[]; warnings: string[] } {
  const face = PROC_FACE[proc] ?? null;
  const warnings: string[] = [];
  const rows: RowDescriptor[] = [];
  if (face === null) return { rows, warnings }; // host：门关着（管控策略，非代数）
  for (const entry of readInstalledMenu(dataRoot)) {
    if (entry.disabled === true) continue; // custom 层停用
    if (entry.owner !== undefined && entry.owner !== agentId) continue; // owner 锚
    const dir = materializedDirOf(dataRoot, entry.name);
    if (!fs.existsSync(dir)) {
      warnings.push('installed 登记而物化缺席（跳过 + 上报）：' + entry.id + '（' + entry.name + '）');
      continue;
    }
    if (!packageDeclaresFace(dir, face)) continue; // 不适配本基座 = 自然跳过（零干扰）
    rows.push(...rowDescriptorsOfDir(entry, dir, warnings));
  }
  return { rows, warnings };
}
