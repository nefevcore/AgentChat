<script setup lang="ts">
// ============================================================
// client/PluginLibraryHost.vue —— 插件库节宿主（settings:section 贡献）
//（M28 P2：原 settings SettingsPanel 内联 PluginLibraryPane 迁入——
// 数据经 settings 共享 store 跨包直连，DOM 结构不变〔D23-A〕）
// ============================================================
import PluginLibraryPane from './PluginLibraryPane.vue';
import { useSettings } from 'ac-client-ui-settings/client/useSettings.ts';

const settings = useSettings();
</script>

<template>
  <PluginLibraryPane
    :catalog-builtin="settings.pluginCatalogData.value?.builtin ?? []"
    :catalog-local="settings.pluginCatalogData.value?.local ?? []"
    :catalog-pending="settings.pluginCatalogData.value?.pending ?? []"
    :catalog-note="settings.pluginCatalogData.value?.note"
    :catalog-error="settings.pluginCatalogError.value || undefined"
    :root="settings.pluginLibrary.value?.root"
    :session="settings.sessionPlugins.value"
    :permissions="settings.pluginPermissions.value"
    :rows="settings.pluginCatalog.value?.rows ?? []"
    :extensions="settings.pluginCatalog.value?.extensions ?? []"
    :tools="settings.pluginCatalog.value?.tools ?? []"
    :safe-mode="settings.pluginCatalog.value?.safeMode === true"
    :event-chains="settings.eventChains.value"
    :event-descriptions="settings.eventDescriptions.value"
    :event-chains-by-event="settings.eventChainsByEvent.value"
    :event-policy="settings.eventPolicy.value"
    @refresh="settings.loadPluginCatalog()"
  />
</template>
