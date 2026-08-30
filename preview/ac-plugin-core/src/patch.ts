// ============================================================
// ac-plugin-core/src/patch.ts —— cordis.patch.yml 行偏好层文件域（M23 A2）
//
// <AGENTCHAT_DATA_ROOT>/cordis.patch.yml = 本机行偏好层（声明式 patch，
// 官方 PatchOptions 形状；第一期只用 {id, disabled}）：
//   · cordis.yml 出厂态（git 管理，永不运行时写入）
//   · patch 文件 = 本机偏好（人可读可手工急救——fail-soft 是核心卖点）
//   · registry.json 安装态（动态插件；boot 扫描恢复）
//   · settings[具名] per-Agent 启用表达（M24 X1 词汇收口）
//
// 容错（F12/M6）：文件不存在/损坏 → warn + 空数组（fail-soft）；未知键
// 与形态错误 warn 不阻断（applyEntryPatches 把非保留键当 overrides 直塞
// entry 零告警零效果——本层读入时先行 warn，文件作者可见）。
// 作用域 = include 管理的 yml 行树；ctx.plugin() 直挂的动态行不建 Entry、
// 不经 patch 管道（E4 熔断两层化的依据）。
// 写口与 registry mutation 共用数据根串行队列 + 原子写（F5/G10）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { atomicWriteFile, withRootLock } from './fsx.ts';

/** patch 文件条目（官方 PatchOptions 的首期子集 + 透传未知键） */
export interface PatchFileEntry {
  id: string;
  disabled?: boolean | null;
  [key: string]: unknown;
}

/** 读取结果（patches + 容错告警——纯库不落日志，调用方决定 sink） */
export interface PatchFileRead {
  patches: PatchFileEntry[];
  warnings: string[];
}

/** patch 文件路径（<root>/cordis.patch.yml） */
export function patchFilePath(root: string): string {
  return path.join(root, 'cordis.patch.yml');
}

/** 保留键（applyEntryPatches 语义内）；其余键 = overrides（warn 提示） */
const RESERVED_KEYS = new Set(['id', 'insert', 'name', 'config', 'group', 'disabled', 'inject', 'intercept', 'isolate']);

/**
 * 读 patch 文件（fail-soft）：
 *   · 不存在 → 空数组（首次启动常态）
 *   · 损坏/非数组 → warn + 空数组（文件人可读可手工急救，坏文件不阻断 boot）
 *   · 无 id / 非 id:string 条目 → warn 跳过
 *   · 未知键 → warn 不阻断（透传保留——insert 型 patch 等进阶用法留给 P7）
 */
export function readPatchFile(root: string): PatchFileRead {
  const file = patchFilePath(root);
  const warnings: string[] = [];
  if (!fs.existsSync(file)) return { patches: [], warnings };
  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(file, 'utf-8'));
  } catch (err: unknown) {
    warnings.push(`cordis.patch.yml 解析失败（按空 patch 处理）: ${err instanceof Error ? err.message : String(err)}`);
    return { patches: [], warnings };
  }
  if (raw === null || raw === undefined) return { patches: [], warnings };
  if (!Array.isArray(raw)) {
    warnings.push('cordis.patch.yml 顶层必须是 patch 数组（按空 patch 处理）');
    return { patches: [], warnings };
  }
  const patches: PatchFileEntry[] = [];
  for (const [index, entry] of raw.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`cordis.patch.yml 第 ${index + 1} 条不是对象（跳过）`);
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || candidate.id === '') {
      warnings.push(`cordis.patch.yml 第 ${index + 1} 条缺 id（跳过）`);
      continue;
    }
    const unknown = Object.keys(candidate).filter((k) => !RESERVED_KEYS.has(k));
    if (unknown.length > 0) {
      warnings.push(`cordis.patch.yml 条目 "${candidate.id}" 含未知键 [${unknown.join(', ')}]（PatchOptions 保留键之外，装载时按 overrides 透传——首期只有 id/disabled 生效）`);
    }
    patches.push(entry as PatchFileEntry);
  }
  return { patches, warnings };
}

/** 序列化 patch 列表（人可读 YAML；保留键序） */
function dumpPatches(patches: PatchFileEntry[]): string {
  const lines = patches.map((p) => {
    const parts: string[] = [];
    if (p.disabled !== undefined) parts.push(`disabled: ${p.disabled ? 'true' : 'false'}`);
    for (const [k, v] of Object.entries(p)) {
      if (k === 'id' || k === 'disabled') continue;
      parts.push(`${k}: ${JSON.stringify(v)}`);
    }
    return `- { id: ${p.id}${parts.length > 0 ? ', ' + parts.join(', ') : ''} }`;
  });
  return `# AgentChat 行偏好层（本机；cordis.yml 是出厂态永不运行时写入）\n# 停用示例：- { id: mcp, disabled: true }\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
}

/** 原子写 patch 文件（串行队列内 + tmp/rename + retry） */
export function writePatchFile(root: string, patches: PatchFileEntry[]): Promise<void> {
  return withRootLock(root, () => {
    const file = patchFilePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFile(file, dumpPatches(patches));
  });
}

/**
 * 设置一条 patch（upsert：同 id 覆盖 disabled，无则追加；首期只用
 * {id, disabled}）。返回更新后的全量列表。串行队列内读改写。
 */
export function setPatchEntry(root: string, id: string, disabled: boolean): Promise<PatchFileEntry[]> {
  return withRootLock(root, () => {
    const { patches } = readPatchFile(root);
    const existing = patches.find((p) => p.id === id);
    if (existing) {
      existing.disabled = disabled;
    } else {
      patches.push({ id, disabled });
    }
    const file = patchFilePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFile(file, dumpPatches(patches));
    return patches;
  });
}
