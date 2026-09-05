// ============================================================
// ac-sandbox-core/src/bash-scan.ts —— bash 命令级沙箱（src shell 原样平移）
//
// 启发式静态检查（纵深防御非完备沙箱——src 明示，语义原样继承）：
//   · 拦截允许范围外访问——盘符绝对路径 / Unix 绝对路径 / cd 越界 /
//     独立 ../ 引用
//   · here-string / heredoc 载荷剥离（数据非命令）——避免载荷中的正则
//     字面量 / 路径样例常量被启发式误判
//   · 目标路径解析后落在 allowedRoots 内则放行（与 resolveSafePath
//     白名单同源判定：词法 + 身份回退——大小写/8.3/junction 别名词形
//     不误拦，见 paths.ts createRootsContainment）
// 差异：roots/cwd 显式参数化（src 内部读 workspaceRoot 全局）。
// ============================================================
import * as path from 'node:path';
import { createRootsContainment } from './paths.ts';

/**
 * 剥离 heredoc / here-string 载荷（数据非命令）后再做启发式扫描。
 *
 * here-string（`@'…'@` / `@"…"@`）与 bash heredoc（`<<'EOF' … EOF`）的
 * 内容是要写入文件的代码/文本载荷，不是 shell 路径语法——其中的正则
 * 字面量（如 JS `/const\s+…/`）、代码里的路径样例常量都会被盘符/Unix
 * 路径启发式误判。剥离后，载荷之后同一行的管道/命令保留继续受检。
 *
 * 匹配规则与 shell 语法对齐（匹配失败时保留原文继续扫描 → 只可能多拦
 * 不可能漏拦）：PS 开标记必须行尾（`@'⏎`）、闭标记必须行首（`⏎'@`），
 * 惰性匹配到首个闭标记即止；bash `<<X` 需后随空白/重定向/EOL（避开
 * 位移运算 `a << b`），闭定界符独占一行。
 */
