// ============================================================
// ac-client-ui-workspace/client/useModeMenu.ts —— 自绘 Listbox
// 弹层状态机（预览 Modal 与 pane 双消费共用）
//
// 原生 select 弹层在部分平台不接 CSS 且受容器 overflow 裁剪——
// 预览双形态各自实现过一套逐字相同的弹层机制（Modal fp- / pane
// fpt- 仅类名与宽度分叉），并源于此。收敛公共机制：开合态、定位
// （触发器右缘对齐 + 视口边距钳制）、外点/ESC 关闭、滚动与尺寸
// 变化跟随、全局监听器挂摘（开着才有开销）。选项数据与选中写回
// 由消费方自理（pickMode 留在组件内——两形态语义不同：Modal 写
// 本地 ref、pane 回调写回 tab）。
// ============================================================
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

/**
 * @param menuClass 弹层类名（外点命中判定——弹层 Teleport 在 body 下，
 *   以类名识别「弹层内部点击不算外点」）
 * @param menuWidth 弹层宽度 px（右缘对齐定位与视口钳制的度量基准）
 */
export function useModeMenu(menuClass: string, menuWidth: number) {
  /** 弹层开合态 */
  const open = ref(false);
  /** 触发器元素（弹层锚点；template ref 直挂触发 button） */
  const triggerEl = ref<HTMLButtonElement | null>(null);
  /** 弹层定位样式（Teleport 目标绑定 :style） */
  const style = ref<{ left: string; top: string }>({ left: '0px', top: '0px' });

  function toggle() {
    open.value = !open.value;
    if (open.value) void nextTick(syncPos);
  }

  /** 弹层定位：右缘对齐触发器右缘（视口边距 ≥8px 不溢出）、顶部下方 4px */
  function syncPos() {
    const el = triggerEl.value;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - menuWidth, window.innerWidth - menuWidth - 8));
    const top = r.bottom + 4;
    style.value = { left: `${left}px`, top: `${top}px` };
  }

  /** 外点关闭（capture 保证先于其它外点行为；触发器与弹层之外 = 外点） */
  function onDocClick(e: MouseEvent) {
    if (!open.value) return;
    const t = e.target as Node;
    if (triggerEl.value?.contains(t)) return;
    if (t instanceof Element && t.closest(`.${menuClass}`)) return;
    open.value = false;
  }

  function onDocKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open.value) open.value = false;
  }
  function onReposition() { if (open.value) syncPos(); }

  function bind() {
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onDocKey, true);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
  }
  function unbind() {
    document.removeEventListener('mousedown', onDocClick, true);
    document.removeEventListener('keydown', onDocKey, true);
    window.removeEventListener('scroll', onReposition, true);
    window.removeEventListener('resize', onReposition);
  }

  /** 弹层开合挂/摘全局监听（开着才有开销）；组件卸载兜底摘除 */
  watch(open, (v) => {
    if (v) { syncPos(); bind(); }
    else unbind();
  });
  onBeforeUnmount(unbind);

  return { open, triggerEl, style, toggle };
}
