// ============================================================
// ac-plugin-registry/src/patch-rpc.ts —— 行偏好急救通道子行
//
// plugin/patch-list · plugin/patch-set 的注册行（2026-08-30 从 ac-web-api
// 迁出，三连事故落地）：
//   · 事故形态：停用 ac-agent-loop 级联 agentLoop→router→conversation→
//     ac-web-api 全链下线，行偏好 RPC 原住 web-api——急救通道跟着阵亡，
//     UI 无法自救（恢复开关本身就在死掉的面里）；
//   · 本行仅注入 webServer（不在 agent-loop 级联闭包内），级联后仍存活；
//     pluginRegistry 为**软依赖**（ctx.get 运行时探测）——服务在位走
//     服务（含热通道，setPatch(id,false) 可反向恢复整棵树）；
//   · 降级模式（pluginRegistry 无提供方——如停用 ac-tools 连带安装域）：
//     直接落 ac-plugin-core 纯函数文件域（readPatchFile/setPatchEntry，
//     root 走缺省链 AGENTCHAT_DATA_ROOT ?? './data'）——patch-list 照常
//     读、patch-set 照常写（state 恒 'written' + restartRequired：热通道
//     逻辑住服务内，不在此复制）——还原仍可从 UI 完成，代价是需重启；
//   · 按框架规则「部分功能依赖独立成子插件行」拆行——不把整个安装域
//     （install/staging/audit）硬绑到传输层；
//   · 真盲区只剩 ac-web-server（传输本体 = UI 的存在前提）——彼时手工
//     编辑 cordis.patch.yml 删条目 + 重启（文件人可读可急救，M23 A2 设计）。
// 装配：cordis.yml 本地路径行（'./ac-plugin-registry/src/patch-rpc.ts'），
// 与 ac-app TREE 的 patch-rpc 行集保持一致。
// ============================================================
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import { patchFilePath, readPatchFile, setPatchEntry, writePatchFile, type PatchFileEntry } from 'ac-plugin-core';

export const name = 'ac-plugin-registry/patch-rpc';

export const inject = ['webServer'];

/** 降级模式数据根（与 PluginRegistryService 缺省链同款；服务在位时不走此路径） */
function defaultRoot(): string {
  return path.resolve(process.env.AGENTCHAT_DATA_ROOT ?? './data');
}

export function apply(ctx: Context) {
  ctx.webServer.registerRpc('plugin/patch-list', () => {
    const registry = ctx.get('pluginRegistry', false) as
      | { listPatches(): { patches: PatchFileEntry[]; file: string; warnings: string[] } }
      | undefined;
    if (registry) return registry.listPatches();
    // 降级：纯函数文件域直读（服务无提供方——如停用 ac-tools 连带安装域）
    const root = defaultRoot();
    const read = readPatchFile(root);
    return { patches: read.patches, file: patchFilePath(root), warnings: read.warnings };
  });

  ctx.webServer.registerRpc('plugin/patch-set', async (params) => {
    const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
    const id = typeof p.id === 'string' ? p.id.trim() : '';
    if (!id) throw new Error('参数 id 缺失（yml 裸行 id）');
    const registry = ctx.get('pluginRegistry', false) as
      | {
          setPatch(
            id: string,
            disabled: boolean,
          ): Promise<{ state: 'hot' | 'written' | 'no-include-row'; restartRequired?: boolean; patches: PatchFileEntry[] }>;
        }
      | undefined;
    if (registry) return registry.setPatch(id, p.disabled !== false);
    // 降级：纯函数文件域直写——热通道逻辑住服务内，此处恒"重启后生效"
    const patches = await setPatchEntry(defaultRoot(), id, p.disabled !== false);
    return { state: 'written' as const, restartRequired: true, patches };
  });

  // 还原模式（2026-08-30）：factory（清空停用 = 出厂全量装配）/
  // minimal（只保留最小可运行集——安全模式基线）。服务在位走服务
  // （含热通道）；降级时 factory 走纯函数、minimal 需 loader 枚举
  // （loader 是根插件不随行停用，降级态仍可枚举）。
  ctx.webServer.registerRpc('plugin/patch-reset', async (params) => {
    const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
    const mode = p.mode === 'minimal' ? 'minimal' : p.mode === 'factory' ? 'factory' : undefined;
    if (!mode) throw new Error('参数 mode 缺失（factory | minimal）');
    const registry = ctx.get('pluginRegistry', false) as
      | {
          resetPatches(
            mode: 'factory' | 'minimal',
          ): Promise<{ state: 'hot' | 'written' | 'no-include-row'; restartRequired?: boolean; patches: PatchFileEntry[] }>;
        }
      | undefined;
    if (registry) return registry.resetPatches(mode);
    if (mode === 'factory') {
      await writePatchFile(defaultRoot(), []);
      return { state: 'written' as const, restartRequired: true, patches: [] as PatchFileEntry[] };
    }
    // minimal 降级：loader 枚举 + 核心集差集（与服务同款静态集）
    const { PluginRegistryService } = await import('./service.ts');
    const ids = PluginRegistryService.enumerateDisablableEntryIds(ctx);
    if (ids === undefined) {
      throw new Error('无装配树可枚举（进程非 loader 组合）——minimal 模式不可用，可用 factory');
    }
    const core = PluginRegistryService.MINIMAL_CORE_ENTRY_IDS;
    const patches = ids.filter((id) => !core.has(id)).sort().map((id) => ({ id, disabled: true }));
    await writePatchFile(defaultRoot(), patches);
    return { state: 'written' as const, restartRequired: true, patches };
  });
}
