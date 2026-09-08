<script setup lang="ts">
// ============================================================
// client/LlmPoolsHost.vue —— 模型管理节宿主（settings:section 贡献）
//（M28 P2：原 settings SettingsPanel 内联 PoolManager〔kind=llm〕迁入
// ——池更新/定向落盘编排随行走，settings 共享 store 经跨包 import）
// ============================================================
import PoolManager from './PoolManager.vue';
import { useSettings } from 'ac-client-ui-settings/client/useSettings.ts';
import * as api from 'ac-client-ui-settings/client/api.ts';

const settings = useSettings();

/** 池编辑即时落盘（定向 config/set——api_key 侧信道语义在服务端）；
 *  失败提示到面板错误条 */
async function saveNow(): Promise<void> {
  try {
    await api.savePoolDomain('llmProviders', settings.pools.value.llmProviders as Record<string, unknown>);
  } catch (e) {
    settings.error.value = `模型管理保存失败: ${(e as { message?: string })?.message ?? String(e)}`;
  }
}

function onPoolsUpdate(pools: Record<string, unknown>): void {
  settings.pools.value = { ...settings.pools.value, llmProviders: pools as never };
  settings.globalConfig.value.llmProviders = pools as never;
  // 池 v2（llm-provider-model-plan）：连接池无全局 llm 引用同步——
  // 默认连接 = 条目 default:true 标记（服务端 defaultPoolConnection 直读）
}
</script>

<template>
  <PoolManager
    kind="llm"
    :pools="settings.pools.value.llmProviders"
    :schemas="settings.llmSchemas.value"
    :on-saved="saveNow"
    @update:pools="onPoolsUpdate"
  />
</template>
