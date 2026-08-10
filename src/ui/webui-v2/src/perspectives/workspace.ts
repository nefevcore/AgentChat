// ============================================================
// perspectives/workspace.ts —— 工作区视角（布局插槽装配）
// ============================================================

import { registerPerspective } from '@/framework/perspectives';
import WorkspaceTree from '@/views/workspace/WorkspaceTree.vue';
import WorkspaceMain from '@/views/workspace/WorkspaceMain.vue';

registerPerspective({
  id: 'workspace',
  label: '工作区',
  order: 20,
  icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  list: WorkspaceTree,
  main: WorkspaceMain,
});