export function stripHeredocPayloads(command: string): string {
  return (
    command
      // PowerShell here-string（单引号原文 / 双引号可展开）
      .replace(/@'\r?\n[\s\S]*?\r?\n'@/g, ' <heredoc-payload> ')
      .replace(/@"\r?\n[\s\S]*?\r?\n"@/g, ' <heredoc-payload> ')
      // bash heredoc：<<'X' / <<"X" / <<X …（X 行首独占一行收尾）
      .replace(
        /<<-?(['"]?)([A-Za-z_]\w*)\1(?=[\s>|\n]|$)[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\r?\n|$)/g,
        ' <heredoc-payload> ',
      )
  );
}

export interface BashScanOptions {
  /** 允许根（与沙箱白名单同源；缺省 = cwd） */
  roots?: string[];
  /** 相对路径解析基准（缺省 process.cwd()） */
  cwd?: string;
}

/** 已知 Unix 顶层目录（单段短路径不按 Windows 开关豁免——保持拦截） */
const UNIX_TOP_DIRS = new Set([
  'etc', 'tmp', 'var', 'usr', 'bin', 'sbin', 'opt', 'dev', 'proc', 'sys',
  'run', 'home', 'root', 'lib', 'lib64', 'mnt', 'srv', 'media', 'boot',
]);

/**
 * Windows 开关参数判定（2026-09-02 反馈：`dir /b`、`date /t`、
 * `taskkill /PID` 被误判为 Unix 绝对路径拦截）：单段、≤6 字符、
 * 字母/数字/?（可带 `:值`，如 /pid:123）、非已知 Unix 顶层目录的
 * `/token` 视为开关——多段路径（/etc/passwd）与已知 Unix 目录不豁免。
 */
function isWindowsSwitch(token: string): boolean {
  const m = /^\/([A-Za-z?][A-Za-z0-9]{0,5})(?::[A-Za-z0-9_.\-]+)?$/.exec(token);
  if (!m) return false;
  return !UNIX_TOP_DIRS.has(m[1]!.toLowerCase());
}

/**
 * bash 命令级沙箱（启发式静态检查）：返回违规说明或 null（允许）。
 * 目标路径解析后落在允许根内则放行。已知残留误报：引号内直接执行的
 * 代码（node -e "…正则…"）不在剥离范围（src 明示语义）。
 */
export function bashCommandViolation(command: string, options: BashScanOptions = {}): string | null {
  const base = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const roots =
    options.roots && options.roots.length > 0 ? options.roots.map((r) => path.resolve(r)) : [base];
  // 载荷先行剥离（数据非命令），其余照旧归一化反斜杠后分段扫描
  const norm = stripHeredocPayloads(command).replace(/\\/g, '/');
  /** 目标是否落在允许根内（与 resolveSafePath 同一判定：词法 + 身份回退） */
  const contains = createRootsContainment(roots);
  const isAllowed = (target: string): boolean => contains(path.resolve(base, target));

  // 按命令段拆分（; && || | 换行）
  const segments = norm
    .split(/[;&|]|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const seg of segments) {
    // 1. 盘符绝对路径（C:\ 或 C:/）。盘符前邻必须是行首或非「字母/数字/下划线」字符，
    //    排除 URL scheme（https:// … 字母串后的冒号+斜杠——曾把 https:// 里的
    //    s:// 误判成 S: 盘）与 $env: / %VAR% 变量展开（无 \ / 后缀）
    const drive = seg.match(/(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/);
    if (drive) {
      const m = seg.match(/(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s;|&"'`]*/);
      const p = m ? m[0] : drive[0];
      if (!isAllowed(p)) {
        return `命令包含允许范围外的绝对路径（${p}）访问，被沙箱拦截。仅这一个越界路径被拦——工作目录与 security.allowedPaths 白名单内的绝对/相对路径均可正常使用；确需访问该路径时请先将其加入白名单。`;
      }
      continue; // 盘符在白名单内 → 放行
    }
    // 2. Unix 风格绝对路径（独立路径参数，如 /etc /tmp）。
    //    Windows 开关参数豁免（isWindowsSwitch）：`dir /b` / `date /t` 等
    //    不是路径——跳过路径判定，cd/.. 规则照跑。
    const absTokens = seg.match(/(?:^|\s)\/[^\s;|&"'`]*/g) ?? [];
    const pathLike = absTokens.map((m) => m.trim()).filter((p) => !isWindowsSwitch(p));
    if (pathLike.length > 0) {
      for (const p of pathLike) {
        if (!isAllowed(p)) {
          return `命令包含允许范围外的 Unix 绝对路径（${p}）访问，被沙箱拦截。仅这一个越界路径被拦——工作目录与 security.allowedPaths 白名单内的绝对/相对路径均可正常使用；确需访问该路径时请先将其加入白名单。`;
        }
      }
      continue; // 段内 Unix 绝对路径全在白名单内 → 放行
    }
    // 3. cd 越界：cd .. / cd ../x / cd 绝对路径（目标解析后判断）
    const cd = seg.match(/\bcd\s+("?[^\s"]+"?)/);
    if (cd) {
      const target = cd[1].replace(/^["']|["']$/g, '');
      if (
        target === '..' ||
        target.startsWith('../') ||
        target.includes('..') ||
        target.startsWith('/') ||
        /^[A-Za-z]:/.test(target)
      ) {
        if (!isAllowed(target)) {
          return `命令中 cd 到 "${target}" 越出允许范围，被沙箱拦截。仅允许工作区及 security.allowedPaths 白名单内目录。`;
        }
      }
    }
    // 4. 独立 ../ 引用（排除 git diff a..b 这类 token 内 ..；解析后判断）
    const refs = seg.match(/(?:^|\s)(\.\.[\\/][^\s;|&"'`]*)/g);
    if (refs) {
      for (const ref of refs) {
        const p = ref.trim();
        if (!isAllowed(p)) {
          return `命令包含 ".." 相对路径引用（${p}），解析后越出允许范围，被沙箱拦截。仅这一个越界路径被拦——工作目录与 security.allowedPaths 白名单内的绝对/相对路径均可正常使用。`;
        }
      }
    }
  }
  return null;
}
