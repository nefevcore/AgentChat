// ============================================================
// base-docs.ts —— 基座源文档读取/投影/部署链（cr-902 / cr-901 v2.1 批1）
//
// 基座源文档（apps/catalog/profile/{host,shell}.patch.yml）是行→包映射
// 的单一事实源：cordis-plugin-loader 官方方言条目数组（顶层必须数组——
// include 装载器同款约束），tree 字段由所在文档隐含（id 仅基座内唯一，
// 跨基座同名合法——config/logger-console 双计）。row-catalog.json 是本档
// 的生成投影（scripts/gen-row-catalog.mjs），旧消费面经 readCatalog 双读
// 过渡（基座在场即基座赢，JSON 是批 6 退役前的兼容读路径）。
//
// 版本戳 = 文档头注释 `# ac-base-version: N`（官方方言顶层数组不容元数据
// 字段；注释位是 DSH patch 文档先例）。编辑基座必须升戳。
//
// 部署链：host boot 把 repo 基座物化到 <dataRoot>/profile/<proc>.patch.yml
//（逐字节副本）。对账裁决（fail-loud 面）：
//   · 副本缺席 / 源版本更新 → 重物化（自愈——repo 开发态无安装步，逐次
//     部署即部署链本体）；
//   · 副本版本 > 源版本（旧应用压新数据根）→ throw；
//   · 同版本内容漂移（编辑未升戳）→ throw；
//   · 写后读回不符 → throw。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import type { RowDescriptor, RowsetCatalog } from './rowset.ts';

/** 进程种类（行集投影面 = host/shell；webui 基座非行集——部署面专用） */
export type BaseProc = 'host' | 'shell' | 'webui';
/** 行集投影面（readBaseCatalog——webui 行非 RowDescriptor，不进投影） */
export const BASE_PROCS: readonly Exclude<BaseProc, 'webui'>[] = ['host', 'shell'];
/** 部署链面（materializeBaseDocs——批 3 起 webui 基座随行部署，cr-905） */
export const DEPLOY_PROCS: readonly BaseProc[] = ['host', 'shell', 'webui'];

/** 基座文档内一条目（官方 EntryOptions 骨架 + 本档派生词汇挂载） */
export interface BaseEntry {
  /** 稳定行 id（基座内唯一） */
  id: string;
  /** 行定位（link: 仓库相对路径；多包行 = 首包） */
  name?: string;
  /** 多包行指纹面全集（单包行省略——name 即全集） */
  packs?: string[];
  description?: string;
  tools?: string[];
  bundle?: string;
  requires?: string[];
}

/** 已解析基座文档（P = 行集面进程词——webui 仅部署面，不进投影） */
export interface BaseDoc<P extends BaseProc = BaseProc> {
  proc: P;
  /** 版本戳（文档头注释） */
  version: number;
  entries: BaseEntry[];
}

const VERSION_RE = /^#\s*ac-base-version:\s*(\d+)\s*$/m;

/** 基座文档缺省位：<catalogFile 同目录>/profile/<proc>.yml（cr-1004 文件族
 * 改名：「patch」中缀专属差量文档——基座与登记不是差量，不带中缀） */
export function baseDocFile(profileDir: string, proc: BaseProc): string {
  return path.join(profileDir, proc + '.yml');
}

/** 旧名 <proc>.patch.yml 只读兼容（cr-1004 改名窗口——数据根物化副本由
 * 部署链 reconcile 收敛到新名后消亡） */
function legacyBaseDocFile(profileDir: string, proc: BaseProc): string {
  return path.join(profileDir, proc + '.patch.yml');
}

/** 读单份基座文档（新名缺席时回退旧名——改名窗口兼容读） */
function readBaseDocEither<P extends BaseProc>(profileDir: string, proc: P): { doc: BaseDoc<P>; file: string } | null {
  const file = baseDocFile(profileDir, proc);
  if (fs.existsSync(file)) return { doc: readBaseDoc(file, proc), file };
  const legacy = legacyBaseDocFile(profileDir, proc);
  if (fs.existsSync(legacy)) return { doc: readBaseDoc(legacy, proc), file: legacy };
  return null;
}

/** catalogFile → 同目录 profile 目录（双读/部署链寻址基点） */
export function profileDirOf(catalogFile: string): string {
  return path.join(path.dirname(catalogFile), 'profile');
}

/** 读单份基座文档（缺版本戳 / 顶层非数组 / 条目缺 id → throw） */
export function readBaseDoc<P extends BaseProc>(file: string, proc: P): BaseDoc<P> {
  const text = fs.readFileSync(file, 'utf-8');
  const stamped = VERSION_RE.exec(text);
  if (stamped === null) {
    throw new Error('基座源文档缺版本戳（# ac-base-version: N）：' + file);
  }
  const data = yaml.load(text) as unknown;
  if (!Array.isArray(data)) {
    throw new Error('基座源文档顶层必须是条目数组：' + file);
  }
  const entries = data as BaseEntry[];
  for (const e of entries) {
    if (typeof (e as { id?: unknown } | null)?.id !== 'string') {
      throw new Error('基座源文档条目缺 id：' + file);
    }
  }
  return { proc, version: Number(stamped[1]), entries };
}

/** 条目 → 行描述符（tree 由文档隐含；path 由 packs/name 还原；webui 基座
 * 非行集面——projectBaseEntry 不消费，仅部署链物化） */
