// ============================================================
// gen-domain-channels.mjs —— 25 域行通道包生成器（8.5c）
//
// ui 域行 manifest 声明化（ui-tree.md §3：第一方与第三方同走唯一通道）：
//   channel/<name>/ 三件套（package.json + src/index.ts + manifest.json）
//   · src/index.ts = re-export 主线 ac-client-ui-<name> clientPlugin（8.5b
//     conversation 先例同款——物理迁出归 cutover）；
//   · manifest.channelImports = 五基座 + webui-kit + 跨包深路径说明符
//     （vite external 留空 → 运行时 importmap 解析宿主实例——单例契约：
//     pinia store / 席位注册表 / toast 全局栈 / VIEWER_ID 等）。
//
// 内嵌快照（DEPS / EXPORTS / KIT_USE）来源 = 2026-10-19 仓库扫描；
// --check 模式重扫对账（主线包演化后先跑对账更新本表再生成）。
// 用法：node scripts/gen-domain-channels.mjs [--check]
// ============================================================
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const channelRoot = join(here, '..', 'channel');
const srcRoot = join(here, '..', '..', '..', '..', 'src');

// —— 内嵌快照（2026-10-19 扫描）——

// 跨包深路径说明符（domain → 外部化清单；自引不入）
const DEPS = {
  "runview": [
    "ac-client-ui-agents/client/rosterAccess.ts",
    "ac-client-ui-conversation/client/ConversationView.vue",
    "ac-client-ui-layout/client/uiStore.ts",
    "ac-client-ui-conversation/client/chatStore.ts",
    "ac-client-ui-conversation/client/viewer.ts",
    "ac-client-ui-conversation/client/switchTrace.ts",
    "ac-client-ui-theme/client/themeStore.ts",
    "ac-client-ui-subagent/client/board.ts",
    "ac-client-ui-jobs/client",
    "ac-client-ui-layout/client/mainViews.ts",
    "ac-client-ui-layout/client/auxSidebarViews.ts"
  ],
  "workspace": [
    "ac-client-ui-layout/client/uiStore.ts",
    "ac-client-ui-renderer/client/useMarkdown.ts",
    "ac-client-ui-renderer/client/hljs-languages.ts",
    "ac-client-ui-layout/client/auxSidebarViews.ts"
  ],
  "singles": [
    "ac-client-ui-agents/client/rosterAccess.ts",
    "ac-client-ui-conversation/client/ConversationView.vue",
    "ac-client-ui-conversation/client/feedStore.ts",
    "ac-client-ui-layout/client/uiStore.ts",
    "ac-client-ui-theme/client/themeStore.ts",
    "ac-client-ui-conversation/client/feed.ts",
    "ac-client-ui-conversation/client/switchTrace.ts",
    "ac-client-ui-conversation/client/composePrefs.ts",
    "ac-client-ui-workspace/client/EntryPickerModal.vue",
    "ac-client-ui-workspace/client/fileApi.ts",
    "ac-client-ui-workspace/client/filePreviewContent.ts",
    "ac-client-ui-workspace/client"
  ],
  "group": [
    "ac-client-ui-conversation/client/ConversationView.vue",
    "ac-client-ui-conversation/client/types.ts",
    "ac-client-ui-agents/client",
    "ac-client-ui-agents/client/rosterAccess.ts",
    "ac-client-ui-layout/client/uiStore.ts"
  ],
  "agents": [
    "ac-client-ui-layout/client/uiStore.ts",
    "ac-client-ui-conversation/client/chatStore.ts",
    "ac-client-ui-conversation/client/feedStore.ts",
    "ac-client-ui-theme/client/themeStore.ts",
    "ac-client-ui-conversation/client/feed.ts",
    "ac-client-ui-conversation/client/switchTrace.ts",
    "ac-client-ui-conversation/client/types.ts",
    "ac-client-ui-settings/client/components/ConfirmDialog.vue",
    "ac-client-ui-settings/client/types.ts",
    "ac-client-ui-settings/client/schema.ts",
    "ac-client-ui-settings/client/components/SettingField.vue",
    "ac-client-ui-timer/client/TimerPane.vue",
    "ac-client-ui-plugin-registry/client/ExtToolsPane.vue",
    "ac-client-ui-llm-pool/client/poolApi.ts",
    "ac-client-ui-settings/client/rpcDefault.ts",
    "ac-client-ui-settings/client/extensionTabs.ts",
    "ac-client-ui-timer/client/timerApi.ts",
    "ac-client-ui-settings/client/api.ts"
  ],
  "usage": [
    "ac-client-ui-agents/client/rosterAccess.ts",
    "ac-client-ui-theme/client/themeStore.ts",
    "ac-client-ui-layout/client/uiStore.ts",
    "ac-client-ui-layout/client/auxSidebarViews.ts",
    "ac-client-ui-settings/client/rpcDefault.ts"
  ],
  "system": [
    "ac-client-ui-renderer/client/useMarkdown.ts",
    "ac-client-ui-layout/client/uiStore.ts"
  ],
  "timer": [
    "ac-client-ui-settings/client/useSettings.ts",
    "ac-client-ui-agents/client/rosterAccess.ts",
    "ac-client-ui-layout/client/uiStore.ts",
    "ac-client-ui-layout/client/auxSidebarViews.ts"
  ],
  "shell": [
    "ac-client-ui-renderer/client/ScrollableViewport.vue"
  ],
  "fs": [
    "ac-client-ui-renderer/client/useMarkdown.ts",
    "ac-client-ui-renderer/client/ScrollableViewport.vue",
    "ac-client-ui-renderer/client/codeFence.ts"
  ],
  "web": [
    "ac-client-ui-layout/client/uiStore.ts",
    "ac-client-ui-layout/client/auxSidebarViews.ts"
  ],
  "browser": [
    "ac-client-ui-workspace/client/workspaceFile.ts"
  ],
  "subagent": [
    "ac-client-ui-layout/client/uiStore.ts",
    "ac-client-ui-theme/client/themeStore.ts",
    "ac-client-ui-agents/client/rosterAccess.ts",
    "ac-client-ui-conversation/client/historyApi.ts",
    "ac-client-ui-conversation/client/feed.ts",
    "ac-client-ui-conversation/client/useTurnDisplayItems.ts",
    "ac-client-ui-conversation/client/TranscriptList.vue",
    "ac-client-ui-jobs/client",
    "ac-client-ui-conversation/client/viewer.ts",
    "ac-client-ui-conversation/client/types.ts"
  ],
  "run-code": [
    "ac-client-ui-renderer/client/useMarkdown.ts",
    "ac-client-ui-renderer/client/ScrollableViewport.vue",
    "ac-client-ui-tool/client/toolIcon.ts",
    "ac-client-ui-renderer/client/codeFence.ts"
  ],
  "run-nodes": [
    "ac-client-ui-layout/client/uiStore.ts",
    "ac-client-ui-conversation/client/feedStore.ts",
    "ac-client-ui-layout/client/auxSidebarViews.ts",
    "ac-client-ui-conversation/client/types.ts"
  ],
  "llm-pool": [
    "ac-client-ui-settings/client/useSettings.ts",
    "ac-client-ui-settings/client/rpcDefault.ts",
    "ac-client-ui-settings/client/types.ts",
    "ac-client-ui-settings/client/components/SettingField.vue",
    "ac-client-ui-settings/client/components/ConfirmDialog.vue",
    "ac-client-ui-settings/client/api.ts"
  ],
  "plugin-registry": [
    "ac-client-ui-settings/client/types.ts",
    "ac-client-ui-settings/client/api.ts",
    "ac-client-ui-workspace/client/EntryPickerModal.vue",
    "ac-client-ui-settings/client/components/ConfirmDialog.vue",
    "ac-client-ui-settings/client/slotCatalog.ts"
  ],
  "search-pool": [
    "ac-client-ui-settings/client/types.ts",
    "ac-client-ui-settings/client/schema.ts",
    "ac-client-ui-settings/client/components/SettingField.vue",
    "ac-client-ui-settings/client/components/ConfirmDialog.vue",
    "ac-client-ui-settings/client/rpcDefault.ts",
    "ac-client-ui-settings/client/useSettings.ts",
    "ac-client-ui-settings/client/api.ts"
  ],
  "onboarding": [
    "ac-client-ui-settings/client/api.ts",
    "ac-client-ui-agents/client/poolModelCache.ts",
    "ac-client-ui-agents/client/index.ts",
    "ac-client-ui-settings/client/rpcDefault.ts",
    "ac-client-ui-settings/client/types.ts",
    "ac-client-ui-llm-pool/client/poolApi.ts",
    "ac-client-ui-llm-pool/client/PoolEntryForm.vue",
    "ac-client-ui-search-pool/client/searchPoolApi.ts",
    "ac-client-ui-search-pool/client/SearchEntryForm.vue"
  ],
  "remote": [
    "ac-client-ui-settings/client/rpcDefault.ts"
  ]
};

