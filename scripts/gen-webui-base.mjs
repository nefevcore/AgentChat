#!/usr/bin/env node
// ============================================================
// scripts/gen-webui-base.mjs —— webui 基座源文档生成器（cr-905 /
// cr-901 v2.1 批3 切片一，docs/design/ui-plugin-form.md §四）
//
// 事实源 = apps/ui/channel/*（工厂通道目录——增删通道 = 增删行）；
// 生成 apps/catalog/profile/webui.patch.yml（cordis-plugin-loader 官方
// 方言条目数组 + 版本戳头注释）。版本戳 = 内容变化时自动 +1（生成物，
// 与 host/shell 手写基座的升戳纪律不同源——裁决见设计文档 §四）。
//
// 用法：node scripts/gen-webui-base.mjs（幂等；无差异零写入）
// ============================================================
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import path from 'node:path';

const CHANNEL_DIR = fileURLToPath(new URL('../apps/ui/channel/', import.meta.url));
const OUT = fileURLToPath(new URL('../apps/catalog/profile/webui.patch.yml', import.meta.url));
const STAMP_RE = /^#\s*ac-base-version:\s*(\d+)\s*$/m;

const rows = [];
for (const ent of fs.readdirSync(CHANNEL_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!ent.isDirectory()) continue;
  const mf = JSON.parse(fs.readFileSync(path.join(CHANNEL_DIR, ent.name, 'manifest.json'), 'utf-8'));
  rows.push({
    id: ent.name,
    name: 'link:apps/ui/channel/' + ent.name,
    ...(Array.isArray(mf.seats) && mf.seats.length > 0 ? { seats: mf.seats } : {}),
    ...(mf.isolated === true ? { isolated: true } : {}),
    ...(typeof mf.description === 'string' && mf.description !== '' ? { description: mf.description } : {}),
  });
}

const body = yaml.dump(rows, { lineWidth: 120, noRefs: true });
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : '';
const prevStamped = STAMP_RE.exec(prev);
const prevBody = prev.slice(prev.indexOf('- id:'));
const version = prevBody === body && prevStamped ? Number(prevStamped[1]) : (prevStamped ? Number(prevStamped[1]) + 1 : 1);
const header =
  '# ac-base-version: ' + version + '\n' +
  '# webui 进程基座源文档（cr-905 / cr-901 v2.1 批3）——生成物：事实源 = apps/ui/channel/*，\n' +
  '# 由 scripts/gen-webui-base.mjs 生成，禁止手改（漂移由 ac-rowset-core\n' +
  '# tests/webui-base.test.ts 锁定）。分层合成与前端侧求值见 docs/design/ui-plugin-form.md。\n';
const next = header + body;
if (next === prev) {
  console.log('webui.patch.yml 已同步（' + rows.length + ' 行，v' + version + '）');
} else {
  fs.writeFileSync(OUT, next, 'utf-8');
  console.log('webui.patch.yml 已重生成：' + rows.length + ' 行，v' + version);
}