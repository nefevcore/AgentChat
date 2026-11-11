#!/usr/bin/env node
// ============================================================
// scripts/gen-webui-base.mjs —— webui 基座源文档生成器（cr-905 /
// cr-901 v2.1 批3 切片一，docs/design/ui-plugin-form.md §四；
// cr-920 事实源迁 packages/ac-client-ui-*（ac.faces.web））
//
// 事实源 = packages/ac-client-ui-* 包的 ac.faces.web 声明（增删包/改
// 声明 = 增删行/改行）；生成 apps/catalog/profile/webui.yml（cr-1004
//（cordis-plugin-loader 官方方言条目数组 + 版本戳头注释）。版本戳 =
// 内容变化时自动 +1（生成物，与 host/shell 手写基座的升戳纪律不同源
//——裁决见设计文档 §四）。
//
// 用法：node scripts/gen-webui-base.mjs（幂等；无差异零写入）
// ============================================================
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import path from 'node:path';

const PKG_DIR = fileURLToPath(new URL('../packages/', import.meta.url));
const OUT = fileURLToPath(new URL('../apps/catalog/profile/webui.yml', import.meta.url));
const STAMP_RE = /^#\s*ac-base-version:\s*(\d+)\s*$/m;
// 包族前缀 = 行类型词形（build-channel 同款约定）：ac-client-ui-* = 前端行；
// ac-client-theme-* = 主题包（纯样式行——theme+styles 声明，无 entry，cr-936）
const PKG_PREFIXES = ['ac-client-ui-', 'ac-client-theme-'];

const rows = [];
for (const ent of fs.readdirSync(PKG_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  const prefix = PKG_PREFIXES.find((p) => ent.name.startsWith(p));
  if (!ent.isDirectory() || prefix === undefined) continue;
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, ent.name, 'package.json'), 'utf-8'));
  const web = pkg.ac?.faces?.web;
  // web 面两形态：entry 行（factory bundle）或 theme 行（纯样式——theme 声明）
  const hasFace = web !== undefined
    && ((typeof web.entry === 'string' && web.entry !== '') || typeof web.theme === 'string');
  if (!hasFace) continue;
  const seats = (Array.isArray(web.seats) ? web.seats : []).filter((s) => typeof s === 'string' && s !== '');
  rows.push({
    id: ent.name.slice(prefix.length),
    name: 'link:packages/' + ent.name,
    ...(seats.length > 0 ? { seats: seats.map((s) => ({ seat: s })) } : {}),
    ...(web.isolated === true ? { isolated: true } : {}),
  });
}

const body = yaml.dump(rows, { lineWidth: 120, noRefs: true });
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : '';
const prevStamped = STAMP_RE.exec(prev);
const prevBody = prev.slice(prev.indexOf('- id:'));
const version = prevBody === body && prevStamped ? Number(prevStamped[1]) : (prevStamped ? Number(prevStamped[1]) + 1 : 1);
const header =
  '# ac-base-version: ' + version + '\n' +
  '# webui 进程基座源文档（cr-905 / cr-901 v2.1 批3）——生成物：事实源 = packages/ac-client-ui-* / ac-client-theme-*（ac.faces.web），\n' +
  '# 由 scripts/gen-webui-base.mjs 生成，禁止手改（漂移由 ac-rowset-core\n' +
  '# tests/webui-base.test.ts 锁定）。分层合成与前端侧求值见 docs/design/ui-plugin-form.md。\n';
const next = header + body;
if (next === prev) {
  console.log('webui.yml 已同步（' + rows.length + ' 行，v' + version + '）');
} else {
  fs.writeFileSync(OUT, next, 'utf-8');
  console.log('webui.yml 已重生成：' + rows.length + ' 行，v' + version);
}
