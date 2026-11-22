// ============================================================
// keys.ts —— 会话键词法学单源（cr-1238 B2）
//
// 三层权威之词法层：string → KeyShape「这串字符长什么样」。只答形状，
// 不答语义（会话是什么归登记层 cr-1213；run 为何存在归 origin B5）。
// 总函数：任何字符串都有一档——解析在无 ~ 键上的行为未定义（cr-1192）
// 在类型上不可能。两段键键面不可辨（gid~member 与 gid~aid 同形）是
// 公理不是缺陷：pair 档不携带语义主张。
// ============================================================

/** singles 独立会话键词形（uuid v4/v7 兼容，大小写不敏感）——签发源恒此形 */
export const UUID_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 群会话键前缀（运行面恒 g-；签发面是否强制属群行裁决，键库只判形） */
export const GROUP_KEY_PREFIX = 'g-';

/** 子 Agent 会话键前缀（ac-shell-subagent spawn 铸造） */
export const SUB_KEY_PREFIX = 'sub_';

/**
 * 键形判别联合（总函数返回值）——纯 shape，无 kind/scope 语义字段。
 * pair 携 left/right（两段拆分是语法事实）；plain = 其余任何串（裸 agent
 * id 回退 / 未见过键形的兜底档）。
 */
export type KeyShape =
  | { shape: 'uuid'; id: string }
  | { shape: 'pair'; left: string; right: string }
  | { shape: 'group'; gid: string }
  | { shape: 'sub'; id: string }
  | { shape: 'plain'; id: string };

/**
 * 键形解析（总函数）：任何字符串都返回一档，无异常无 undefined。
 * 判序：uuid → 两段~（pair，段空落 plain）→ g- → sub_ → plain。
 * 键面不可辨公理（cr-1213）：gid~member 群成员流与群 runAddress 同形，
 * 一律落 pair——名册语义问登记层，不问键面。
 */
export function parseKey(key: string): KeyShape {
  if (UUID_KEY_RE.test(key)) return { shape: 'uuid', id: key };
  if (key.includes('~')) {
    const parts = key.split('~');
    // 恰好两段且非空才是对键形：群 runAddress gid~aid 与成员流 gid~member
    // 同为此形；三段+（多 ~）= 退化串落 plain（旧 participantsOfKey 同语义）
    if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
      return { shape: 'pair', left: parts[0], right: parts[1] };
    }
    return { shape: 'plain', id: key };
  }
  if (key.startsWith(GROUP_KEY_PREFIX)) return { shape: 'group', gid: key.slice(GROUP_KEY_PREFIX.length) };
  if (key.startsWith(SUB_KEY_PREFIX)) return { shape: 'sub', id: key };
  return { shape: 'plain', id: key };
}

/** uuid 形（singles 判词——cr-1120/1179 收口，前端副本 dialogIdLex 同批退役） */
export function isUuidKey(key: string): boolean { return parseKey(key).shape === 'uuid'; }

/** 对键形 a~b（两段非空；含 a~a 自会话对角线；gid~member 同形落此） */
export function isPairKey(key: string): boolean { return parseKey(key).shape === 'pair'; }

/** 群键形 g-<gid> */
export function isGroupKey(key: string): boolean { return parseKey(key).shape === 'group'; }

/** 子 Agent 键形 sub_* */
export function isSubKey(key: string): boolean { return parseKey(key).shape === 'sub'; }

/**
 * 段成员资格（形状事实，非语义）：键含段 id（对键两端之一 / 群成员流右段）。
 * fold:340、archive:142/860、web-api:172 的 split('~').includes(x) 收口于此。
 */
export function pairIncludes(key: string, id: string): boolean {
  const s = parseKey(key);
  return s.shape === 'pair' && (s.left === id || s.right === id);
}

// ---- 构造词（自 ac-core-utils 迁入，cr-1238 D1——词法协议全仓单源） ----

/** 对键构造：两端排序后 ~ 连接（a===b 即自会话对角线） */
export function pairKey(a: string, b: string): string { return [a, b].sort().join('~'); }

/**
 * run 寻址（steer/串行化门共用）：conversationId 缺省或 = agent → agent；
 * 否则 conversationId~agent（无歧义前提：Agent id 禁 ~）。
 */
export function runAddress(agent: string | undefined, conversationId: string | undefined): string | undefined {
  if (agent === undefined) return undefined;
  if (!conversationId || conversationId === agent) return agent;
  return conversationId + '~' + agent;
}

/** 会话键键形反演（cr-1213）：1v1 对键两端点；其余键面无权威名册恒 undefined */
export function participantsOfKey(key: string): string[] | undefined {
  const s = parseKey( key );
  if (s.shape === 'pair') return [s.left, s.right];
  return undefined;
}

/** 群成员私有转录流键：gid~member（member 恒最右，gid 禁 ~ 使拆分唯一） */
export function memberStreamKey(groupId: string, member: string): string { return groupId + '~' + member; }

// ---- 端点保留字（自 ac-agents-core/tree.ts 迁入，cr-1238 D3） ----

/** 端点保留字：host = 宿主服务帧域；user = 虚拟端点但真会话参与者 */
export const RESERVED_ENDPOINT_IDS: ReadonlySet<string> = new Set(['host', 'user']);

export function isReservedEndpointId(id: string): boolean {
  return RESERVED_ENDPOINT_IDS.has(id) || id.startsWith('@');
}

/** 机制域端点（cr-1213 R-1 豁免面）：host + @ 群地址；user 不豁免 */
export function isMechanismEndpointId(id: string): boolean {
  return id === 'host' || id.startsWith('@');
}

/**
 * Agent 身份词形（纯词形单义，cr-1186）：id 禁 ~——对键桶词形，非身份词。
 * 不拒保留字（user 是合法虚拟身份，名册投影源）；保留字拒斥归创建闸三处。
 */
export function isAgentIdentity(id: string): boolean {
  return id !== '' && !id.includes('~');
}