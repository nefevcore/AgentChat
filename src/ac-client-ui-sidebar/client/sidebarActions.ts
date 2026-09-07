// ============================================================
// ac-client-ui-sidebar/client/sidebarActions.ts —— 侧边栏插件动作位
// 解析面（M27.2-2 随 sidebar 件迁入）
//
// sidebar:plugin-actions 席位（★sidebar-action 别名，D13）entries →
// def 视图（meta.def 原样携带；注册面 = webui bridge
// registerSidebarAction / ctx.slots.register——本模块只读解析）。
// ctx 参数化 composable（包内无全局 runtime 单例——版本计数经
// ctx.slots.version(key)，SlotOutlet 同款响应式轴）。
// ============================================================
import { computed, type ComputedRef } from 'vue';
import type { ClientContext } from 'ac-client-runtime';

/** 侧边栏动作 def（旧轨词汇——label/icon/onClick/order） */
export interface SidebarActionDef {
  id: string;
  label: string;
  icon: string;
  order?: number;
  onClick: () => void;
}

/** 席位键（与 webui core/extensions/slots.ts 注册面同词汇） */
export const SLOT_SIDEBAR_ACTIONS = 'sidebar:plugin-actions';

/**
 * 排序后的只读访问器（order 升序稳定——与旧轨 sortedSidebarActions
 * 同语义；runtime 缺席 → 空清单）。
 */
export function useSidebarActions(ctx: ClientContext | undefined): ComputedRef<Array<SidebarActionDef & { order: number }>> {
  return computed(() => {
    if (!ctx) return [];
    void ctx.slots.version(SLOT_SIDEBAR_ACTIONS); // 依赖锚（key 级细粒度失效轴）
    return (ctx.slots.entries(SLOT_SIDEBAR_ACTIONS) ?? [])
      .map((e) => ({
        ...(e.meta?.def as SidebarActionDef),
        order: e.order ?? (e.meta?.def as { order?: number })?.order ?? 100,
      }))
      .filter((d) => typeof d.id === 'string')
      .sort((a, b) => a.order - b.order);
  });
}
