#!/usr/bin/env node
// ============================================================
// scripts/gen-row-catalog.mjs —— row-catalog.json 生成器（cr-902；cr-1022
// 批2 投影逻辑并源 base-docs.ts；cr-1033 B2 能力定义归包：能力行事实源
// = 各包 package.json ac.rows（aggregatePackageRows 聚合），基座文档只
// 供宿主行 + 壳骨架）。
//
// 产物 apps/catalog/row-catalog.json（生成物，禁止手改——漂移由
// ac-rowset-core/tests 的投影等价测试锁定）。B1-B2 窗口期：包聚合与
// shell.yml 能力区双源等价锁在 package-rows.test.ts（B3 删能力区随窗
// 退役）。
//
// 用法：node scripts/gen-row-catalog.mjs（幂等；写前比对，无差异零写入）
// ============================================================
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readBaseCatalog, projectBaseEntry } from '../packages/ac-rowset-core/src/base-docs.ts';
import { aggregatePackageRows } from '../packages/ac-rowset-core/src/package-rows.ts';

const OUT = fileURLToPath(new URL('../apps/catalog/row-catalog.json', import.meta.url));
const PROFILE_DIR = fileURLToPath(new URL('../apps/catalog/profile/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const base = readBaseCatalog(PROFILE_DIR);
if (base === null) throw new Error('基座源文档残缺（host/shell 须成对在场）');
// 宿主行 + 壳骨架来自基座；能力行 = 包聚合（id 排序稳定）
const skeletonAndHost = base.rows.filter((r) => r.tree === 'host' || r.zone === 'skeleton');
const capability = aggregatePackageRows(REPO_ROOT)
  .map((e) => projectBaseEntry({ ...e, zone: 'capability' }, 'shell'));
const rows = [...skeletonAndHost, ...capability];

const next = JSON.stringify({ version: 1, rows }, null, 2) + '\n';
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : '';
if (next === prev) {
  console.log('row-catalog.json 已同步（' + rows.length + ' 行）');
} else {
  fs.writeFileSync(OUT, next, 'utf-8');
  console.log('row-catalog.json 已重生成：' + rows.length + ' 行（host '
    + rows.filter((r) => r.tree === 'host').length + ' + shell '
    + rows.filter((r) => r.tree === 'shell').length + '；能力行源 = 包 ac.rows 聚合）');
}
