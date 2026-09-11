<script setup lang="ts">
// ============================================================
// client/LlmPoolsHost.vue —— 模型管理节宿主（settings:section 贡献）
//（M28 P2：原 settings SettingsPanel 内联 PoolManager〔kind=llm〕迁入；
//  M29 P1-3d：数据面归域——本包 poolApi 写/探测面 + settings 只读元数据
// 〔pools/schema——domain→base〕，节挂载即自装载〔修复 M28 P2 节宿主
// 实例无人装载的静默回归〕；2026-11 行拆分：PoolManager 收窄 llm 单
// 形态〔搜索引擎节拆往 ac-client-ui-search-pool〕；DOM/Props 面不变）
// ============================================================
import { onMounted, ref } from 'vue';
import PoolManager from './PoolManager.vue';
import { useSettings } from 'ac-client-ui-settings/client/useSettings.ts';
import { defaultRpc } from 'ac-client-ui-settings/client/rpcDefault.ts';
import { saveLlmPoolDomain } from './poolApi.ts';

const settings = useSettings();
/** 节内错误条（原共享 store error 的节内等价物） */
const error = ref('');

onMounted(() => { void settings.loadMeta(); });

/** 池编辑即时落盘（定向 config/set——api_key 侧信道语义在服务端）；
 *  失败提示到面板错误条 */
async function saveNow(): Promise<void> {
  try {
    await saveLlmPoolDomain(settings.pools.value.llmProviders as Record<string, unknown>, defaultRpc);
  } catch (e) {
    error.value = `模型管理保存失败: ${(e as { message?: string })?.message ?? String(e)}`;
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
    :pools="settings.pools.value.llmProviders"
    :on-saved="saveNow"
    @update:pools="onPoolsUpdate"
  />
</template>
