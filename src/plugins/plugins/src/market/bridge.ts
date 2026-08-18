// ============================================================
// @agentchat/plugins/src/market/bridge.ts —— 市场插件组合桥
//
// 组合树里的"市场插件行"指向本模块（行 config.name = manifest.name）：
//   apply  → 从 registry 读安装记录 → ctx.pluginHost.load（沿用
//            权限/契约/inject 门禁——代码进进程前的全部检查不绕过）
//   dispose → ctx.pluginHost.unload（fiber 回收 + owner 注册清理）
//
// 幂等性（与启动扫描共存，避免双重装载churn）：
//   · apply 时 host.has(name) → 跳过（已被启动扫描/市场 install 装载）
//   · 记录消失（卸载中途）→ 告警并成为惰性行（不抛错挂 PENDING）
//
// 由此市场插件获得补丁语义：用户层可按 id（market/<name>）定点
// 停用/改配置/恢复，保存即热生效（与内置行完全同权）。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import type { Context } from '@agentchat/cordis';
import type { PluginHost } from '../host';
import { listInstalled, pluginsRoot } from '../registry';

export const name = 'agentchat-market-bridge';
export const inject = ['pluginHost'];

/** 工作区目录（与 market.ts 同语义：AGENTCHAT_WORKSPACE 或 workspace/default） */
function resolveWorkspaceDir(): string {
  const ws = process.env.AGENTCHAT_WORKSPACE ?? 'workspace/default';
  return path.isAbsolute(ws) ? ws : path.resolve(process.cwd(), ws);
}

export interface MarketBridgeConfig {
  /** 插件名（= manifest.name = registry 键） */
  name?: string;
}

export async function apply(ctx: Context, config: MarketBridgeConfig = {}) {
  const pluginName = config.name;
  if (!pluginName || typeof pluginName !== 'string') {
    throw new Error('市场桥行需要 config.name（manifest.name）');
  }
  // inject 运行时保证就绪；类型侧经 cast（vendored Context 接口未导出注入收窄）
  const host = ctx.pluginHost as PluginHost;
  const ws = resolveWorkspaceDir();

  const record = listInstalled(ws).find((r) => r.manifest.name === pluginName);
  if (!record) {
    // 卸载进行中/registry 手工清理：惰性行，不阻断组合树
    ctx.logger('market').warn(`市场行 "${pluginName}" 无安装记录（已卸载？），行保持惰性`);
    return;
  }
  const dir = path.join(pluginsRoot(ws), record.dir);
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    ctx.logger('market').warn(`市场行 "${pluginName}" 目录缺失（${dir}），行保持惰性`);
    return;
  }

  if (!host.has(pluginName) && !host.isLoading(pluginName)) {
    await host.load({
      manifest: record.manifest,
      dir,
      agentId: record.owner,
      sessionOnly: false,
      // 按安装时授予快照恢复（registry 里的授予是宿主确认过的）
      allowedPermissions: record.permissions,
    });
    ctx.logger('market').info(`市场插件 "${pluginName}@${record.manifest.version}" 经组合行装载`);
  }

  // 行回收 = 卸载该插件（用户层 disable / registry 变化重组合都会走到这）
  return () => host.unload(pluginName);
}
