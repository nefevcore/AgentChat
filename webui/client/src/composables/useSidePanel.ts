// ============================================================
// 侧边面板 composable
// ============================================================

import { ref, readonly, type Component, markRaw } from 'vue';

export interface SidePanelState {
  isOpen: boolean;
  component: Component | null;
  props: Record<string, unknown>;
  title: string;
}

const state = ref<SidePanelState>({
  isOpen: false,
  component: null,
  props: {},
  title: '',
});

export function useSidePanel() {
  function open(component: Component, props: Record<string, unknown> = {}, title = '') {
    state.value = {
      isOpen: true,
      component: markRaw(component),
      props,
      title,
    };
  }

  function close() {
    state.value = {
      isOpen: false,
      component: null,
      props: {},
      title: '',
    };
  }

  return {
    state: readonly(state),
    open,
    close,
  };
}
