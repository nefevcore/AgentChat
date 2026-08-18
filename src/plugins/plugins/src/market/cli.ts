// ============================================================
// @agentchat/plugins/src/market/cli.ts —— `agentchat plugin` 子命令
//
// 用法：
//   agentchat plugin search [关键词]           # topic:agentchat-plugin 发现（写缓存）
//   agentchat plugin add <owner/repo[#ref]|name>
//       [--grants fs,network,shell,process,ui] # 高危权限必须显式授予
//       [--stage-only] [--workspace dir] [--owner name]
//   agentchat plugin list [--workspace dir]    # 已安装清单（含来源锚定）
//   agentchat plugin staging [--workspace dir] # 待审暂存清单
//   agentchat plugin remove <name> [--workspace dir]
//
// 边界（与 WebUI 完全一致，CLI 不是后门）：
//   · add 缺高危 grants → 自动清理本次暂存并退出码 2（不残留待审）
//   · --stage-only → 停在 staging，走 WebUI 人审 / agentchat plugin staging
//   · 独立进程无 pluginHost：安装只落盘，宿主重启时扫描装载
//   · 零网络启动路径：search 显式触发；add 需要网络
// ============================================================
import * as process from 'process';
import { Context } from '@agentchat/cordis';
import { KNOWN_PERMISSIONS, type PluginPermission } from '@agentchat/agent-config';
import { MarketService } from './market';
import { approveStaging, listInstalled, listStaging, rejectStaging, uninstallPlugin } from '../registry';

interface CliOptions {
  grants?: string[];
  stageOnly?: boolean;
  workspace?: string;
  owner?: string;
}

function parseArgs(argv: string[]): { command: string; positional: string[]; options: CliOptions } {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const options: CliOptions = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--grants') {
      const value = rest[++i];
      if (!value) fail('--grants 需要逗号分隔的权限列表（如 --grants shell,ui）');
      options.grants = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--stage-only') {
      options.stageOnly = true;
    } else if (arg === '--workspace') {
      const value = rest[++i];
      if (!value) fail('--workspace 需要目录参数');
      options.workspace = value;
    } else if (arg === '--owner') {
      const value = rest[++i];
      if (!value) fail('--owner 需要名字参数');
      options.owner = value;
    } else if (arg.startsWith('--')) {
      fail(`未知参数: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { command: command ?? 'help', positional, options };
}

function fail(message: string, code = 1): never {
  console.error(`✗ ${message}`);
  process.exit(code);
}

function parseGrantsList(grants: string[] | undefined): string[] {
  if (!grants) return [];
  for (const g of grants) {
    if (!KNOWN_PERMISSIONS.includes(g as PluginPermission)) {
      fail(`未知权限 "${g}"（可选：${KNOWN_PERMISSIONS.join('/')}）`, 2);
    }
  }
  return grants;
}

function makeMarket(options: CliOptions): MarketService {
  const ctx = new Context();
  return new MarketService(ctx, {
    ...(options.workspace ? { workspaceDir: options.workspace } : {}),
    ...(options.owner ? { owner: options.owner } : {}),
  });
}

const HELP = `agentchat plugin —— 插件市场命令

用法：
  agentchat plugin search [关键词]              搜索市场（GitHub topic:agentchat-plugin；结果写本地缓存）
  agentchat plugin add <说明符> [选项]           安装市场插件
      说明符：owner/repo | owner/repo#ref | name（须先 search）
      --grants <a,b,...>   显式授予高危权限（process/shell/ui 必需，否则拒绝安装）
      --stage-only         只暂存待审（WebUI 人审或后续 approve）
      --workspace <dir>    工作区目录（缺省 AGENTCHAT_WORKSPACE / workspace/default）
      --owner <name>       安装 owner 记录（缺省 market）
  agentchat plugin list                        已安装清单（含市场来源 commit 锚定）
  agentchat plugin staging                     待审暂存清单
  agentchat plugin remove <name>               卸载（目录移 .backup）

信任边界：市场安装与本地发布走同一条 staging 审查管；
高危权限不因 CLI 而放松——缺 grants 时自动清理暂存并拒绝。`;

async function cmdSearch(query: string | undefined, options: CliOptions): Promise<void> {
  const market = makeMarket(options);
  console.log('搜索市场（topic:agentchat-plugin）…');
  const result = await market.search(query);
  if (result.stale) {
    console.warn(`⚠ 在线搜索失败（${result.error ?? '未知错误'}），以下为本地缓存：`);
  } else if (result.error) {
    console.warn(`⚠ 部分源失败：${result.error}`);
  }
  if (result.entries.length === 0) {
    console.log('（无结果）');
    return;
  }
  for (const entry of result.entries) {
    const meta = [
      entry.repo,
      entry.stars !== undefined ? `★${entry.stars}` : undefined,
      entry.updatedAt ? entry.updatedAt.slice(0, 10) : undefined,
    ].filter(Boolean).join('  ');
    console.log(`· ${entry.name}${entry.manifest ? `@${entry.manifest.version}` : ''}`);
    console.log(`  ${meta}`);
    if (entry.description) console.log(`  ${entry.description}`);
  }
  console.log(`\n共 ${result.entries.length} 条${result.stale ? '（缓存）' : ''}；安装：agentchat plugin add <owner/repo>`);
}

function printStagedSummary(record: { id: string; manifest: { name: string; version: string; permissions?: string[] }; requiredGrants?: string[]; hash: string; source?: { repo?: string; ref?: string; commit?: string } }): void {
  console.log(`已暂存：${record.manifest.name}@${record.manifest.version}`);
  console.log(`  权限声明：${(record.manifest.permissions ?? []).join('/') || '（无）'}`);
  console.log(`  需显式授予：${(record.requiredGrants ?? []).join('/') || '（无）'}`);
  if (record.source?.repo) {
    console.log(`  来源：${record.source.repo}${record.source.ref ? `@${record.source.ref}` : ''} #${(record.source.commit ?? '').slice(0, 8)}`);
  }
  console.log(`  hash：${record.hash.slice(0, 12)}…`);
}