// 主线 clientPlugin 导出名
const EXPORTS = {
  "runview": "runviewClientPlugin",
  "workspace": "workspaceClientPlugin",
  "singles": "singlesClientPlugin",
  "group": "groupClientPlugin",
  "agents": "rosterClientPlugin",
  "usage": "usageClientPlugin",
  "system": "systemClientPlugin",
  "timer": "timerClientPlugin",
  "shell": "shellCardClientPlugin",
  "fs": "fsCardClientPlugin",
  "web": "webCardClientPlugin",
  "browser": "browserCardClientPlugin",
  "subagent": "subagentClientPlugin",
  "run-code": "runCodeCardClientPlugin",
  "run-nodes": "runNodesClientPlugin",
  "llm-pool": "llmPoolClientPlugin",
  "plugin-registry": "pluginRegistryClientPlugin",
  "search-pool": "searchPoolClientPlugin",
  "onboarding": "onboardingClientPlugin",
  "remote": "remoteDevicesClientPlugin",
  "todo": "todoClientPlugin",
  "jobs": "jobsClientPlugin",
  "goal": "goalClientPlugin",
  "skill": "skillClientPlugin",
  "desktop-storage": "desktopStorageClientPlugin"
};

// 引 @agentchat/webui-kit 的域行（除 skill 全员）
const KIT_USE = new Set(["runview","todo","jobs","workspace","singles","group","agents","goal","usage","system","timer","shell","fs","web","browser","subagent","run-code","run-nodes","llm-pool","plugin-registry","desktop-storage","search-pool","onboarding","remote"]);

