// ============================================================
// settings/useSettings.ts —— 设置面板核心状态（全局配置半边）
// 设计：展示用 effective（后端解析），编辑用 raw（差异），
//       dirty 检测基于保存快照，保存统一走 api.ts。
//
// M29 P1-3 数据面归域后的留守面：全局配置 + schema/pools 元数据 +
// 保存编排 + 重启。agent 编辑编排归 ui-agents（useAgentSettings）、
// 插件域状态归 ui-plugin-registry（PluginLibraryHost/ExtToolsPane
// 自取数）、池编排归 ui-llm-pool（Host 自理）。
// ============================================================

import { ref, computed } from 'vue';
import * as api from './api.ts';
import { sanitizeGlobalConfig } from './schema.ts';
import type { PoolData } from './types.ts';
import { defaultRpc as wireRpc } from './rpcDefault.ts';

export function useSettings() {
  // ── 元数据（schema / pools——全局配置树 + 插件全局页签 props 面） ──
  const llmSchemas = ref<Record<string, any[]>>({});
  const searchSchemas = ref<Record<string, any[]>>({});
  /** 命名空间 schema：key = 完整配置键（如 'tool.bash'） */
  const nsSchemas = ref<Record<string, any[]>>({});
  const pools = ref<PoolData>({ llmProviders: {}, searchProviders: {} });
  const loading = ref(false);
  const error = ref('');

  // ── 全局配置 ──
  const globalConfig = ref<Record<string, any>>({});
  const globalSaved = ref('');
  const globalDirty = computed(() => globalSaved.value !== '' && snapshot(globalConfig.value) !== globalSaved.value);

  /** 全局配置快照（sanitize 后，与写盘一致） */
  function snapshot(raw: Record<string, any>): string {
    return JSON.stringify(sanitizeGlobalConfig(raw));
  }

  // ── 加载 ──
  async function loadMeta(): Promise<void> {
    loading.value = true;
    try {
      const [llmR, searchR, nsR, poolR] = await Promise.allSettled([
        api.getLlmSchemas(),
        api.getSearchSchemas(),
        api.getNamespaceSchemas(),
        api.getPools(),
      ]);
      if (llmR.status === 'fulfilled') llmSchemas.value = llmR.value;
      if (searchR.status === 'fulfilled') searchSchemas.value = searchR.value;
      if (nsR.status === 'fulfilled') {
        const d = nsR.value;
        nsSchemas.value = d.namespaces ?? {};
        // 兼容旧结构：{ extensions, tools }
        if (d.tools && typeof d.tools === 'object') {
          for (const [k, v] of Object.entries(d.tools)) if (!(k in nsSchemas.value)) nsSchemas.value[`tool.${k}`] = v as any[];
        }
      }
      if (poolR.status === 'fulfilled') pools.value = poolR.value;
      // 静默失败此前出空 UI 无任何报错（provider 下拉空、表单"无配置项"）——聚合提示
      const failed = [llmR, searchR, nsR, poolR].filter(r => r.status === 'rejected') as PromiseRejectedResult[];
      if (failed.length > 0) {
        error.value = `部分元数据加载失败（${failed.length}/4 项）：${failed.map(f => f.reason?.message ?? String(f.reason)).join('; ')}`;
      }
    } finally {
      loading.value = false;
    }
  }

  /** 加载全局配置 */
  async function loadGlobal(): Promise<void> {
    try {
      const data = await api.getGlobalConfig();
      globalConfig.value = data.config ?? {};
      globalSaved.value = snapshot(globalConfig.value);
    } catch (e: any) {
      error.value = `加载全局配置失败: ${e.message}`;
    }
  }

  // ── 保存 ──
  async function saveGlobal(): Promise<boolean> {
    // 防御：全局配置为空对象说明前端状态异常（如 HMR 重置），拒绝写盘避免覆盖后端
    if (Object.keys(globalConfig.value).length === 0) {
      error.value = '全局配置为空，已取消保存。请关闭并重新打开设置后重试';
      return false;
    }
    try {
      // sanitize 后再写盘：llm $ref 折叠（防 GET 展开对象回写冻结池引用）、
      // 掩码 api_key 清理（此前仅快照用 sanitize，写盘是原始对象——接线遗漏）
      await api.saveGlobalConfig(sanitizeGlobalConfig(globalConfig.value));
      globalSaved.value = snapshot(globalConfig.value);
      return true;
    } catch (e: any) {
      error.value = `保存失败: ${e.message}`;
      return false;
    }
  }

  /** 请求重启后端（Port B：system/restart RPC；调用方管理 restarting 状态） */
  function restartBackend(): void {
    void wireRpc.call('system/restart').catch(() => undefined);
  }

  // ── 命名空间访问 helper ──
  function nsValue(nsKey: string, fieldKey: string): any {
    if (!nsKey) return globalConfig.value[fieldKey];
    return (globalConfig.value[nsKey] ?? {})[fieldKey];
  }
  function setNsValue(nsKey: string, fieldKey: string, value: any): void {
    if (!nsKey) { globalConfig.value[fieldKey] = value; return; }
    if (!globalConfig.value[nsKey]) globalConfig.value[nsKey] = {};
    globalConfig.value[nsKey][fieldKey] = value;
  }

  return {
    // 状态
    llmSchemas, searchSchemas, nsSchemas, pools,
    loading, error,
    globalConfig, globalDirty,
    // 动作
    loadMeta, loadGlobal,
    saveGlobal,
    restartBackend,
    nsValue, setNsValue,
  };
}
