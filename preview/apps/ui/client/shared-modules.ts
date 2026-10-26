// ============================================================
// shared-modules.ts —— 跨模块共享深路径注册表（8.5c）
//
// 域行互相深引（chatStore/uiStore/themeStore/rosterAccess…56 说明符，
// 2026-10-19 扫描）——通道 bundle 外部化这些说明符后，宿主侧必须提供
// 同一模块实例（importmap 解析目标）。它们是被跨模块共享的状态面与
// 纯函数面 = 事实上的共享基座（ui-tree §3 单例契约的物理载体）。
//
// 物理形态：宿主 bundle 静态 import 源文件（与骨架件同源装载——同一
// vite 模块图，无二次拷贝）。键 = 完整说明符（含子路径与后缀）。
// 清单维护：preview/apps/ui/scripts/gen-domain-channels.mjs --check
// 对账漂移后同步本表（深引集合变化 = 共享面变化）。
// ============================================================
import * as agentsClient from 'ac-client-ui-agents/client';
import * as agentsIndex from 'ac-client-ui-agents/client/index.ts';
import * as agentsPoolModelCache from 'ac-client-ui-agents/client/poolModelCache.ts';
import * as agentsRosterAccess from 'ac-client-ui-agents/client/rosterAccess.ts';
import * as agentsRosterApi from 'ac-client-ui-agents/client/rosterApi.ts';
import * as convConversationView from 'ac-client-ui-conversation/client/ConversationView.vue';
import * as convTranscriptList from 'ac-client-ui-conversation/client/TranscriptList.vue';
import * as convChatStore from 'ac-client-ui-conversation/client/chatStore.ts';
import * as convIndex from 'ac-client-ui-conversation/client/index.ts';
import * as convComposePrefs from 'ac-client-ui-conversation/client/composePrefs.ts';
import * as convFeed from 'ac-client-ui-conversation/client/feed.ts';
import * as convFeedStore from 'ac-client-ui-conversation/client/feedStore.ts';
import * as convHistoryApi from 'ac-client-ui-conversation/client/historyApi.ts';
import * as convSwitchTrace from 'ac-client-ui-conversation/client/switchTrace.ts';
import * as convTypes from 'ac-client-ui-conversation/client/types.ts';
import * as convUseTurnDisplayItems from 'ac-client-ui-conversation/client/useTurnDisplayItems.ts';
import * as convUseUnreadBadges from 'ac-client-ui-conversation/client/useUnreadBadges.ts';
import * as convViewer from 'ac-client-ui-conversation/client/viewer.ts';
import * as jobsClient from 'ac-client-ui-jobs/client';
import * as layoutAuxSidebarViews from 'ac-client-ui-layout/client/auxSidebarViews.ts';
import * as layoutMainViews from 'ac-client-ui-layout/client/mainViews.ts';
import * as layoutUiStore from 'ac-client-ui-layout/client/uiStore.ts';
import * as llmPoolPoolEntryForm from 'ac-client-ui-llm-pool/client/PoolEntryForm.vue';
import * as llmPoolPoolApi from 'ac-client-ui-llm-pool/client/poolApi.ts';
import * as pluginRegistryExtToolsPane from 'ac-client-ui-plugin-registry/client/ExtToolsPane.vue';
import * as rendererScrollableViewport from 'ac-client-ui-renderer/client/ScrollableViewport.vue';
import * as rendererSlotOutlet from 'ac-client-ui-renderer/client/SlotOutlet.vue';
import * as rendererCodeFence from 'ac-client-ui-renderer/client/codeFence.ts';
import * as rendererHljsLanguages from 'ac-client-ui-renderer/client/hljs-languages.ts';
import * as rendererLogger from 'ac-client-ui-renderer/client/logger.ts';
import * as rendererMarkdownMath from 'ac-client-ui-renderer/client/markdownMath.ts';
import * as rendererUseMarkdown from 'ac-client-ui-renderer/client/useMarkdown.ts';
import * as searchPoolSearchEntryForm from 'ac-client-ui-search-pool/client/SearchEntryForm.vue';
import * as searchPoolSearchPoolApi from 'ac-client-ui-search-pool/client/searchPoolApi.ts';
import * as settingsApi from 'ac-client-ui-settings/client/api.ts';
import * as settingsConfirmDialog from 'ac-client-ui-settings/client/components/ConfirmDialog.vue';
import * as settingsSettingField from 'ac-client-ui-settings/client/components/SettingField.vue';
import * as settingsExtensionTabs from 'ac-client-ui-settings/client/extensionTabs.ts';
import * as settingsRpcDefault from 'ac-client-ui-settings/client/rpcDefault.ts';
import * as settingsSchema from 'ac-client-ui-settings/client/schema.ts';
import * as settingsSlotCatalog from 'ac-client-ui-settings/client/slotCatalog.ts';
import * as settingsTypes from 'ac-client-ui-settings/client/types.ts';
import * as settingsUseSettings from 'ac-client-ui-settings/client/useSettings.ts';
import * as singlesClient from 'ac-client-ui-singles/client';
import * as skillSkillsApi from 'ac-client-ui-skill/client/skillsApi.ts';
import * as subagentBoard from 'ac-client-ui-subagent/client/board.ts';
import * as systemSystemApi from 'ac-client-ui-system/client/systemApi.ts';
import * as themeThemeStore from 'ac-client-ui-theme/client/themeStore.ts';
import * as timerTimerApi from 'ac-client-ui-timer/client/timerApi.ts';
import * as timerTimerPane from 'ac-client-ui-timer/client/TimerPane.vue';
import * as toolToolIcon from 'ac-client-ui-tool/client/toolIcon.ts';
import * as toolToolLabel from 'ac-client-ui-tool/client/toolLabel.ts';
import * as toolToolResultViews from 'ac-client-ui-tool/client/toolResultViews.ts';
import * as workspaceClient from 'ac-client-ui-workspace/client';
import * as workspaceEntryPickerModal from 'ac-client-ui-workspace/client/EntryPickerModal.vue';
import * as workspaceFileApi from 'ac-client-ui-workspace/client/fileApi.ts';
import * as workspaceFilePreviewContent from 'ac-client-ui-workspace/client/filePreviewContent.ts';
import * as workspaceWorkspaceFile from 'ac-client-ui-workspace/client/workspaceFile.ts';
// @agentchat/protocol（类型 + isBackgroundRunSource 唯一运行时值——走主线
// 垫片与 vite alias 同源；settings 等 8.5b 四包外部化依赖它）
import * as agentchatProtocol from '@agentchat/protocol';