const BASE = ['vue', 'pinia', '@agentchat/cordis', 'ac-client-runtime', 'ac-client-slots'];

// —— 现状重扫（--check 对账用）——
function scanDeps() {
  const found = {};
  const names = readdirSync(srcRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('ac-client-ui-'))
    .map((e) => e.name.slice('ac-client-ui-'.length));
  const deep = new Set(names.map((n) => 'ac-client-ui-' + n));
  for (const d of names) {
    const dir = join(srcRoot, 'ac-client-ui-' + d, 'client');
    if (!existsSync(dir)) continue;
    const specs = new Set();
    walk(dir, specs, deep, d);
    if (specs.size > 0) found[d] = [...specs].sort();
  }
  return found;
}

function walk(dir, specs, deepPkgs, self) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, specs, deepPkgs, self); continue; }
    if (!/\.(ts|vue)$/.test(e.name)) continue;
    const text = readFileSync(p, 'utf-8');
    // 静态 from '...' + 动态 import('...')（defineAsyncComponent 的异步视角/面板组件——
    // 动态说明符同样需外部化共享：漏扫 = 组件被内联拷贝进本通道 bundle，与宿主侧
    // 另一副本双装载〔singles 内联 ConversationView 与 conversation 通道双实例教训〕）
    for (const re of [/from '([^']+)'/g, /import\('([^']+)'\)/g]) {
      for (const m of text.matchAll(re)) {
        const spec = m[1];
        if (!spec.startsWith('ac-client-ui-')) continue;
        const pkg = spec.slice('ac-client-ui-'.length).split('/')[0];
        if (pkg === self) continue;
        if (deepPkgs.has(spec.split('/')[0])) specs.add(spec);
      }
    }
  }
}

function scanExports() {
  const out = {};
  const names = Object.keys(DEPS).concat(['todo', 'jobs', 'goal', 'skill', 'desktop-storage']);
  for (const d of names) {
    const idx = join(srcRoot, 'ac-client-ui-' + d, 'client', 'index.ts');
    if (!existsSync(idx)) continue;
    const m = readFileSync(idx, 'utf-8').match(/export const (\w+[Pp]lugin)/);
    if (m) out[d] = m[1];
  }
  return out;
}

