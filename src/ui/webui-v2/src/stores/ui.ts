// ============================================================
// stores/ui.ts —— 视图状态（视角/面板可见性/宽度）
//
// 与数据 store 分离：这里只放"界面上现在显示什么"，
// 不碰任何会话数据。数据层 store 不 import 本文件。
// ============================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useUiStore = defineStore('ui', () => {
  /** 当前激活视角 ID（对应 PerspectiveRegistry 中的注册项） */
  const activePerspective = ref('chat');
  /** 列表面板可见性 */
  const listVisible = ref(true);
  /** 列表面板宽度 */
  const listWidth = ref(260);
  /** 移动端侧边栏 */
  const sidebarVisible = ref(false);

  // 全局弹窗/面板可见性（可被任意视角注册的组件读写）
  const filePreviewVisible = ref(false);
  const filePreviewPath = ref('');
  const createGroupVisible = ref(false);
  const versionVisible = ref(false);
  const changelogVisible = ref(false);
  const globalSettingsVisible = ref(false);
  const agentSettingsVisible = ref(false);
  const settingsAgentId = ref('user');
  const tokenUsageVisible = ref(false);
  const workspaceTreeVisible = ref(false);

  function openPreview(path: string): void {
    filePreviewPath.value = path;
    filePreviewVisible.value = true;
  }
  function closePreview(): void {
    filePreviewVisible.value = false;
    filePreviewPath.value = '';
  }

  function toggleList(): void { listVisible.value = !listVisible.value; }
  function toggleSidebar(): void { sidebarVisible.value = !sidebarVisible.value; }
  function closeSidebar(): void { sidebarVisible.value = false; }

  return {
    activePerspective, listVisible, listWidth, sidebarVisible,
    filePreviewVisible, filePreviewPath, createGroupVisible,
    versionVisible, changelogVisible, globalSettingsVisible,
    agentSettingsVisible, settingsAgentId, tokenUsageVisible,
    workspaceTreeVisible,
    openPreview, closePreview, toggleList, toggleSidebar, closeSidebar,
  };
});
