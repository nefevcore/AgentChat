#!/usr/bin/env node
// ============================================================
// gen-bundle-rows.mjs —— composition.base.yml → bundle-rows.gen.ts
//
// 单一事实来源：bundle 补丁层。dist/直调路径（register-core/bootstrap）
// 经生成物按 id 取行模块，消灭手写 import 清单与 bundle 的双轨漂移。
// 用法：pnpm gen:bundle-rows（产物入库；bundle 改动后重跑）
// 校验：行 id 唯一；name 需为 @agentchat/* 包说明符；disabled 行排除（loader 专属）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src/boot/boot/src/composition.base.yml');
const OUT = path.join(root, 'src/boot/boot/src/bundle-rows.gen.ts');

/** 可复用（测试校验生成一致性）：读 bundle yml → 生成 TS 源码文本 */
export function generate(source = SRC) {
  const patches = yaml.load(fs.readFileSync(source, 'utf8'), { schema: yaml.JSON_SCHEMA });
  if (!Array.isArray(patches) || patches.length !== 1 || !Array.isArray(patches[0].insert)) {
    throw new Error('bundle 补丁层必须是单条大 insert');
  }
  const rows = patches[0].insert;
  const ids = new Set();
  const out = [];
  for (const row of rows) {
    if (!row.id || !row.name) throw new Error(`bundle 行缺 id/name: ${JSON.stringify(row).slice(0, 80)}`);
    if (ids.has(row.id)) throw new Error(`bundle 行 id 重复: ${row.id}`);
    ids.add(row.id);
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

  return `// ============================================================
// bundle-rows.gen.ts —— 【生成物】请勿手改
// 源：src/boot/boot/src/composition.base.yml · 生成：pnpm gen:bundle-rows
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
