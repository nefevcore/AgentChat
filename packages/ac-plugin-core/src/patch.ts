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
// 写路径 setPatchEntry = eemeli/yaml AST 编辑（cr-11）：保注释/保条目序/
// 新条目 flow 风格；损坏文件 throw 拒绝覆盖。两库分工 = 读 js-yaml（fail-soft
// 零改动）/ 写 eemeli（仅 setPatchEntry 内部，不外泄）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq, type Document } from 'yaml';
import { atomicWriteFile, withRootLock } from './fsx.ts';

/** patch 文件条目（官方 PatchOptions 的首期子集 + 透传未知键） */
export interface PatchFileEntry {
  id: string;
  disabled?: boolean | null;
  [key: string]: unknown;
}

/** 读取结果（patches + 容错告警——纯库不落日志，调用方决定 sink） */
interface PatchFileRead {
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
 * {id, disabled}）。返回更新后的全量列表（写后读回单源——与读路径
 * 过滤语义一致）。串行队列内读改写。
 *
 * 写路径 = eemeli/yaml AST 编辑（cr-11）：手工注释/条目顺序/行内格式
 * 原样保留——fail-soft「人可读可手工急救」不再被程序写入冲平：
 *   · 同 id 多条 → 改最后一条（include 的 buildMap 逐条 Map.set 覆盖
 *     = last-wins 应用语义，改首条会「改了不生效」）；
 *   · 新追加条目 flow 风格 - { id: x, disabled: true }（对齐 dumpPatches
 *     既有外观；已存在条目的编辑天然保持原格式）；
 *   · 损坏/非数组文件 → throw 拒绝覆盖：覆盖恰恰会抹掉用户手写一半的
 *     急救内容；读路径 fail-soft（按空 patch 不阻断 boot）零改动。
 * 文件不存在 → dumpPatches 全新写（首写注释头）。
 */
export function setPatchEntry(root: string, id: string, disabled: boolean): Promise<PatchFileEntry[]> {
  return withRootLock(root, () => {
    const file = patchFilePath(root);
    let text: string;
    if (fs.existsSync(file)) {
      // 泛型拓宽到 Document<Node>：contents 收为 Node|null——new YAMLSeq()
      // （YAMLSeq<unknown>）可直赋 contents（Document.Parsed 的 ParsedNode
      // 收窄面拒收运行时构造的节点，纯类型面差异）
      const doc: Document = parseDocument(fs.readFileSync(file, 'utf-8'));
      const refuse = (reason: string): never => {
        throw new Error(
          `cordis.patch.yml 已损坏（${reason}）——拒绝覆盖写，请先手工修复（文件人可读可急救；读路径仍按空 patch 处理不阻断 boot）`,
        );
      };
      if (doc.errors.length > 0) refuse(`解析失败: ${doc.errors.map((e) => e.message).join('; ')}`);
      const contents = doc.contents;
      // 单表达式收口（isSeq 窄化不跨语句存活）：seq = null 新建（空文件/纯注释，注释保留）/ 非数组 refuse
      const seq = isSeq(contents) ? contents : contents === null ? new YAMLSeq() : refuse('顶层不是 patch 数组');
      doc.contents = seq;
      const target = seq.items.findLast((item): item is YAMLMap<unknown, unknown> => isMap(item) && item.get('id') === id);
      if (target !== undefined) {
        target.set('disabled', disabled);
      } else {
        const entry = new YAMLMap();
        entry.flow = true;
        entry.set('id', id);
        entry.set('disabled', disabled);
        seq.items.push(entry); // add() 在 Node 类型面不可达——items.push 等价（YAMLSeq<T>.items 直接可变）
      }
      text = doc.toString({ lineWidth: 0 }); // lineWidth 0 = 不折行（用户长行不改形）
    } else {
      text = dumpPatches([{ id, disabled }]);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFile(file, text);
    return readPatchFile(root).patches;
  });
}