async function cmdAdd(spec: string, options: CliOptions): Promise<void> {
  const market = makeMarket(options);
  console.log(`解析 ${spec} → 钉定 commit → 下载 → 安全解包 → 暂存…`);
  const record = await market.stage(spec, options);
  printStagedSummary(record);

  if (options.stageOnly) {
    console.log('\n--stage-only：已停在待审（WebUI 插件库 → 待审暂存；或 agentchat plugin staging 查看）');
    return;
  }

  const grants = parseGrantsList(options.grants);
  const missing = (record.requiredGrants ?? []).filter((p) => !grants.includes(p));
  if (missing.length > 0) {
    // 与 MarketService.install 同语义：清理本次暂存，不残留待审项
    rejectStaging(market.workspaceRootDir, record.id);
    fail(`插件 "${record.manifest.name}" 需要显式授予权限：${missing.join('/')}\n  重试：agentchat plugin add ${spec} --grants ${missing.join(',')}\n  或走人审：agentchat plugin add ${spec} --stage-only`, 2);
  }

  const approved = approveStaging(market.workspaceRootDir, record.id, grants);
  console.log(`\n✓ 已安装 ${approved.name}@${approved.version} → ${approved.installedDir}`);
  if (approved.replaced) {
    console.log(`  替换旧版 ${approved.replaced.oldVersion}（备份：${approved.replaced.backupDir}）`);
  }
  console.log('  宿主重启后自动加载（正在运行的宿主请重启，或经 WebUI 安装可即时装载）。');
}

async function cmdList(options: CliOptions): Promise<void> {
  const market = makeMarket(options);
  const installed = listInstalled(market.workspaceRootDir);
  if (installed.length === 0) {
    console.log('（插件库为空）');
    return;
  }
  for (const record of installed) {
    const source = record.source?.kind === 'market'
      ? `market:${record.source.repo}@${(record.source.commit ?? '').slice(0, 8)}`
      : 'local';
    console.log(`· ${record.manifest.name}@${record.manifest.version}  [${source}]  权限：${(record.permissions ?? []).join('/') || '（无）'}`);
  }
}

async function cmdStaging(options: CliOptions): Promise<void> {
  const market = makeMarket(options);
  const staging = listStaging(market.workspaceRootDir);
  if (staging.length === 0) {
    console.log('（无待审暂存）');
    return;
  }
  for (const record of staging) {
    printStagedSummary(record);
    console.log(`  暂存 id：${record.id}\n`);
  }
  console.log('审查与授予：WebUI 插件库 → 待审暂存（可逐文件审查源码）');
}

async function cmdRemove(name: string, options: CliOptions): Promise<void> {
  const market = makeMarket(options);
  const result = uninstallPlugin(market.workspaceRootDir, name);
  console.log(`✓ 已卸载 ${result.name}${result.backupDir ? `（备份：${result.backupDir}）` : ''}`);
  console.log('  Agent presets 中的引用保留（未注册名烘焙时自动跳过）。');
}

export async function runCli(argv: string[]): Promise<number> {
  const { command, positional, options } = parseArgs(argv);

  try {
    switch (command) {
      case 'search':
        await cmdSearch(positional[0], options);
        return 0;
      case 'add':
        if (!positional[0]) fail('add 需要说明符：owner/repo | owner/repo#ref | name', 2);
        await cmdAdd(positional[0], options);
        return 0;
      case 'list':
        await cmdList(options);
        return 0;
      case 'staging':
        await cmdStaging(options);
        return 0;
      case 'remove':
      case 'uninstall':
        if (!positional[0]) fail('remove 需要插件名', 2);
        await cmdRemove(positional[0], options);
        return 0;
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        return 0;
      default:
        fail(`未知子命令: ${command}\n\n${HELP}`, 2);
    }
  } catch (err: any) {
    fail(err?.message ?? String(err));
  }
}

// 作为入口脚本运行时（dist/cli.mjs 打包态；或 dev 经 tsx 直接跑本文件）
const entry = process.argv[1] ?? '';
if (entry.endsWith('cli.mjs') || entry.endsWith('cli.ts')) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
