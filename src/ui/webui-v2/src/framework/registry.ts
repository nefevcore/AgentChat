// ============================================================
// framework/registry.ts —— 通用插槽注册表
//
// 设计目标：新增功能 = 往插槽里"注册"一个条目，零改动框架本体。
// 三种插槽：
//   - Perspective（布局插槽）：活动栏图标 + 列表面板 + 主视图 + 弹窗集合
//   - MessageView（消息渲染插槽）：按消息角色/类型分发渲染组件
//   - ToolResultView（工具结果插槽）：按工具名分发渲染组件
// ============================================================

export interface RegistryEntry {
  /** 唯一 ID */
  id: string;
  /** 注册顺序（小在前） */
  order?: number;
}

/**
 * 通用注册表：有序、按 id 去重、支持覆盖（后注册同名覆盖）。
 */
export class SlotRegistry<T extends RegistryEntry> {
  private items = new Map<string, T>();

  register(entry: T): void {
    this.items.set(entry.id, entry);
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  /** 按 order 升序返回全部条目 */
  all(): T[] {
    return [...this.items.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /** 移除（扩展插件卸载时用） */
  unregister(id: string): void {
    this.items.delete(id);
  }

  clear(): void {
    this.items.clear();
  }
}
