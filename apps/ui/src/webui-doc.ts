// ============================================================
// webui-doc.ts —— webui 基座文档 → loader 行名单（cr-928 切片①；webui-v3 §4.2）
//
// 分层求值语义与旧链（ac-webui-core webui-layer.ts）同源：
//   基座(profile/webui.patch.yml) − custom 停用 ∪ installed(scope:webui)
// 区别：求值产物不是 boot graph 而是 **loader 行名单**（装配态锚——
// v3 裁决一）；点名缺席降级（装载失败/物化缺席 = 警告 + 跳过）发生在
// entry 创建与 flush 层，不再做目录扫描对账。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

/** 装配文档内条目（id 定位 + name 模块说明符 + disable 面） */
interface DocEntry {
  id: string;
  name?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

/** installed.patch.yml 条目词形子集 */
interface InstalledEntry {
  id: string;
  name?: string;
  scope?: string;
  disabled?: boolean;
}

function readDoc(file: string): DocEntry[] | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return null; // 缺席 = 无该层
  }
  const data = yaml.load(text) as unknown;
  if (!Array.isArray(data)) {
    throw new Error('webui 装配文档顶层必须是条目数组：' + file);
  }
  return data.filter((e): e is DocEntry =>
    e !== null && typeof e === 'object' && !Array.isArray(e) && typeof (e as DocEntry).id === 'string');
}

/** 求值产物：行名单（模块说明符 + 出厂标记） */
export interface WebuiDocRow {
  /** 行 id（装配文档 id——寻址键，非模块名） */
  id: string;
  /** loader entry 模块说明符（link:<rel> → './<rel>/src/index.ts'；裸名原样） */
  spec: string;
  /** 出厂行（基座点名）——fail-loud 分类输入（§4.2） */
  factory: boolean;
}

export interface WebuiDocResult {
  rows: WebuiDocRow[];
  warnings: string[];
}

/**
 * link: 词形 → 模块说明符：link:packages/x → './packages/x/src/index.ts'
 *（node 半源约定 = src/index.ts；baseUrl 解析锚由 Loader config 承担）。
 */
export function specOfDocName(name: string): string {
  if (name.startsWith('link:')) {
    const rel = name.slice('link:'.length).replace(/\\/g, '/').replace(/\/+$/, '');
    return './' + rel + '/src/index.ts';
  }
  return name;
}

/** webui 分层求值（纯函数 + fs）：文档意志 → loader 行名单 */
export function deriveWebuiRows(profileDir: string): WebuiDocResult {
  const warnings: string[] = [];
  const base = readDoc(path.join(profileDir, 'webui.patch.yml'));
  if (base === null) return { rows: [], warnings: ['webui 基座文档缺席（部署链未跑？）'] };
  const custom = readDoc(path.join(profileDir, 'webui-custom.patch.yml')) ?? [];
  let installed: InstalledEntry[] = [];
  try {
    const raw = yaml.load(fs.readFileSync(path.join(profileDir, 'installed.patch.yml'), 'utf-8')) as unknown;
    if (Array.isArray(raw)) installed = raw as InstalledEntry[];
  } catch {
    // installed 缺席 = 无第三方 web 面（坏文件在安装器读路径 fail-loud）
  }
  const disabled = new Set([
    ...custom.filter((e) => e.disabled === true).map((e) => e.id),
    ...installed.filter((e) => e.disabled === true).map((e) => e.id),
  ]);
  const rows: WebuiDocRow[] = [];
  for (const e of base) {
    if (disabled.has(e.id)) continue;
    rows.push({ id: e.id, spec: specOfDocName(e.name ?? e.id), factory: true });
  }
  const seen = new Set(rows.map((r) => r.id));
  for (const e of installed) {
    if (e.scope !== 'webui' || disabled.has(e.id) || seen.has(e.id)) continue;
    rows.push({ id: e.id, spec: specOfDocName(e.name ?? e.id), factory: false });
  }
  return { rows, warnings };
}
