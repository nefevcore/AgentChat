// ============================================================
// ac-client-ui-conversation/client/draftParking.ts —— 输入草稿暂存
//
// 会话级输入草稿位（模块级单例——生命周期独立于 ChatInput 组件实例）：
// ChatInput 随视角切换（talk ↔ single ↔ group 经 PerspectiveHost 的
// <component :is> 换 async wrapper）重挂载时，实例内的草稿会丢——
// 暂存位必须在组件外。键 = dialog 键（single:<id> / pair:<a>|<b> /
// group:<gid>——与 feed.activeDialogId 同源三形态统一）。
//
// 双层：内存 Map（读路径零反序列化）+ localStorage 留存（刷新/重启后
// 草稿仍在——未发送的输入不再因刷新丢失；写入只发生在变更点）。
// 上限兜底防长会话漂移（LRU 式淘汰：超出即删最旧——两层同步淘汰，
// 留存层不无限增长）。
// ============================================================
import { ref } from 'vue';

const MAX_PARKED = 100;
const STORE_KEY = 'agentchat.drafts';

/** 草稿位版本（park 即 bump——幻影 title 等派生面的响应式依赖锚） */
export const draftsVersion = ref(0);

/** 结构化 localStorage 面（jsdom/node 环境缺省 undefined——存取全兜底） */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const store: StorageLike | undefined = (globalThis as { localStorage?: StorageLike }).localStorage;

const parked = new Map<string, string>();

/** 留存层整份写回（淘汰后存活集即终值——全量覆写最简且正确） */
function persist(): void {
  try {
    store?.setItem(STORE_KEY, JSON.stringify([...parked]));
  } catch { /* 配额满/不可用：内存层仍活，仅丢失留存 */ }
}

/** 暂存草稿（空文本 = 清位——发送后/清空后调用同接口） */
export function parkDraft(key: string, text: string): void {
  draftsVersion.value++;
  if (!text) {
    if (parked.delete(key)) persist();
    return;
  }
  parked.delete(key); // 重插尾部 = LRU 新鲜度
  parked.set(key, text);
  if (parked.size > MAX_PARKED) {
    const oldest = parked.keys().next().value;
    if (oldest !== undefined) parked.delete(oldest);
  }
  persist();
}

/** 取草稿（无 = 空串；不消费——切回同会话多次取同值） */
export function takeDraft(key: string): string {
  return parked.get(key) ?? '';
}

/** 模块装载时从留存层恢复（一次性；损坏整份丢弃——脏数据不挡启动） */
export function restoreDrafts(): void {
  if (parked.size > 0) return; // 已恢复过（或已有暂存）不重放
  try {
    const raw = store?.getItem(STORE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    for (const e of arr.slice(0, MAX_PARKED)) {
      if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string' && e[1] !== '') {
        parked.set(e[0], e[1]);
      }
    }
  } catch { /* 损坏：无恢复 */ }
}

/** 测试面：清空内存层（不触留存——测试隔离用） */
export function __clearParkedForTest(): void {
  parked.clear();
}
