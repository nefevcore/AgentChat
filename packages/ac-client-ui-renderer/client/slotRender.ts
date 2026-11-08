// ============================================================
// ac-client-ui-renderer/client/slotRender.ts —— slot 条目 → VNode 的共享渲染面
//（M27 S0；M27.2-2 随 renderer 件自 webui/src/runtime/slotRender.ts 迁入）
//
// SlotOutlet 与 vueRenderer 共用：贡献组件经 ownerOf 取注册方 ctx
// 包 wrapComponent（D17：Vue 树与 fiber 树对齐），props/data 按
// D16-③ 透传（data = owner 上下文；条目 props 优先于 data 同名键）。
// 零包裹纪律（D23-A）：h 直接落在贡献组件上，不加任何包装节点。
// ============================================================
import { defineComponent, h, onErrorCaptured, onMounted, type Component, type VNode } from 'vue';
import { wrapComponent, type ClientContext } from 'ac-client-runtime';
import type { SlotEntry } from 'ac-client-slots';
import { DEFAULT_SLOT_ORDER } from 'ac-client-slots';

/** 出口崩溃面（dead cell——三态契约第三态）：席位曾有贡献且全部退位时
 *  由出口渲染的降级占位（DSH "the outlet owns the crash face" 对位物）。
 *  替代空白渲染——退位不再等于席位蒸发，页面永不因单条目崩溃整片白屏。
 *  错误可诊断（用户诉求）：崩溃原因上屏 + 控制台 error 各一次——空占位
 *  只说『崩了』，lastError 说『为什么』。零依赖（内联样式 + 令牌色）。 */
const DeadCellFace = defineComponent({
  name: 'AcSlotDeadCell',
  props: {
    seat: { type: String, required: true },
    /** 席位最近一次条目崩溃（slots.lastErrorOf——缺席 = 只报退位） */
    error: { type: null, default: undefined },
  },
  setup(props) {
    onMounted(() => {
      // 控制台诊断面：崩溃面出现 = 至少一次 error 已随退位上报；此处补
      // 席位语义锚（哪個席位、什么错误）——空占位不可诊断的收口
      console.error(`[slots] 席位「${props.seat}」崩溃面（全部贡献已退位）——最近错误：`, props.error);
    });
    const reload = () => {
      if (typeof location !== 'undefined') location.reload();
    };
    const message = () => props.error instanceof Error ? props.error.message : props.error !== undefined ? String(props.error) : '';
    return () => h('div', {
      'data-slot-error': props.seat,
      role: 'alert',
      style: {
        flex: '1', minHeight: '120px', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: '10px',
        padding: '24px', textAlign: 'center', minWidth: '0',
        color: 'var(--err, inherit)',
      },
    }, [
      h('p', { style: { margin: '0', fontSize: '15px', fontWeight: '600' } }, `席位「${props.seat}」内容已崩溃退出`),
      message() !== '' ? h('p', {
        style: {
          margin: '0', maxWidth: '70%', fontSize: '13px', lineHeight: '1.6',
          color: 'var(--text-2, inherit)', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontFamily: 'monospace',
        },
        title: message(),
      }, message()) : null,
      h('p', { style: { margin: '0', fontSize: '13px', color: 'var(--text-2, inherit)' } }, '该席位的全部贡献已退位（崩溃隔离生效）。其他区域不受影响；详情见控制台，刷新页面可恢复。'),
      h('button', {
        onClick: reload,
        style: {
          padding: '6px 16px', borderRadius: '6px', border: '1px solid var(--line, #ccc)',
          background: 'var(--bg-base, transparent)', cursor: 'pointer', fontSize: '13px',
        },
      }, '刷新页面'),
    ]);
  },
});

/** dead-cell 崩溃面 vnode（出口/宿主共用；error = lastErrorOf 诊断面） */
export function deadCellFace(seat: string, error?: unknown): VNode {
  return h(DeadCellFace, { key: `dead:${seat}`, seat, error });
}

/** entry 崩溃边界（S1.5-5）：捕获 → ctx.slots.reportEntryError（abdicate
 * 退位 + onEntryError 监督）→ 阻断向上传播（Outlet 存活，重选举下一候选）。
 * 零 DOM：只包 onErrorCaptured。 */
const EntryErrorBoundary = defineComponent({
  name: 'AcSlotEntryBoundary',
  props: { bond: { type: Object, required: true } },
  setup(props, { slots }) {
    onErrorCaptured((err) => {
      const bond = props.bond as { ctx: ClientContext; key: string; entry: SlotEntry };
      bond.ctx.slots.reportEntryError(bond.key, bond.entry, err);
      return false;
    });
    return () => slots.default?.();
  },
});

/** (entry → wrapped 组件) 缓存：避免每次渲染重建包裹层 */
const wrapCache = new WeakMap<object, Component>();

/** 单条贡献 → VNode（崩溃边界 + 隔离 ctx 包裹 + key 稳定 + props/data 透传）。
 *  component 覆盖参：选举渲染面（MainViewHost 等）用 meta.def.component
 *  渲染而复用条目的边界/退位身份时，以本参覆盖 entry.component。 */
export function entryVNode(ctx: ClientContext | undefined, key: string, entry: SlotEntry, data: unknown, componentOverride?: Component): VNode {
  let component = (componentOverride ?? entry.component) as Component;
  const owner = ctx?.slots.ownerOf(entry);
  if (owner) {
    let wrapped = wrapCache.get(entry);
    if (!wrapped) {
      wrapped = wrapComponent(component, owner as ClientContext);
      wrapCache.set(entry, wrapped);
    }
    component = wrapped;
  }
  const extra =
    typeof entry.props === 'function' ? (entry.props as (d: unknown) => Record<string, unknown>)(data) : entry.props;
  const vnode = h(component, { key: entry.id, data, ...(extra ?? {}) });
  if (!ctx) return vnode;
  return h(EntryErrorBoundary, { key: `b:${entry.id}`, bond: { ctx, key, entry } }, { default: () => [vnode] });
}

/** 一个席位的外部贡献（含解析后的 order；宿主模板内容由 Outlet 侧合并） */
export function orderedExternal(
  ctx: ClientContext | undefined,
  key: string,
  data: unknown,
): { order: number; node: VNode }[] {
  if (!ctx) return [];
  return ctx.slots.entries(key).map((e) => ({ order: e.order ?? DEFAULT_SLOT_ORDER, node: entryVNode(ctx, key, e, data) }));
}
