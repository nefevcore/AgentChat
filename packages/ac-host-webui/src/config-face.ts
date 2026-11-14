// ============================================================
// config-face.ts —— 全局配置面词汇（cr-564；契约抄主线 ac-web-api 的
// config 段：白名单键 + 掩码 sanitize + 池凭据侧信道）
//
// 三件事，两条落盘单源：
//   ① 可写键白名单 + 掩码 sanitize（点路径首段命中即放行；等于掩码的
//      字段绝不回写盘）；
//   ② 池条目 api_key 侧信道：真实 key 写 credentials/（config.json 永不
//      落 key）——掩码 = 不动 / '' = 删（locked 密文保留）/ 新值 = 存；
//      凭据条目名由 credentialKey 单源铸造（__GLOBAL___POOL:<NAME>_API_KEY
//      ——与壳侧读取面同源词汇）；
//   ③ 读面回填池掩码（'' = 未设置）——前端据此显示「已设置」。
//
// 配置本体落盘归 owning service（宿主 config 行 = ctx.config——本模块只
// 拿窄接口 ConfigFace）；凭据落盘归 ac-credentials-core。
// ============================================================
import {
  credentialKey,
  credentialState,
  deriveKey,
  machineMaterial,
  readCredential,
  removeCredential,
  writeCredential,
  GLOBAL_AGENT_ID,
  type CredentialState,
} from 'ac-credentials-core';

/** 全局配置可写键白名单（主线 settings 面板词汇）：点路径首段命中即放行。
 *  其余键（app 内部键）由各域服务自行拥有，设置面板不可触。 */
export const CONFIG_KEY_PREFIXES = new Set(['llm', 'llmProviders', 'searchProviders', 'timer', 'tool', 'ui', 'session', 'settings']);

/** 掩码值（与主线 API_KEY_MASK 同款：回传即「已设置」，回写则不动） */
export const API_KEY_MASK = '••••••••';

/**
 * 池域 → 凭据 provider 前缀。credentialKey 全程大写铸造：
 * 'POOL:' + deepseek → __GLOBAL___POOL:DEEPSEEK_API_KEY（cutover 换轨后的
 * 盘上既有词汇，旧主线 ctx.credentials.setGlobal('pool:deepseek') 同形）。
 */
export const POOL_CRED_PREFIX: Record<string, string> = {
  llmProviders: 'POOL:',
  searchProviders: 'SEARCHPOOL:',
};

/** 池域 → 凭据 provider 名（'llm' 域 = pool: 前缀，主线 llm/pool-credential 方言） */
export function poolProviderKey(domain: 'llm' | 'search', name: string): string {
  return (domain === 'search' ? POOL_CRED_PREFIX.searchProviders : POOL_CRED_PREFIX.llmProviders) + name;
}

/** locked 密文删除被拒的回传文案（cr-310 守卫——前端 toast） */
export function lockedCredentialWarning(name: string): string {
  return '连接 "' + name + '" 存有本机无法解密的密钥，已保留（换回原机名可恢复，或填入新 Key 覆盖）';
}

/** 配置本体写口窄接口（ctx.config 的结构子集——宿主 config 行提供） */
export interface ConfigFace {
  all(): Record<string, unknown>;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

/** 池凭据写读面（config.json 之外的侧信道） */
export interface PoolCredentialFace {
  get(provider: string): string;
  state(provider: string): CredentialState;
  set(provider: string, value: string): void;
}

/**
 * 池凭据面实现：credentialKey 单源 + 机器绑定密钥（PBKDF2 600k——首次
 * 使用才派生，进程内一次；缓存归本实例）。
 */
export function createPoolCredentials(dataRoot: string): PoolCredentialFace {
  let key: Buffer | null = null;
  const encKey = (): Buffer => (key ??= deriveKey(machineMaterial()));
  const nameOf = (provider: string): string => credentialKey(GLOBAL_AGENT_ID, provider);
  return {
    get(provider) {
      return readCredential(dataRoot, encKey(), nameOf(provider)) ?? '';
    },
    state(provider) {
      return credentialState(dataRoot, encKey(), nameOf(provider));
    },
    set(provider, value) {
      const name = nameOf(provider);
      if (value === '') removeCredential(dataRoot, name);
      else writeCredential(dataRoot, encKey(), name, value);
    },
  };
}

/** 白名单校验：点路径首段须在可写集合内（未知键 fail-closed） */
export function assertConfigKey(key: string): void {
  const first = key.split('.')[0];
  if (!first || !CONFIG_KEY_PREFIXES.has(first)) {
    throw new Error('config 键 "' + key + '" 不在可写白名单（' + [...CONFIG_KEY_PREFIXES].join('/') + '）');
  }
}

/**
 * 保存前 sanitize：递归剥离值等于掩码的字段（打码凭据绝不回写盘）。
 * 掩码字段「从 payload 消失」= 本次不表态（config/save 的池条目保持语义）。
 */
export function sanitizeConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitizeConfigValue(v));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === API_KEY_MASK) continue;
    out[k] = sanitizeConfigValue(v);
  }
  return out;
}

/** 读面深度脱敏：任何 *key / api_key / token / secret 字段一律打码（cr-562） */
export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/^(api_?key|token|secret|password)$/i.test(k) && typeof v === 'string' && v !== '') { out[k] = API_KEY_MASK; continue; }
    out[k] = maskSecrets(v);
  }
  return out;
}

