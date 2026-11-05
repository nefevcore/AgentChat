#!/usr/bin/env node
// ============================================================
// scripts/plugin-cli.mjs —— ac plugin 作者工具链（cr-907 / cr-901
// v2.1 批5 §4.6：发布三命令——init → dev → publish）
//
//   init <name> [--owner <agentId>] [--dir <d>]   零 PLACEHOLDER 脚手架
//   publish [--dir <d>] [--dry]                   TS 直发 npm（无构建步）
//   finalize <dir> --data-root <r> --owner <id>   定型物化（统一安装器
//                                                 代写 installed 行 owner 锚）
//   dev [--dir <d>]   watch 热试跑（门禁 + 装载冒烟；壳内试跑用 register_plugin）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { admissionOf, installPackage } from '../packages/ac-plugin-core/src/index.ts';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const die = (msg) => { console.error('[ac plugin] ' + msg); process.exit(1); };
const TEMPLATE = fileURLToPath(new URL('./plugin-template/index.ts', import.meta.url));

// ---- init：零 PLACEHOLDER 脚手架（包形态——ac 字段单源） ----
function init() {
  const name = args[1];
  if (name === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    die('用法：ac plugin init <name> [--owner <agentId>] [--dir <d>]（name = param-case）');
  }
  const owner = opt('owner') ?? 'my-agent';
  const dir = path.resolve(opt('dir') ?? name);
  if (fs.existsSync(path.join(dir, 'package.json'))) die('目标已含 package.json：' + dir);
  const toolName = owner + '-' + name;
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const pkg = {
    name,
    version: '0.1.0',
    description: '一句话说明这个工具做什么（客观描述能力，不写指令）',
    keywords: ['agentchat-plugin'],
    engines: { node: '>=23', agentchat: '^2' },
    ac: {
      faces: { node: { entry: './src/index.ts' } },
      permissions: ['fs'],
      provides: { tools: [toolName] },
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + String.fromCharCode(10));
  const tpl = fs.readFileSync(TEMPLATE, 'utf-8').replaceAll('__OWNER__', owner).replaceAll('__TOOL__', toolName);
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), tpl);
  console.log('[ac plugin] 脚手架就绪：' + dir + '（工具名 ' + toolName + '——owner 私有）');
  console.log('[ac plugin] 下一步：ac plugin dev（热试跑）或 ac plugin publish（直发 npm）');
}

// ---- publish：门禁 + npm publish（TS 直发——无构建步） ----
function publish() {
  const dir = path.resolve(opt('dir') ?? '.');
  const dry = args.includes('--dry');
  const admission = admissionOf(dir);
  if (!admission.ok || admission.pkg === null) {
    die('门禁未过（' + admission.reasons.join('；') + '）——修复后再发');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
  if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes('agentchat-plugin')) {
    die('package.json 缺 keywords "agentchat-plugin"（市场发现约定——作者自标才可被搜到）');
  }
  console.log('[ac plugin] ' + pkg.name + '@' + pkg.version + ' → npm publish' + (dry ? '（dry-run）' : '') + '（TS 直发，无构建步）');
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['publish', ...(dry ? ['--dry-run'] : [])], { cwd: dir, stdio: 'inherit', shell: true });
  child.on('close', (code) => process.exit(code ?? 1));
}

// ---- finalize：定型物化（自开发 → 统一安装器 → installed 行 owner 锚） ----
async function finalize() {
  const dir = path.resolve(args[1] ?? die('用法：ac plugin finalize <dir> --data-root <r> --owner <agentId>'));
  const dataRoot = opt('data-root') ?? die('--data-root 必填');
  const owner = opt('owner') ?? die('--owner 必填');
  const receipt = await installPackage({ root: dataRoot, sourceDir: dir, owner, grants: ['fs', 'network', 'process', 'shell', 'ui'] });
  console.log('[ac plugin] ' + receipt.name + '@' + receipt.version + ' → ' + receipt.result + ' / ' + receipt.effective);
  if (receipt.result !== 'applied') process.exit(1);
}


// ---- dev：watch 热试跑（cr-907 批5 切片二） ----
// 门禁 + 模块装载冒烟（Node strip-types 动态 import entry → default
// export 插件形状校验）——装载链真验证零壳依赖；壳内会话级试跑（运行
// 期工具面）沿用 register_plugin 既有面（cr-553 plugin-dev 行）。文件
// 变更 → 重跑（watch 节流 300ms）；Ctrl-C 退出。定型 = finalize。
async function dev() {
  const dir = path.resolve(opt('dir') ?? '.');
  await checkOnce(dir, true);
  console.log('[ac plugin] watch 中（改文件即重检；Ctrl-C 退出；定型 = ac plugin finalize）…');
  let timer = null;
  const watcher = fs.watch(dir, { recursive: true }, () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void checkOnce(dir, false); }, 300);
  });
  process.on('SIGINT', () => { watcher.close(); process.exit(0); });
}

async function checkOnce(dir, first) {
  const admission = admissionOf(dir);
  if (!admission.ok || admission.pkg === null) {
    console.error('[ac plugin] 门禁未过：' + admission.reasons.join('；'));
    if (first) process.exit(1);
    return;
  }
  const entry = admission.pkg.ac?.faces?.node?.entry ?? './src/index.ts';
  try {
    const rel = entry.replace(/^\.\//, '');
    // 装载契约同壳内 loadSession（cr-553）：模块本身即插件对象（命名导出
    // apply；mod.default 兼容）；?t= 缓存穿透——watch reload 取新代码
    const mod = await import(pathToFileURL(path.join(dir, rel)).href + '?t=' + Date.now());
    const plugin = mod.default !== undefined && typeof mod.default.apply === 'function'
      ? mod.default : mod;
    if (typeof plugin.apply !== 'function') {
      throw new Error('entry 缺插件形状（需导出 apply(ctx)——模块本身即插件对象，同壳内装载契约）');
    }
    console.log('[ac plugin] ' + (first ? '' : '(reload) ') + admission.pkg.name + '@' + admission.pkg.version
      + ' 装载冒烟通过（entry ' + entry + '；apply ' + typeof plugin.apply + '）');
  } catch (err) {
    console.error('[ac plugin] 装载失败：' + (err instanceof Error ? err.message : String(err)));
    if (first) process.exit(1);
  }
}

(async () => {
  const cmd = args[0];
  if (cmd === 'init') init();
  else if (cmd === 'publish') publish();
  else if (cmd === 'finalize') await finalize();
  else if (cmd === 'dev') await dev();
  else die('用法：ac plugin <init|publish|finalize> …（dev 随切片二）');
})();
