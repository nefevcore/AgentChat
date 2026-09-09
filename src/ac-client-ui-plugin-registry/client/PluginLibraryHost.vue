<script setup lang="ts">
// ============================================================
// client/PluginLibraryHost.vue —— 插件库节宿主（settings:section 贡献）
//（M28 P2：原 settings SettingsPanel 内联 PluginLibraryPane 迁入；
//  M29 P1-3a：数据面归域——本包 pluginApi 自取数〔目录/库/会话/权限/
//  事件链/事件描述/治理态〕，DOM 结构与 Props 面不变〔D23-A〕）
// ============================================================
import { onMounted, onUnmounted, ref } from 'vue';
import PluginLibraryPane from './PluginLibraryPane.vue';
import * as pluginApi from './pluginApi.ts';
import type { PluginCatalog, PluginLibrary, PluginPermissionsView, EventChainEntry, EventDescriptionEntry } from 'ac-client-ui-settings/client/types.ts';
import { getEventPolicy } from 'ac-client-ui-settings/client/api.ts';
import { useClientContext } from 'ac-client-runtime';

const rpc = useClientContext()?.rpc ?? null;

const catalogData = ref<Awaited<ReturnType<typeof pluginApi.getPluginCatalog>> | null>(null);
const catalogError = ref('');
const library = ref<PluginLibrary | null>(null);
const sessionPlugins = ref<Awaited<ReturnType<typeof pluginApi.getSessionPlugins>>['plugins']>([]);
const permissions = ref<PluginPermissionsView | null>(null);
const catalog = ref<PluginCatalog | null>(null);
const eventChains = ref<EventChainEntry[]>([]);
const eventDescriptions = ref<EventDescriptionEntry[]>([]);
const eventChainsByEvent = ref<Record<string, EventChainEntry['listeners']>>({});
const eventPolicy = ref<{ disabled: string[]; live: string[] }>({ disabled: [], live: [] });

/** 并发守卫：WS 事件风暴（install/reload 连发）时多个在途请求乱序返回，
 *  旧响应最后落地会把新目录回退——只接受最新一次调用发起的响应。 */
let seq = 0;
async function loadAll(): Promise<void> {
  if (!rpc) return;
  const cur = ++seq;
  const [catR, libR, sessionR, permR, eventsR, catalogR, descR, policyR] = await Promise.allSettled([
    pluginApi.getCatalog(rpc),
    pluginApi.getLibrary(rpc),
    pluginApi.getSessionPlugins(rpc),
    pluginApi.getPermissions(rpc),
    pluginApi.getEventListeners(rpc),
    pluginApi.getPluginCatalog(rpc),
    pluginApi.getEventDescriptions(rpc),
    getEventPolicy(rpc),
  ]);
  if (cur !== seq) return;
  if (catR.status === 'fulfilled') catalog.value = catR.value;
  if (libR.status === 'fulfilled') library.value = libR.value;
  if (sessionR.status === 'fulfilled') sessionPlugins.value = sessionR.value.plugins ?? [];
  if (permR.status === 'fulfilled') permissions.value = permR.value;
  if (eventsR.status === 'fulfilled') eventChains.value = eventsR.value.events ?? [];
  if (catalogR.status === 'fulfilled') {
    catalogData.value = catalogR.value;
    catalogError.value = '';
  } else {
    catalogData.value = null;
    catalogError.value = catalogR.reason instanceof Error ? catalogR.reason.message : String(catalogR.reason);
  }
  if (descR.status === 'fulfilled') {
    eventDescriptions.value = descR.value.descriptions ?? [];
    eventChainsByEvent.value = descR.value.chains ?? {};
  }
  if (policyR.status === 'fulfilled') eventPolicy.value = policyR.value;
}

const offWire = rpc?.onEvent((type: string) => {
  if (type === 'plugin/installed' || type === 'plugin/catalog-changed' || type === 'plugin/reloaded') void loadAll();
});
onMounted(() => { void loadAll(); });
onUnmounted(() => offWire?.());
</script>

<template>
  <PluginLibraryPane
    :catalog-builtin="catalogData?.builtin ?? []"
    :catalog-local="catalogData?.local ?? []"
    :catalog-pending="catalogData?.pending ?? []"
    :catalog-note="catalogData?.note"
    :catalog-error="catalogError || undefined"
    :root="library?.root"
    :session="sessionPlugins"
    :permissions="permissions"
    :rows="catalog?.rows ?? []"
    :extensions="catalog?.extensions ?? []"
    :tools="catalog?.tools ?? []"
    :safe-mode="catalog?.safeMode === true"
    :event-chains="eventChains"
    :event-descriptions="eventDescriptions"
    :event-chains-by-event="eventChainsByEvent"
    :event-policy="eventPolicy"
    @refresh="loadAll()"
  />
</template>