const isEntry = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 提取池条目 api_key 进凭据库并从返回值剥离（返回同形状值，可直接进
 * config.set）。current = 写前全量配置快照（改名迁移的旧名来源）。
 *
 * 改名迁移（主线 cr-21）：条目以掩码回传（= 保持凭据不变）但该名下无凭据、
 * 且池中消失的旧名有凭据 → 搬迁旧名 → 新名。匹配规则 = 同字段同值（连接
 * 指纹）；指纹失配但消失的有凭据旧名唯一时同样迁移（单条目编辑弹窗一次
 * 只改一个名）；其余不迁移（fail-safe——删除条目走 llm/pool-credential
 * 显式清理，不在此隐删）。
 */
export function extractPoolCredentials(
  current: Record<string, unknown>,
  creds: PoolCredentialFace,
  key: string,
  value: unknown,
  warnings: string[] = [],
): unknown {
  const prefix = POOL_CRED_PREFIX[key];
  if (!prefix || !isEntry(value)) return value;
  // 消失的旧名候选（有凭据者）——掩码条目无凭据时用于改名迁移匹配
  const dropped: Array<[string, Record<string, unknown>]> = [];
  const oldPool = current[key];
  if (isEntry(oldPool)) {
    const nextNames = new Set(Object.entries(value).filter(([, e]) => isEntry(e)).map(([n]) => n));
    for (const [name, entry] of Object.entries(oldPool)) {
      if (!nextNames.has(name) && !name.startsWith('$') && isEntry(entry) && creds.get(prefix + name) !== '') {
        dropped.push([name, entry]);
      }
    }
  }
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isEntry(entry) || name.startsWith('$')) {
      out[name] = entry;
      continue;
    }
    const e = { ...entry };
    const apiKey = e.api_key;
    const provider = prefix + name;
    if (typeof apiKey === 'string' && apiKey !== API_KEY_MASK && apiKey !== '') {
      creds.set(provider, apiKey); // 新值 = 存
    } else if (apiKey === '' && creds.state(provider) === 'locked') {
      // 空串删除指令命中 locked 密文（换机后掩码回填 '' 的误删路径）——
      // 密文在盘可恢复，保留不删（cr-310）：填新值保存即可覆盖自愈
      warnings.push(lockedCredentialWarning(name));
    } else if (typeof apiKey === 'string' && apiKey !== API_KEY_MASK) {
      creds.set(provider, ''); // 空串 = 删（locked 已在上面拦截）
    } else if (apiKey === API_KEY_MASK && creds.get(provider) === '') {
      // 掩码但凭据缺席 → 改名候选（同连接指纹优先；失配时消失旧名唯一才迁）
      const byFingerprint = dropped.find(
        ([, old]) => JSON.stringify({ ...old, api_key: undefined }) === JSON.stringify({ ...e, api_key: undefined }),
      );
      const oldName = byFingerprint?.[0] ?? (dropped.length === 1 ? dropped[0][0] : undefined);
      if (oldName !== undefined) {
        creds.set(provider, creds.get(prefix + oldName));
        creds.set(prefix + oldName, '');
      }
    }
    delete e.api_key;
    out[name] = e;
  }
  return out;
}

/** 读面回填池条目 api_key 掩码（'' = 未设置）——就地变异传入的全量快照 */
export function backfillPoolMasks(creds: PoolCredentialFace, config: Record<string, unknown>): void {
  for (const [key, prefix] of Object.entries(POOL_CRED_PREFIX)) {
    const pool = config[key];
    if (!isEntry(pool)) continue;
    for (const [name, entry] of Object.entries(pool)) {
      if (!isEntry(entry)) continue;
      entry.api_key = creds.get(prefix + name) === '' ? '' : API_KEY_MASK;
    }
  }
}

/**
 * config/set 单键写面：白名单 → 池凭据侧信道 → 掩码 sanitize → 落盘
 * （config.json）。返回 warnings（locked 守卫——前端 toast）。
 */
export function writeConfigKey(
  face: ConfigFace,
  creds: PoolCredentialFace,
  key: string,
  value: unknown,
): string[] {
  assertConfigKey(key);
  if (value === undefined) throw new Error('参数 value 缺失');
  const warnings: string[] = [];
  face.set(key, sanitizeConfigValue(extractPoolCredentials(face.all(), creds, key, value, warnings)));
  return warnings;
}

/** config/delete 单键写面（白名单同源；非池域键无凭据动作） */
export function removeConfigKey(face: ConfigFace, key: string): void {
  assertConfigKey(key);
  face.delete(key);
}

/**
 * config/save 全量写面：白名单域内 replace 语义——payload 有的键覆盖写入、
 * payload 缺的键删除；白名单外键一律不动（app 内部键归各域服务所有）。
 * 池域条目 api_key 先经侧信道（掩码 = 不动 / '' = 删 / 新值 = 存），
 * config.json 永不落 key。
 */
export function saveConfigDomains(face: ConfigFace, creds: PoolCredentialFace, next: unknown): string[] {
  if (!isEntry(next)) throw new Error('参数 config 须为对象');
  // 顺序要紧：sanitize 先剥掉掩码字段（= 保持不变），再对存留的池条目
  // 提取真实 key（''/新值）——被剥掉的掩码条目不动凭据库。
  const payload = sanitizeConfigValue(next) as Record<string, unknown>;
  const current = face.all();
  const warnings: string[] = [];
  for (const key of CONFIG_KEY_PREFIXES) {
    if (key in payload) {
      face.set(key, extractPoolCredentials(current, creds, key, payload[key], warnings));
    } else if (key in current) {
      face.delete(key);
    }
  }
  return warnings;
}
