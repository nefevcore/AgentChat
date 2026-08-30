// ============================================================
// ac-plugin-core/src/contracts.ts —— 宿主契约版本与兼容判定
//
// src core/agent-config/contracts.ts 原样搬运（资产：粗 semver range
// 门禁，fail-closed）。破坏性升级可知化：宿主只升 major = 有破坏；
// 插件 manifest.contracts 声明兼容范围；装载前判定，不兼容拒绝
// import（代码不进进程——与权限门禁同一模式、同一位置）。
// ============================================================

/**
 * 当前宿主契约版本。major 位 = 插件兼容面（ctx.* 服务签名破坏、
 * manifest 契约收紧、权限词汇语义变更必须升 major）。
 */
export const HOST_CONTRACTS_VERSION = '1.0.0';

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const VERSION_PARSE_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(input: string): ParsedVersion {
  const m = VERSION_PARSE_RE.exec(input.trim());
  if (!m) throw new Error(`版本号非法: "${input}"（期望 major.minor.patch[-pre]）`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

const RANGE_RE = /^[\s*|<>=^~0-9.xX]+$/;

export function isValidContractsRange(range: string): boolean {
  const trimmed = range.trim();
  return trimmed !== '' && RANGE_RE.test(trimmed);
}

function bump(version: ParsedVersion, kind: 'major' | 'minor'): ParsedVersion {
  return kind === 'major'
    ? { major: version.major + 1, minor: 0, patch: 0, prerelease: null }
    : { major: version.major, minor: version.minor + 1, patch: 0, prerelease: null };
}

type Operator = '>=' | '<=' | '>' | '<' | '=' | '^' | '~';

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
      nums.push(0);
    } else {
      return null;
    }
  }
  while (nums.length < 3) nums.push(0);
  const version: ParsedVersion = { major: nums[0], minor: nums[1], patch: nums[2], prerelease: null };

  if (op === '=') {
    if (sawWildcard || parts.length === 1) return { op: '^', version };
    if (parts.length === 2) return { op: '~', version };
    return { op: '=', version };
  }
  return { op, version };
}

/**
 * 判定 range 是否兼容给定宿主版本（纯函数；fail closed）。
 * 未声明 = 存量插件默认兼容；非法 range = 不兼容。
 */
export function isContractsCompatible(range: string | undefined, host: string = HOST_CONTRACTS_VERSION): boolean {
  if (range === undefined) return true;
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return true;

  let hostVersion: ParsedVersion;
  try {
    hostVersion = parseVersion(host);
  } catch {
    return false;
  }

  for (const group of trimmed.split('||')) {
    const tokens = group.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    let groupOk = true;
    for (const token of tokens) {
      if (token === '*') continue;
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
