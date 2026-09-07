<script lang="ts">
// ============================================================
// webui/src/components/SlotOutlet.vue —— 席位渲染组件（M27 S0/S1，D16 + D23-A）
//
// 一切 seat 由占用者在其组件内经 SlotOutlet(name) 渲染。语义（D16）：
//   ① 内外同轴 order：宿主模板内容（SlotOutletItem.order）与插件
//      贡献用同一 order 轴合并排序——宿主默认内容可被「排前/排后」；
//      同 order 时宿主内容居前（锚定语义；sort 稳定 + concat 顺序）。
//   ② single 未填充回落 Vue 默认插槽（宿主默认渲染免写 fallback 分支；
//      默认插槽原样渲染、不参与排序竞争——S1.5 后 external 走 cell 选举，
//      本回落保留为「无任何贡献时」的最终回落）。
//   ③ data props 透传 owner 上下文（条目 props 优先于同名 data 键）。
//
// 零包裹纪律（D23-A）：渲染返回扁平 children 数组（多根组件），
// 不引入任何包裹 DOM——scoped CSS / 后代选择器 / flex 上下文不受影响。
//
// 响应式：内部经 registry 版本计数（key 级细粒度，D14）+ 'slots/changed'
// 事件订阅建立——与现三注册表 xxxVersion 同款机制。
// ============================================================
import { computed, defineComponent, h, inject, onBeforeUnmount, ref, watch, type VNode } from 'vue';
import { CLIENT_CONTEXT_KEY, type ClientContext } from 'ac-client-runtime';
import type { SlotEntry } from 'ac-client-slots';
import { DEFAULT_SLOT_ORDER } from 'ac-client-slots';
import { SlotOutletItem } from './SlotOutletItem';
import { orderedExternal, entryVNode } from '../runtime/slotRender';

export default defineComponent({
  name: 'SlotOutlet',
  props: {
    /** 席位 key（prop 名避用 Vue 保留字 key） */
    name: { type: String, required: true },
    /** owner 上下文透传（D16-③） */
    data: { type: null, default: undefined },
  },
  setup(props, { slots }) {
    const ctx = inject(CLIENT_CONTEXT_KEY, undefined);

    // ── 版本计数（key 级细粒度失效轴，D14）──
    const version = ref(ctx ? ctx.slots.version(props.name) : 0);
    const bump = (key: string) => {
      if (key === props.name) version.value++;
    };
    const off = ctx?.on('slots/changed', bump);
    onBeforeUnmount(() => off?.());
    watch(
      () => props.name,
      (name) => {
        version.value = ctx ? ctx.slots.version(name) : 0;
      },
    );

    /** 外部贡献（响应式：版本计数读取建立依赖） */
    const external = computed<readonly SlotEntry[]>(() => {
      void version.value; // 依赖锚
      return ctx ? ctx.slots.entries(props.name) : [];
    });

    /** 席位形态（未声明 → 按 list 处理；DEV 期提示） */
    const kind = computed(() => {
      const decl = ctx?.slots.declOf(props.name);
      if (!decl && import.meta.env.DEV) {
        console.warn(`[SlotOutlet] 席位 "${props.name}" 未在声明账本中 declare——外部贡献恒为空（M27 D1 fail-closed）`);
      }
      return decl?.kind ?? 'list';
    });

    /** 宿主模板内容（<SlotOutletItem order> 标记节点；未标记内容不参与 list 竞争） */
    const internal = computed<{ order: number; node: VNode }[]>(() => {
      void version.value; // 宿主重建（如 HMR/条件分支变化）也走同轴合并
      const out: { order: number; node: VNode }[] = [];
      for (const node of slots.default?.() ?? []) {
        if (node.type === SlotOutletItem) {
          out.push({
            order: (node.props as { order?: number } | undefined)?.order ?? DEFAULT_SLOT_ORDER,
            node,
          });
        }
      }
      return out;
    });

    const children = computed<VNode[]>(() => {
      const ext = external.value;
      if (kind.value === 'single') {
        // single（S1.5 cell 选举）：有贡献 → 选举赢家；无贡献 → 默认插槽原样回落（D16-②）
        if (ext.length > 0) {
          const winner = ctx ? ctx.slots.single(props.name) : undefined;
          return winner ? [entryVNode(ctx, props.name, winner, props.data)] : [];
        }
        return slots.default?.() ?? [];
      }
      // list / chain：内外同轴 order 合并（chain 逐条消费序由注册表 priority 轴给出）
      const merged = [
        ...internal.value,
        ...orderedExternal(ctx, props.name, props.data),
      ].sort((a, b) => a.order - b.order);
      return merged.map((m) => m.node);
    });

    // 多根平铺返回——零包裹（D23-A）
    return () => children.value;
  },
});
</script>