/** 深路径共享说明符 → 宿主模块实例（56 键——完整说明符 = importmap 键） */
export function sharedModules(): Record<string, unknown> {
  return {
    'ac-client-ui-agents/client': agentsClient,
    'ac-client-ui-agents/client/index.ts': agentsIndex,
    'ac-client-ui-agents/client/poolModelCache.ts': agentsPoolModelCache,
    'ac-client-ui-agents/client/rosterAccess.ts': agentsRosterAccess,
    'ac-client-ui-agents/client/rosterApi.ts': agentsRosterApi,
    'ac-client-ui-conversation/client': convIndex,
    'ac-client-ui-conversation/client/ConversationView.vue': convConversationView,
    'ac-client-ui-conversation/client/TranscriptList.vue': convTranscriptList,
    'ac-client-ui-conversation/client/chatStore.ts': convChatStore,
    'ac-client-ui-conversation/client/index.ts': convIndex,
    'ac-client-ui-conversation/client/composePrefs.ts': convComposePrefs,
    'ac-client-ui-conversation/client/feed.ts': convFeed,
    'ac-client-ui-conversation/client/feedStore.ts': convFeedStore,
    'ac-client-ui-conversation/client/historyApi.ts': convHistoryApi,
    'ac-client-ui-conversation/client/switchTrace.ts': convSwitchTrace,
    'ac-client-ui-conversation/client/types.ts': convTypes,
    'ac-client-ui-conversation/client/useTurnDisplayItems.ts': convUseTurnDisplayItems,
    'ac-client-ui-conversation/client/useUnreadBadges.ts': convUseUnreadBadges,
    'ac-client-ui-conversation/client/viewer.ts': convViewer,
    'ac-client-ui-jobs/client': jobsClient,
    'ac-client-ui-layout/client/auxSidebarViews.ts': layoutAuxSidebarViews,
    'ac-client-ui-layout/client/mainViews.ts': layoutMainViews,
    'ac-client-ui-layout/client/uiStore.ts': layoutUiStore,
    'ac-client-ui-llm-pool/client/PoolEntryForm.vue': llmPoolPoolEntryForm,
    'ac-client-ui-llm-pool/client/poolApi.ts': llmPoolPoolApi,
    'ac-client-ui-plugin-registry/client/ExtToolsPane.vue': pluginRegistryExtToolsPane,
    'ac-client-ui-renderer/client/ScrollableViewport.vue': rendererScrollableViewport,
    'ac-client-ui-renderer/client/SlotOutlet.vue': rendererSlotOutlet,
    'ac-client-ui-renderer/client/codeFence.ts': rendererCodeFence,
    'ac-client-ui-renderer/client/hljs-languages.ts': rendererHljsLanguages,
    'ac-client-ui-renderer/client/logger.ts': rendererLogger,
    'ac-client-ui-renderer/client/markdownMath.ts': rendererMarkdownMath,
    'ac-client-ui-renderer/client/useMarkdown.ts': rendererUseMarkdown,
    'ac-client-ui-search-pool/client/SearchEntryForm.vue': searchPoolSearchEntryForm,
    'ac-client-ui-search-pool/client/searchPoolApi.ts': searchPoolSearchPoolApi,
    'ac-client-ui-settings/client/api.ts': settingsApi,
    'ac-client-ui-settings/client/components/ConfirmDialog.vue': settingsConfirmDialog,
    'ac-client-ui-settings/client/components/SettingField.vue': settingsSettingField,
    'ac-client-ui-settings/client/extensionTabs.ts': settingsExtensionTabs,
    'ac-client-ui-settings/client/rpcDefault.ts': settingsRpcDefault,
    'ac-client-ui-settings/client/schema.ts': settingsSchema,
    'ac-client-ui-settings/client/slotCatalog.ts': settingsSlotCatalog,
    'ac-client-ui-settings/client/types.ts': settingsTypes,
    'ac-client-ui-settings/client/useSettings.ts': settingsUseSettings,
    'ac-client-ui-singles/client': singlesClient,
    'ac-client-ui-skill/client/skillsApi.ts': skillSkillsApi,
    'ac-client-ui-subagent/client/board.ts': subagentBoard,
    'ac-client-ui-system/client/systemApi.ts': systemSystemApi,
    'ac-client-ui-theme/client/themeStore.ts': themeThemeStore,
    'ac-client-ui-timer/client/timerApi.ts': timerTimerApi,
    'ac-client-ui-timer/client/TimerPane.vue': timerTimerPane,
    'ac-client-ui-tool/client/toolIcon.ts': toolToolIcon,
    'ac-client-ui-tool/client/toolLabel.ts': toolToolLabel,
    'ac-client-ui-tool/client/toolResultViews.ts': toolToolResultViews,
    'ac-client-ui-workspace/client': workspaceClient,
    'ac-client-ui-workspace/client/EntryPickerModal.vue': workspaceEntryPickerModal,
    'ac-client-ui-workspace/client/fileApi.ts': workspaceFileApi,
    'ac-client-ui-workspace/client/filePreviewContent.ts': workspaceFilePreviewContent,
    'ac-client-ui-workspace/client/workspaceFile.ts': workspaceWorkspaceFile,
    '@agentchat/protocol': agentchatProtocol,
  };
}
