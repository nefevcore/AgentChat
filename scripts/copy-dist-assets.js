// ============================================================
// copy-dist-assets.js —— postbuild：把 tsc 不复制（非 .ts）的运行资产复制到 dist
//
// v0.6.2（一切皆插件）：旧 plugins/builtin 目录已随架构迁移移除，
// 只保留工作区模板资产：docs/tool-dev-guide.md → dist 兼容路径，
// 供 @agentchat/workspace 首次初始化时作为候选模板复制到工作区。
//
// 旧脚本是 CommonJS；根 package.json 已是 "type": "module"，因此本文件改为 ESM。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PAIRS = [
  ['docs/tool-dev-guide.md', 'dist/src/plugins/builtin/tool-dev-guide.md'],
];

let copied = 0;
for (const [src, dest] of PAIRS) {
  const s = path.join(ROOT, src);
  const d = path.join(ROOT, dest);
  if (!fs.existsSync(s)) continue;
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(s, d);
  copied++;
}
if (copied > 0) {
  console.log(`[postbuild] 已复制 ${copied} 个运行资产到 dist/`);
}
