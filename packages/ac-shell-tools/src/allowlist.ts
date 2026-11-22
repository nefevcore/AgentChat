// ============================================================
// allowlist.ts —— 设置化低风险命令白名单（cr-1217 面1，ISSUE-20 面1）
//
// 背景：pwsh 的 risk 自评走 isLowRiskCommand（ac-sandbox-core 静态白名
// 单），解释器直调（node/python/sh…）一律 fail-closed 判 ask——仓库自有
// CLI（如 node cr/cr.mjs list）静态上不可与任意脚本区分，平台白名单不应
// 认识仓内命令。本模块给运营者一个声明面：settings['shell-tools']
// .extraLowRisk（命令**首部**数组），risk 自评按首部前缀放行。
//
// 匹配语义（cr-1218 修订，原全文精确匹配的缺陷）：白名单项是命令首部，
// 允许后随参数——只读子命令必须能带参数才有意义（`grep detail ISSUE-20`、
// `get 1217`、`list -n 10`），全文匹配会让它们全部失效。三条闸：
//   ① 首部词边界——白名单项之后必须是空白或结尾（`list` 不命中 `liste`）；
//   ② 危险字符闸——命令含 ; | & < > { } $ 反引号 或换行即不收（与
//      isLowRiskCommand 同字符集：低险首部不得掩护复合命令/替换/重定向）；
//   ③ 首部匹配——必须从命令开头起（`echo x && node cr/cr.mjs list` 不收）。
// 边界（与 isLowRiskCommand 同拍）：只免审批卡，沙箱轴照拦（allow ≠
// full-access）。纯函数住本文件（模块独立经显式契约），行内 risk 消费
// （agentId → settingsOf 读取在行内，同 limitsOf 形态）。
// ============================================================

/** 解析 settings['shell-tools'].extraLowRisk → 命令首部白名单（非法值过滤——fail-closed 不放行） */
export function extraLowRiskListOf(settings: unknown): string[] {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return [];
  const v = (settings as { extraLowRisk?: unknown }).extraLowRisk;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** 危险 shell 元字符（与 isLowRiskCommand 同字符集：复合命令/重定向/替换/变量一律不收） */
const UNSAFE_CHARS = /[\n\r;|&<>{}$`]/;

/**
 * 命令是否命中白名单（首部前缀 + 词边界 + 危险字符闸，见文件头注释）。
 * 例（白名单含 'node cr/cr.mjs grep'）：
 *   'node cr/cr.mjs grep detail ISSUE-20'  → true（带参数）
 *   'node cr/cr.mjs liste'                 → false（词边界）
 *   'node cr/cr.mjs grep x; rm -rf /'      → false（危险字符）
 *   'echo x && node cr/cr.mjs grep y'      → false（非首部）
 */
export function hitsAllowlist(command: string, allowlist: readonly string[]): boolean {
  if (UNSAFE_CHARS.test(command)) return false;
  const trimmed = command.trim();
  if (trimmed === '') return false;
  return allowlist.some((entry) => {
    if (trimmed === entry) return true;
    if (!trimmed.startsWith(entry)) return false;
    const next = trimmed[entry.length];
    return next === ' ' || next === '\t';
  });
}
