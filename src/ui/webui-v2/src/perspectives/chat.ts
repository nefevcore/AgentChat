// ============================================================
// perspectives/chat.ts —— 会话视角（布局插槽装配）
//
// 注册"会话"视角：活动栏图标 + 列表面板 + 主视图 + 全局弹窗。
// 群聊与单 Agent 会话共用同一套视图（统一管线）。
// ============================================================

import { registerPerspective } from '@/framework/perspectives';
// 渲染插槽装配：消息视图 + 工具结果视图
import '@/views/chat/messages';
import '@/views/chat/toolResults';
import ConversationList from '@/views/chat/ConversationList.vue';
import ConversationView from '@/views/chat/ConversationView.vue';
import FilePreviewModal from '@/views/chat/FilePreviewModal.vue';
import CreateGroupDialog from '@/views/chat/CreateGroupDialog.vue';
import AgentSettings from '@/views/chat/AgentSettings.vue';
import TokenUsage from '@/views/chat/TokenUsage.vue';
import VersionDialog from '@/views/chat/VersionDialog.vue';
import ChangelogDialog from '@/views/chat/ChangelogDialog.vue';
import GlobalSettings from '@/views/chat/GlobalSettings.vue';
import InteractionBar from '@/views/chat/InteractionBar.vue';

registerPerspective({
  id: 'chat',
  label: '会话',
  order: 10,
  icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  list: ConversationList,
  main: ConversationView,
  modals: [
    InteractionBar,
    FilePreviewModal,
    CreateGroupDialog,
    AgentSettings,
    TokenUsage,
    VersionDialog,
    ChangelogDialog,
    GlobalSettings,
  ],
});
