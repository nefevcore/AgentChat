// ============================================================
// webui/src/components/SlotOutletItem.ts —— 宿主模板内容的同轴标记（M27 D16-①）
//
// 宿主在 SlotOutlet 默认插槽里用它包裹自己的默认内容并声明 order——
// 与插件贡献用同一个 order 轴合并排序（「排前/排后」而非只能整体替换）。
// 未标记的默认插槽内容不参与 list 型排序竞争（single 型回落时原样渲染）。
// 本组件零 DOM：直接渲染自己的默认插槽。
// ============================================================
import { defineComponent } from 'vue';

export const SlotOutletItem = defineComponent({
  name: 'SlotOutletItem',
  props: {
    /** 同轴 order（缺省 100，与贡献条目同轴同缺省——slot-tree §5.11） */
    order: { type: Number, default: undefined },
  },
  setup(_, { slots }) {
    return () => slots.default?.();
  },
});
