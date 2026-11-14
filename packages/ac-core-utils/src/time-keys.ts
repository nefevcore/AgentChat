// ============================================================
// time-keys.ts —— 时间词法单源：UTC 日/月键派生（cr-1052）+ 缺省时区
// 基线（cr-1053）
//
// 全仓时间规约：存储与键派生一律 UTC（ledger 时间戳 = UTC ISO），
// 本地化只发生在展示层（webui-kit formatRelativeTime / hostLog /
// ac-datetime 日期行——各自注释已声明本地时区语义）。从时间戳派生
// YYYY-MM-DD / YYYYMM 键的出口收口于此：此前 ac-usage 聚合键（本地
// getter）与流水文件名（UTC 切片）各写一份、relay 房间日键本地且不
// 补零、两份 download-gate 月键一本地一 UTC——手写 getter 是口径
// 漂移的根因。无效输入抛 RangeError（toISOString 语义），调用方按
// 需前置校验。
//
// 缺省时区（cr-1053）：墙上时钟语义面（定时触发/日期注入行/本地 ISO）
// 的统一基线 DEFAULT_TZ 与降级链 resolveTimezone——timer-core 函数缺省、
// timers-row 行基线、ac-datetime 注入行同源引用；此前三层各写一份
// （进程本地 / Asia/Shanghai 字面量 / 无缺省），部署环境一换即漂移。
// ============================================================

/** 全仓缺省时区（墙上时钟语义的统一基线；存储与键派生恒 UTC 不涉此） */
export const DEFAULT_TZ = 'Asia/Shanghai';

/** 时区解析：空/非法 → DEFAULT_TZ（墙上时钟语义的统一降级链终点） */
export function resolveTimezone(tz: string | undefined): string {
  const t = tz?.trim();
  if (!t) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: t });
    return t;
  } catch {
    return DEFAULT_TZ;
  }
}

/** UTC 日键（YYYY-MM-DD；输入 = 毫秒时间戳 / Date / ISO 串，缺省当下） */
export function utcDayKey(input: number | Date | string = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  return d.toISOString().slice(0, 10);
}

/** UTC 月键（YYYYMM；配额月片等月粒度文件名，缺省当下） */
export function utcMonthKey(input: number | Date | string = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  return d.toISOString().slice(0, 7).replace('-', '');
}
