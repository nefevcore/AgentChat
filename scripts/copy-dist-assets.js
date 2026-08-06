// ============================================================
// copy-dist-assets.js —— postbuild：把 tsc 不复制（非 .ts）的运行资产复制到 dist
//
// 需要复制的资产：
//   · plugins/{builtin,builtin-math}/plugin.json —— 插件清单（PluginLoader 扫描发现全局插件）
//   · plugins/builtin/tool-dev-guide.md —— 工具开发指引模板（首次运行复制到工作区）
//
// 没有这些文件，编译版（npm start / 发布包）将无法发现全局插件，
// Agent 会加载 0 个工具/扩展。
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const PAIRS = [
  ['src/plugins/builtin/plugin.json', 'dist/src/plugins/builtin/plugin.json'],
  ['src/plugins/builtin-math/plugin.json', 'dist/src/plugins/builtin-math/plugin.json'],
  ['src/plugins/builtin/tool-dev-guide.md', 'dist/src/plugins/builtin/tool-dev-guide.md'],
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
