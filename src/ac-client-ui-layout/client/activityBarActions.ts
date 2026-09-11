// ============================================================
// client/activityBarActions.ts —— 活动栏插件动作位解析（2026-11 自 ac-client-ui-sidebar 行归并壳件）
// 解析面（M27.2-2 随 sidebar 件迁入）
//
// activity-bar:plugin-actions 席位（★sidebar-action 别名，D13——2026-11 席位键随区域席语义定整改名；第三方 manifest 词汇 = 旧轨 sidebar-action，经 slotCatalog 归一不变）entries →
// def 视图（meta.def 原样携带；注册面 = webui bridge
// registerActivityBarAction / ctx.slots.register——本模块只读解析）。
// ctx 参数化 composable（包内无全局 runtime 单例——版本计数经
// ctx.slots.version(key)，SlotOutlet 同款响应式轴）。
// ============================================================
import { computed, type ComputedRef } from 'vue';
import type { ClientContext } from 'ac-client-runtime';

/** 活动栏动作 def（旧轨词汇形状——label/icon/onClick/order） */
export interface ActivityBarActionDef {
  id: string;
  label: string;
  icon: string;
  order?: number;
  onClick: () => void;
}

/** 席位键（与 webui bridge 注册面同词汇） */
export const SLOT_ACTIVITY_BAR_ACTIONS = 'activity-bar:plugin-actions';

/**
 * 排序后的只读访问器（order 升序稳定——与旧轨 bridge 排序面
 * 同语义；runtime 缺席 → 空清单）。
 */
export function useActivityBarActions(ctx: ClientContext | undefined): ComputedRef<Array<ActivityBarActionDef & { order: number }>> {
  return computed(() => {
    if (!ctx) return [];
    void ctx.slots.version(SLOT_ACTIVITY_BAR_ACTIONS); // 依赖锚（key 级细粒度失效轴）
    return (ctx.slots.entries(SLOT_ACTIVITY_BAR_ACTIONS) ?? [])
      .map((e) => ({
        ...(e.meta?.def as ActivityBarActionDef),
        order: e.order ?? (e.meta?.def as { order?: number })?.order ?? 100,
      }))
      .filter((d) => typeof d.id === 'string')
      .sort((a, b) => a.order - b.order);
  });
}
