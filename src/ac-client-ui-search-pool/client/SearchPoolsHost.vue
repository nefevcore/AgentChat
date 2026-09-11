<script setup lang="ts">
// ============================================================
// client/SearchPoolsHost.vue —— 搜索引擎节宿主（settings:section 贡献）
//（2026-11 自 ui-llm-pool 迁入〔行拆分〕：编排/DOM/Props 面不变——
//  M28 P2 原 settings 内联迁 ui-llm-pool → M29 P1-3d 数据面归域 →
//  2026-11 拆分独立行；本包 searchPoolApi 写面 + settings 只读元
//  数据，节挂载即自装载）
// ============================================================
import { onMounted, ref } from 'vue';
import SearchPoolManager from './SearchPoolManager.vue';
import { useSettings } from 'ac-client-ui-settings/client/useSettings.ts';
import { defaultRpc } from 'ac-client-ui-settings/client/rpcDefault.ts';
import { applySearchPoolDefault } from 'ac-client-ui-settings/client/schema.ts';
import { saveSearchPoolDomain } from './searchPoolApi.ts';

const settings = useSettings();
/** 节内错误条（原共享 store error 的节内等价物） */
const error = ref('');

onMounted(() => { void settings.loadMeta(); });

async function saveNow(): Promise<void> {
  try {
    await saveSearchPoolDomain(settings.pools.value.searchProviders as Record<string, unknown>, defaultRpc);
  } catch (e) {
    error.value = `搜索引擎保存失败: ${(e as { message?: string })?.message ?? String(e)}`;
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
  <SearchPoolManager
    :pools="settings.pools.value.searchProviders"
    :schemas="settings.searchSchemas.value"
    :on-saved="saveNow"
    @update:pools="onPoolsUpdate"
  />
</template>
