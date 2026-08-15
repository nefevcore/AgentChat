// ============================================================
// plugins-shared.ts —— 插件 API 错误映射（boot 的 PluginManager 与
// host/server 的路由共用；boot 已依赖 server，不会形成反向依赖）
// ============================================================

/** 带 HTTP 状态码的插件 API 错误 */
export class PluginApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'PluginApiError';
    this.status = status;
  }
}

/** 把 PluginManager/registry 抛出的普通 Error 映射为 HTTP 错误（保守默认 500） */
export function toPluginApiError(err: unknown): PluginApiError {
  if (err instanceof PluginApiError) return err;
  const message = err instanceof Error ? err.message : String(err);

  const rules: Array<[RegExp, number]> = [
    // 404：目标/记录不存在
    [/未安装|未找到|不存在|未在 .* 中装载|暂无|暂存记录不存在/, 404],
    // 409：版本冲突 / 已存在
    [/同版本拒绝|已安装|已作为全局插件安装|重复发布/, 409],
    // 400：调用方输入问题
    [/非法|必须|缺少|未知权限|未授予的权限|manifest|路径逃逸|仅允许相对路径|文件过大|不一致/, 400],
  ];
  for (const [pattern, status] of rules) {
    if (pattern.test(message)) return new PluginApiError(status, message);
  }
  return new PluginApiError(500, message);
}

/** Express 路由统一错误出口 */
export function pluginErrorStatus(err: unknown): number {
  return toPluginApiError(err).status;
}
