// ============================================================
// @agentchat/agent-config/src/contracts.ts —— 宿主契约版本与兼容判定
//
// 破坏性升级的"可知化"机制：
//   · 宿主侧：HOST_CONTRACTS_VERSION 随 @agentchat/contracts 的兼容面演进
//     （只升 major = 有破坏；minor/patch = 兼容新增）。
//   · 插件侧：manifest.contracts 声明自己兼容的契约范围（如 "^1"）。
//   · 门禁：装载前 isContractsCompatible() 判定，不兼容 → 拒绝 import，
//     代码不进进程（与权限门禁同一模式、同一位置）。
//
// 语义约定（粗 semver range，够门禁用，不追求完整 npm 语义）：
//   · "*" 或缺省        —— 任意宿主（存量插件默认兼容，不因缺声明被拒）
//   · "^1" / "^1.2"     —— >= 声明下界 且 < 下一个 major
//   · "~1.2"            —— >= 声明下界 且 < 下一个 minor
//   · ">=1" / "<2" / ">1.0.0" / "<=2" / "=1.0.0" —— 比较符
//   · "1.2.3"           —— 精确匹配
//   · 空格分隔           —— AND（">=1 <2"）
//   · "||"              —— OR（"^1 || ^2"）
//   · 非法 range        —— 判定不兼容（fail closed；manifest 校验期也会拦）
//
// 铁律：本文件仅类型与纯函数，不 import 运行时服务（与 manifest.ts 同约束）。
// ============================================================

/**
 * 当前宿主契约版本。
 *
 * major 位 = 插件兼容面：任何让既有插件 manifest.contracts 不再满足的变更
 * （ctx.* 服务签名破坏、manifest 契约收紧、权限词汇语义变更）必须升 major。
 * minor/patch 只允许兼容性新增。
 */
export const HOST_CONTRACTS_VERSION = '1.0.0';

/** 解析后的语义化版本（粗粒度：预发布段仅作为"低于同版本正式版"参与比较） */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标记（如 "beta.1"）；null = 正式版 */
  prerelease: string | null;
}

