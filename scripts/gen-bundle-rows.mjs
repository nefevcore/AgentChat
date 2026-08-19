#!/usr/bin/env node
// ============================================================
// gen-bundle-rows.mjs —— bundle yml（base + 表面）→ bundle-rows.gen.ts
//
// 单一事实来源：bundle 补丁层。dist/直调路径（register-core/bootstrap）
// 经生成物按 id 取行模块，消灭手写 import 清单与 bundle 的双轨漂移。
// 用法：pnpm gen:bundle-rows（产物入库；bundle 改动后重跑）
// 校验：行 id 跨文件全局唯一；name 需为 @agentchat/* 包说明符；
//       disabled 行排除（loader 专属）。dist 是 web 形态发布，
//       生成物取全量行（base + web-app 表面；未来表面加入即并列）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_FILES = [
  path.join(root, 'src/boot/boot/src/composition.base.yml'),
  path.join(root, 'src/boot/boot/src/composition.web-app.yml'),
];
const OUT = path.join(root, 'src/boot/boot/src/bundle-rows.gen.ts');

/** 读单个 bundle yml 的补丁列表（空文件 = 无补丁；结构非法 fail loud） */
function readPatches(source) {
  const raw = yaml.load(fs.readFileSync(source, 'utf8'), { schema: yaml.JSON_SCHEMA });
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`bundle 补丁层必须是补丁数组: ${source}`);
  return raw;
}

/**
 * 可复用（测试校验生成一致性）：读 bundle yml 列表 → 生成 TS 源码文本。
 * 行解析对齐 vendored include 的 applyEntryPatches 语义：insert 追加行 /
 * 按 id 覆盖（config 整行替换不合并）/ disabled 停用。跨文件 id 唯一；
 * name 需为 @agentchat/* 包说明符；disabled 行排除（loader 专属）。
 */
export function generate(sources = SRC_FILES) {
  const rows = [];
  const byId = new Map();
  const index = (patch, file) => {
    for (const row of patch.insert) {
      if (!row.id || !row.name) throw new Error(`bundle 行缺 id/name: ${JSON.stringify(row).slice(0, 80)}`);
      if (byId.has(row.id)) throw new Error(`bundle 行 id 重复: ${row.id}`);
      byId.set(row.id, row);
      rows.push(row);
    }
  };
  const override = (patch, file) => {
    const target = byId.get(patch.id);
    if (!target) throw new Error(`bundle 覆盖目标行不存在: ${patch.id} (${file})`);
    if (patch.name && patch.name !== target.name) {
      throw new Error(`bundle 覆盖 name 不匹配: ${patch.id} (${file})`);
    }
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || key === 'insert') continue;
      target[key] = value; // config 整行替换不合并（同 applyEntryPatches）
    }
  };
  for (const source of sources) {
    for (const patch of readPatches(source)) {
      if (patch.insert) index(patch, source);
      else if (patch.id) override(patch, source);
      else throw new Error(`bundle 补丁缺 insert/id: ${source}`);
    }
  }

  const out = [];
  for (const row of rows) {
    if (row.disabled) continue; // loader 专属（hmr）：dist 直调路径不装载
    if (!String(row.name).startsWith('@agentchat/')) {
      throw new Error(`bundle 行 "${row.id}" 的 name 非 @agentchat/* 说明符（生成器静态 import 约束）: ${row.name}`);
    }
    out.push({ id: row.id, name: row.name, config: row.config });
  }

  const ident = (id) => 'r_' + id.replace(/-(.)/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9_]/g, '_');
  const imports = out.map((r) => `import * as ${ident(r.id)} from '${r.name}';`).join('\n');
  const entries = out.map((r) => {
    const cfg = r.config ? `, config: ${JSON.stringify(r.config)} as Record<string, unknown>` : '';
    return `  { id: ${JSON.stringify(r.id)}, name: ${JSON.stringify(r.name)}, module: unwrap(${ident(r.id)})${cfg} },`;
  }).join('\n');
  const srcList = sources.map((s) => path.relative(root, s).replace(/\\/g, '/')).join(' + ');

  return `// ============================================================
// bundle-rows.gen.ts —— 【生成物】请勿手改
// 源：${srcList} · 生成：pnpm gen:bundle-rows
// disabled 行（loader 专属）不在此列；module 经 unwrap 归一
// （workspace 包 namespace 导出 / vendored 包 default 导出 → 统一插件对象）。
// ============================================================
${imports}

/** namespace/default 导出归一为 cordis 插件对象 */
const unwrap = (m: unknown): unknown => (m as { default?: unknown })?.default ?? m;

export interface BundleRow {
  id: string;
  /** 模块说明符（审计/日志；真实模块在 module） */
  name: string;
  module: unknown;
  config?: Record<string, unknown>;
}

export const BUNDLE_ROWS: readonly BundleRow[] = [
${entries}
];

/** 按 id 取行；缺行 = bundle 与消费方漂移，fail loud */
export function bundleRow(id: string): BundleRow {
  const row = BUNDLE_ROWS.find((r) => r.id === id);
  if (!row) throw new Error(\`bundle 行 "\${id}" 不存在（bundle-rows.gen 与消费方漂移？重跑 pnpm gen:bundle-rows）\`);
  return row;
}
`;
}

// CLI 直跑：写文件
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(OUT, generate(), 'utf8');
  console.log(`[gen:bundle-rows] ${path.relative(root, OUT)} 已生成`);
}