// —— 生成 ——
// 快照自更新：generate 以现状重扫为准（--check 发现漂移后直接 generate 即吸收——
// 否则 DEPS 内嵌快照永不变化，manifest 恒写旧值，对账与生成脱节）
function refreshSnapshot() {
  const now = scanDeps();
  for (const k of Object.keys(now)) DEPS[k] = now[k];
  for (const k of Object.keys(DEPS)) if (!(k in now)) delete DEPS[k];
  // EXPORTS 吸收限域行集：骨架四件（conversation/tool/settings/markdown-render）
  // 是 8.5b 手工通道包，不走生成器——scanExports 的扫描范围随 DEPS 键扩张
  //（跨包深引如 layout），不滤则误生成骨架件的通道副本（26≠25 对账破）
  const SKELETON = new Set(['conversation', 'tool', 'settings', 'markdown-render', 'theme', 'renderer', 'layout']);
  const expNow = scanExports();
  for (const k of Object.keys(expNow)) {
    if (SKELETON.has(k)) continue;
    EXPORTS[k] = expNow[k];
  }
  for (const k of Object.keys(EXPORTS)) if (!(k in expNow)) delete EXPORTS[k];
}
function channelImports(d) {
  const list = [...BASE];
  if (KIT_USE.has(d)) list.push('@agentchat/webui-kit');
  for (const spec of DEPS[d] || []) list.push(spec);
  return list;
}

function generate() {
  refreshSnapshot();
  const names = Object.keys(EXPORTS);
  for (const d of names) {
    const dir = join(channelRoot, d);
    mkdirSync(join(dir, 'src'), { recursive: true });
    const exp = EXPORTS[d];
    writeFileSync(join(dir, 'src', 'index.ts'),
      '// ' + d + ' 通道模块（8.5c 域行 manifest 声明化）——re-export 主线' + '\n' +
      '// ac-client-ui-' + d + ' clientPlugin（物理迁出归 cutover）。生成器：' + '\n' +
      '// scripts/gen-domain-channels.mjs（快照漂移先 --check 对账再生成）。' + '\n' +
      "import { " + exp + " } from 'ac-client-ui-" + d + "/client';" + '\n' + '\n' +
      'export default ' + exp + ';' + '\n');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      name: d,
      version: '0.1.0',
      entry: 'ui/index.js',
      platform: 'web',
      isolated: false,
      channelImports: channelImports(d),
    }, null, 2) + '\n');
    const deps = { 'ac-client-runtime': 'workspace:*', ['ac-client-ui-' + d]: 'workspace:*' };
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'ac-ui-channel-' + d,
      version: '0.1.0',
      private: true,
      type: 'module',
      description: d + ' 通道模块（8.5c）：re-export 主线 ac-client-ui-' + d + ' clientPlugin——域行 manifest 通道装载形态；生成产物（gen-domain-channels.mjs）',
      exports: { '.': './src/index.ts' },
      dependencies: deps,
      keywords: ['agentchat'],
    }, null, 2) + '\n');
  }
  console.log('[gen-domain-channels] 生成 ' + names.length + ' 通道包');
}

// —— 对账（--check）——
function check() {
  const drift = [];
  const depsNow = scanDeps();
  const expNow = scanExports();
  // 对账域 = 25 域行（骨架六包深引归 8.5b 范畴，不在此表）
  const all = new Set([...Object.keys(DEPS), ...Object.keys(EXPORTS), ...Object.keys(depsNow).filter((d) => d in EXPORTS), ...Object.keys(expNow).filter((d) => d in EXPORTS)]);
  for (const d of all) {
    const want = (DEPS[d] || []).slice().sort().join('|');
    const now = (depsNow[d] || []).sort().join('|');
    if (want !== now) drift.push(d + ' DEPS 漂移：快照 ' + (DEPS[d] || []).length + ' 条 vs 现状 ' + (depsNow[d] || []).length + ' 条');
    if (EXPORTS[d] !== expNow[d]) drift.push(d + ' 导出名漂移：' + EXPORTS[d] + ' vs ' + expNow[d]);
  }
  if (drift.length) { console.error('[gen-domain-channels] 快照漂移：\\n' + drift.join('\\n')); process.exit(1); }
  console.log('[gen-domain-channels] 对账通过（' + Object.keys(EXPORTS).length + ' 行）');
}

if (process.argv.includes('--check')) check();
else generate();