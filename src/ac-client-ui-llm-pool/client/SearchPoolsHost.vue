<script setup lang="ts">
// ============================================================
// client/SearchPoolsHost.vue —— 搜索引擎节宿主（settings:section 贡献）
//（M28 P2：原 settings SettingsPanel 内联 PoolManager〔kind=search〕
// 迁入——池更新/默认同步/定向落盘编排随行走）
// ============================================================
import PoolManager from './PoolManager.vue';
import { useSettings } from 'ac-client-ui-settings/client/useSettings.ts';
import * as api from 'ac-client-ui-settings/client/api.ts';
import { applySearchPoolDefault } from 'ac-client-ui-settings/client/schema.ts';

const settings = useSettings();

async function saveNow(): Promise<void> {
  try {
    await api.savePoolDomain('searchProviders', settings.pools.value.searchProviders as Record<string, unknown>);
  } catch (e) {
    settings.error.value = `搜索引擎保存失败: ${(e as { message?: string })?.message ?? String(e)}`;
  }
}

function onPoolsUpdate(pools: Record<string, unknown>): void {
  settings.pools.value = { ...settings.pools.value, searchProviders: pools as never };
  settings.globalConfig.value.searchProviders = pools as never;
  // 池「设为默认」须同步全局引用：残留显式引用对象会静默遮蔽池默认
  //（详见 settings schema applySearchPoolDefault 注释）
  applySearchPoolDefault(pools, settings.globalConfig.value as Record<string, unknown>);
}
</script>

<template>
  <PoolManager
    kind="search"
    :pools="settings.pools.value.searchProviders"
    :schemas="settings.searchSchemas.value"
    :on-saved="saveNow"
    @update:pools="onPoolsUpdate"
  />
</template>
