// ============================================================
// stores/ui.ts —— 布局与面板状态门面（re-export）
//
// owning = ac-client-ui-sidebar/client/uiStore.ts（M27.2-2 随 sidebar
// 件出包）；同一 pinia id（'ui'）= 同一 store 实例——消费面组件
// （AppFrame/DialogView/ChatInput 等）零改动，随消费面收敛退役。
// ============================================================

export { useUiStore } from 'ac-client-ui-sidebar/client/uiStore.ts';