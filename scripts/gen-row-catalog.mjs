#!/usr/bin/env node
// ============================================================
// scripts/gen-row-catalog.mjs —— row-catalog.json 生成器（cr-902 / cr-901
// v2.1 批1）
//
// 单一事实源 = apps/catalog/profile/{host,shell}.yml（基座源文档，
// cordis-plugin-loader 官方方言；cr-1004 文件族改名：「patch」中缀专属
// 差量文档——基座不是差量）；本脚本把它们投影回旧消费面仍在读的
// apps/catalog/row-catalog.json（生成物，禁止手改——漂移由
// ac-rowset-core/tests/base-docs.test.ts 的投影等价测试锁定）。
//
// 投影规则（与 ac-rowset-core/src/base-docs.ts 同源）：
//   tree    ← 所在文档（host.yml → host；shell.yml → shell）
//   path    ← packs（多包行）∨ name 去 link: 前缀（单包行）
//   其余词汇（description / tools / bundle / requires）原样透传。
//
// 用法：node scripts/gen-row-catalog.mjs（幂等；写前比对，无差异零写入）
// ============================================================
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PROFILE_DIR = new URL('../apps/catalog/profile/', import.meta.url);
const OUT = new URL('../apps/catalog/row-catalog.json', import.meta.url);

const rows = [];
for (const proc of ['host', 'shell']) {
  const file = new URL(proc + '.yml', PROFILE_DIR);
  const entries = yaml.load(fs.readFileSync(file, 'utf-8'));
  if (!Array.isArray(entries)) throw new Error(proc + '.yml 顶层必须是条目数组');
  for (const e of entries) {
    const packs = e.packs ?? (e.name !== undefined ? [e.name.replace(/^link:/, '')] : undefined);
    rows.push({
      id: e.id,
      tree: proc,
      ...(e.description !== undefined ? { description: e.description } : {}),
      ...(e.tools !== undefined ? { tools: e.tools } : {}),
      ...(e.bundle !== undefined ? { bundle: e.bundle } : {}),
      ...(e.requires !== undefined ? { requires: e.requires } : {}),
      ...(packs !== undefined ? { path: packs.length === 1 ? packs[0] : packs } : {}),
    });
  }
}

const next = JSON.stringify({ version: 1, rows }, null, 2) + '\n';
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : '';
if (next === prev) {
  console.log('row-catalog.json 已同步（' + rows.length + ' 行）');
} else {
  fs.writeFileSync(OUT, next, 'utf-8');
  console.log('row-catalog.json 已重生成：' + rows.length + ' 行（host '
    + rows.filter((r) => r.tree === 'host').length + ' + shell '
    + rows.filter((r) => r.tree === 'shell').length + '）');
}