export function projectBaseEntry(entry: BaseEntry, tree: 'host' | 'shell'): RowDescriptor {
  const packs = entry.packs
    ?? (entry.name !== undefined ? [entry.name.replace(/^link:/, '')] : undefined);
  return {
    id: entry.id,
    tree,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.tools !== undefined ? { tools: entry.tools } : {}),
    ...(entry.bundle !== undefined ? { bundle: entry.bundle } : {}),
    ...(entry.requires !== undefined ? { requires: entry.requires } : {}),
    ...(packs !== undefined ? { path: packs.length === 1 ? packs[0] : packs } : {}),
  };
}

/**
 * 读基座目录 → 行集目录投影。两份文档任一缺席 → null（双读窗口内的
 * 兼容判据：基座未部署处回退 JSON）；只此一份 = 残缺部署，throw。
 */
export function readBaseCatalog(profileDir: string): RowsetCatalog | null {
  const docs: Array<BaseDoc<'host' | 'shell'>> = [];
  let present = 0;
  const procs: Array<'host' | 'shell'> = ['host', 'shell'];
  for (const proc of procs) {
    const hit = readBaseDocEither(profileDir, proc);
    if (hit === null) continue;
    present++;
    docs.push(hit.doc);
  }
  if (present === 0) return null;
  if (present !== BASE_PROCS.length) {
    throw new Error('基座源文档残缺（host/shell 须成对部署）：' + profileDir);
  }
  return { rows: docs.flatMap((d) => d.entries.map((e) => projectBaseEntry(e, d.proc))) };
}

export interface MaterializeReport {
  proc: BaseProc;
  version: number;
  /** 副本已同步（本次未写） */
  updated: boolean;
}

/**
 * 版本戳部署链：repo 基座源文档 → <dataRoot>/profile/（逐字节副本）。
 * 对账语义见文件头（fail-loud 面）；返回逐进程报告（测试/日志面）。
 */
export function materializeBaseDocs(profileDir: string, dataRoot: string): MaterializeReport[] {
  // 源基座目录缺席（旧式 JSON-only 数据根——双读窗口兼容形态）= 无部署面
  if (readBaseDocEither(profileDir, 'host') === null
    && readBaseDocEither(profileDir, 'shell') === null) return [];
  const report: MaterializeReport[] = [];
  fs.mkdirSync(path.join(dataRoot, 'profile'), { recursive: true });
  for (const proc of DEPLOY_PROCS) {
    // webui 源缺席（旧应用形态）= 跳过该面，不阻断 host/shell 部署
    const srcHit = readBaseDocEither(profileDir, proc);
    if (proc === 'webui' && srcHit === null) continue;
    const srcFile = srcHit!.file;
    const srcText = fs.readFileSync(srcFile, 'utf-8');
    const srcVersion = srcHit!.doc.version;
    const dstFile = baseDocFile(path.join(dataRoot, 'profile'), proc);
    let dstText: string | null = null;
    try {
      dstText = fs.readFileSync(dstFile, 'utf-8');
    } catch {
      dstText = null; // 首次部署
    }
    let updated = false;
    if (dstText !== srcText) {
      if (dstText !== null) {
        const dstStamped = VERSION_RE.exec(dstText);
        const dstVersion = dstStamped === null ? Number.NaN : Number(dstStamped[1]);
        if (dstVersion > srcVersion) {
          throw new Error(
            '基座物化副本比源新（旧应用压新数据根）：' + dstFile
            + ' v' + dstVersion + ' > 源 v' + srcVersion + '——升级应用或回退数据根',
          );
        }
        if (dstVersion === srcVersion) {
          throw new Error(
            '基座源文档编辑后未升版本戳（同版本内容漂移）：' + srcFile,
          );
        }
      }
      const tmp = dstFile + '.' + process.pid + '.' + Date.now() + '.tmp';
      fs.writeFileSync(tmp, srcText, 'utf-8');
      fs.renameSync(tmp, dstFile);
      updated = true;
      // 写后读回对账（fail-loud：物化链断裂不留静默旧档）
      if (fs.readFileSync(dstFile, 'utf-8') !== srcText) {
        throw new Error('基座物化读回不符（部署链写入失败）：' + dstFile);
      }
    }
    report.push({ proc, version: srcVersion, updated });
    // 存量数据根 reconcile（cr-1004 改名）：旧名基座副本清除——新名副本已
    // 就位。**判据 = 版本戳**：旧基座名 <proc>.patch.yml 与用户差量层新名
    // 同名，只有带 `# ac-base-version` 戳的才是旧基座物化副本（可删）；
    // 无戳文件是用户差量层（保留——误删 = 用户配置丢失）
    const legacyDst = legacyBaseDocFile(path.join(dataRoot, 'profile'), proc);
    if (fs.existsSync(legacyDst)) {
      try {
        if (VERSION_RE.test(fs.readFileSync(legacyDst, 'utf-8'))) {
          fs.rmSync(legacyDst, { force: true });
        }
      } catch { /* 不可读 = 留置（不冒进出手） */ }
    }
  }
  // 进程种类注册表随行部署（cr-910 批6 切片四 / cr-901 §4.7：repo 声明式
  // 清单住应用侧——profile/processes.json 与基座文档同域物化；数据根仅
  // 声明式启用配置，无脚本无代码）
  const registrySrc = path.join(profileDir, 'processes.json');
  if (fs.existsSync(registrySrc)) {
    const registryDst = path.join(dataRoot, 'profile', 'processes.json');
    const registryText = fs.readFileSync(registrySrc, 'utf-8');
    if (!fs.existsSync(registryDst) || fs.readFileSync(registryDst, 'utf-8') !== registryText) {
      const tmp = registryDst + '.' + process.pid + '.' + Date.now() + '.tmp';
      fs.writeFileSync(tmp, registryText, 'utf-8');
      fs.renameSync(tmp, registryDst);
    }
  }
  return report;
}