const VERSION_PARSE_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** 解析 `major.minor.patch[-pre]`；非法输入抛错（内部使用，外层先校验） */
export function parseVersion(input: string): ParsedVersion {
  const m = VERSION_PARSE_RE.exec(input.trim());
  if (!m) throw new Error(`版本号非法: "${input}"（期望 major.minor.patch[-pre]）`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/** 三元组比较：a < b → -1，a > b → 1，相等 → 0（预发布 < 同版本正式版） */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  // 正式版 > 预发布版；两个预发布按字典序（粗粒度）
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/** range 的浅层合法字符集（manifest 校验用；语义级校验由 isContractsCompatible fail-closed 兜底） */
const RANGE_RE = /^[\s*|<>=^~0-9.xX]+$/;

/** range 字符集是否合法（manifest 校验用；非空且仅含 range 合法字符） */
export function isValidContractsRange(range: string): boolean {
  const trimmed = range.trim();
  return trimmed !== '' && RANGE_RE.test(trimmed);
}

/** 下一个 major/minor 版本（^/~ 上界计算用） */
function bump(version: ParsedVersion, kind: 'major' | 'minor'): ParsedVersion {
  return kind === 'major'
    ? { major: version.major + 1, minor: 0, patch: 0, prerelease: null }
    : { major: version.major, minor: version.minor + 1, patch: 0, prerelease: null };
}

type Operator = '>=' | '<=' | '>' | '<' | '=' | '^' | '~';

/** 单个比较器对 host 的判定 */
function satisfiesComparator(op: Operator, raw: ParsedVersion, host: ParsedVersion): boolean {
  const cmp = compareVersions(host, raw);
  switch (op) {
    case '=': return cmp === 0;
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    case '^': return cmp >= 0 && compareVersions(host, bump(raw, 'major')) < 0;
    case '~': return cmp >= 0 && compareVersions(host, bump(raw, 'minor')) < 0;
  }
}

/**
 * 解析单个 comparator。
 * 支持形态："1.2.3"（精确）/ "1" / "1.2"（≡ 对应通配）/ "1.x" / "1.X" / "1.*"
 * （通配 ≡ ^/~ 语义：`1.x` = >=1.0.0 <2.0.0，`1.2.x` = >=1.2.0 <1.3.0）。
 * 通配位之后不允许再出现数字位（"1.x.3" 非法）。
 */
function parseComparator(token: string): { op: Operator; version: ParsedVersion } | null {
  let rest = token.trim();
  let op: Operator = '=';
  for (const candidate of ['>=', '<=', '>', '<'] as const) {
    if (rest.startsWith(candidate)) { op = candidate; rest = rest.slice(candidate.length).trim(); break; }
  }
  if (rest.startsWith('^') || rest.startsWith('~')) {
    op = rest[0] as Operator;
    rest = rest.slice(1).trim();
  } else if (rest.startsWith('=')) {
    rest = rest.slice(1).trim();
  }

  // 整体通配 / 空：仅"无显式操作符"时恒真（>= 0.0.0）；
  // 悬空操作符（如 "<" / "^" 后为空）是畸形 range → fail closed
  if (rest === '' || rest === '*' || rest === 'x' || rest === 'X') {
    if (op !== '=') return null;
    return { op: '>=', version: { major: 0, minor: 0, patch: 0, prerelease: null } };
  }

  const parts = rest.split('.');
  if (parts.length > 3) return null;
  const nums: number[] = [];
  let sawWildcard = false;
  for (const part of parts) {
    const isWildcard = part === '*' || part === 'x' || part === 'X';
    if (isWildcard) sawWildcard = true;
    if (/^\d+$/.test(part) && !sawWildcard) {
      nums.push(Number(part));
    } else if (isWildcard) {
      // 通配位按 0 补齐；带显式操作符（>=1.x 等）也按 >=1.0.0 处理
      nums.push(0);
    } else {
      return null; // 数字位出现在通配位之后，或非数字非通配字符
    }
  }
  while (nums.length < 3) nums.push(0);
  const version: ParsedVersion = { major: nums[0], minor: nums[1], patch: nums[2], prerelease: null };

  // 无显式操作符时的通配/短形态语义：通配到哪一位就升哪一位的上界
  if (op === '=') {
    if (sawWildcard || parts.length === 1) return { op: '^', version };      // "1" / "1.x" → ^1
    if (parts.length === 2) return { op: '~', version };                     // "1.2" → ~1.2
    return { op: '=', version };                                             // "1.2.3" 精确
  }
  return { op, version };
}

/**
 * 判定 range 是否兼容给定宿主版本（纯函数；fail closed）。
 *
 * @param range 插件声明的兼容范围（manifest.contracts）
 * @param host  宿主契约版本（缺省 HOST_CONTRACTS_VERSION）
 * @returns 兼容 = true；不兼容或 range 非法 = false
 */
export function isContractsCompatible(range: string | undefined, host: string = HOST_CONTRACTS_VERSION): boolean {
  if (range === undefined) return true; // 未声明 = 存量插件，默认兼容（弃用窗口内不惩罚）
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return true;

  let hostVersion: ParsedVersion;
  try {
    hostVersion = parseVersion(host);
  } catch {
    return false;
  }

  // "||" 分组 = OR；组内空格分隔 = AND
  for (const group of trimmed.split('||')) {
    const tokens = group.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    let groupOk = true;
    for (const token of tokens) {
      if (token === '*') continue; // AND 内的 * 恒真
      const comparator = parseComparator(token);
      if (!comparator || !satisfiesComparator(comparator.op, comparator.version, hostVersion)) {
        groupOk = false;
        break;
      }
    }
    if (groupOk) return true;
  }
  return false;
}
