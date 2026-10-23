# 授权注册表 · 数据格式（工程规格草稿）

> 性质：工程规格草稿（preview 开工输入），非裁决。2026-10-14。依据：per-agent 档案
> D3 修订（控制面恒为数据面 / 域外 = 授权状态变更）、R-4（授权信）、R-5（spawn ⊆
> 授权投影）、R-11 ③（凭据直读）、R-12（MCP 归属）；shell-model S3（授权宽度 = 参数）；
> 协议规格 E 节（grant 事务）。配套：host-shell-row-manifest.md v3（auth-registry 行 + 壳侧
> tools 门——security-exec 已改判非行，见行集清单 v3 R4）。
> 2026-10-16 修订（cr-484）：tag 机制解体上位修订——C 节投影 ∩ AgentConfig.tags
> 换轨为 ∩ 行集；AssetRef.tag → AssetRef.row（行引用资产，与 install = 授权动作
> 同语义）；E 节「AgentConfig.tags 不动」平移项废止，双闸强度不变（全局授予只对
> 装了该行的 agent 生效）。依据：裁决簿〈tag 机制解体〉。

# A. 总形态

```
数据根/
  auth.json                      # 全局层：宿主单写；additive 条目 + revoke 墓碑
  agents/<agentId>/
    auth.json                    # per-agent 层：写者面在宿主（授权信管道）；
                                 #   shell 只读、每 run 前重读（R-6 直读同构第四层）
    sessions/<uuid>/…            # 账本（D4，不属授权资产）
    children/<childId>/          # 子树：物化时宿主写（spawn ⊆ 投影）；此后随 per-agent
                                 #   层同规则管理
  credentials/                   # 凭据库（R-11 ③：物理单副本，注入纯库两侧共用——
                                 #   不复制进 auth.json，只存引用）
  mcp.json                       # MCP 服务器清单（R-12：授权资产；现状行 config 迁数据根）
```

两层皆宿主单写（D3 修订「封死子树自授」）；壳恒只读。授权资产 = 数据非版本——独立
于 R-7 版本指纹，但变更自带动账（B3 指纹）。

# B. Schema（v1）

## B1. 全局层 auth.json

```ts
interface GlobalAuth {
  version: 1;
  entries: GlobalAuthEntry[];    // additive-only：新增不改旧；删除 = 墓碑条目
}
interface GlobalAuthEntry {
  id: string;                    // 稳定条目 id（UUIDv7）
  asset:
    | { kind: 'credential'; ref: string }          // credentials/ 内条目名（引用不复制）
    | { kind: 'row-load'; rowId: string }         // 行装载授权（装载 = 授权动作；静态行
                                                   //   与插件行同语义，cr-484）
    | { kind: 'mcp-server'; name: string }         // MCP 服务器放行
  grantedAt: string;             // ISO 时间
  grantSource: 'user-webui' | 'grant-letter';     // 用户直配 or 授权信受理
  revokedAt?: string;            // 墓碑：非空 = 已吊销（不物理删——审计 + 指纹稳定）
  note?: string;
}
```

## B2. per-agent 层 agents/<id>/auth.json

```ts
interface AgentAuth {
  version: 1;
  agentId: string;
  parentId?: string;             // children 有：物化来源（快照溯源，R-5）
  materializedAt?: string;       // children 有：spawn 时间
  grants: AssetRef[];            // 授权资产引用集（全局条目 id 或内联字面量）
  denials: AssetRef[];           // 显式拒绝集（投影减法项；user 对 child 的收紧）
  // AssetRef = { globalId?: string; row?: string; mcp?: string; inline?: InlineAsset }
  //   （row = 行引用资产：install 同语义；tag 引用已随 tag 机制解体退役——cr-484）
}
```

## B3. 指纹

授权注册表指纹 = sha256(canonical(全局 auth.json) || canonical(per-agent auth.json))。
grant 事务 priorFingerprint / 回执新指纹（协议规格 E）对此对拍。独立于 R-7 版本指纹
（授权是数据不是版本——R-7 已裁），receipt 信封可同时携带两者。

# C. 投影算法（壳侧 tools 门每 run 前执行；实现 = ac-auth-core 纯库）

```
effective(agent) = { a ∈ 全局层有效条目 ∪ per-agent 内联条目 | a ∉ denials }
                   ∩ 行集（装配期派生清单——AgentConfig 行引用）
                   ∩（children：直接读物化快照的 grants/denials——不重算，
                      物化即快照，父此后改配置不传播，R-5）

语义要点：
1. 全局 ∩ 行集：全局授予但该 agent 未装对应行 → 不生效（声明面与授权面双闸，
   声明面从 tags 换轨为行集引用——裁决簿〈tag 机制解体〉）；
2. denials 优先于一切（显式拒绝 > 全局授予 > per-agent 授予）；
3. children 不做运行时投影——物化即快照；
4. 每 run 前重读 = 生效时点语义（协议规格 E：最终一致，在线吊销最坏延迟 =
   run 收束 + 下次重读）。
```

# D. grant 事务（授权信受理 → 注册表变更 → 回执）

```
1. 壳投 kind=grant 信封 → 邮局 → 宿主 auth-registry 行
2. 宿主：requestId 去重 → 全局层或 per-agent 层追加条目（additive，带 grantSource=
   grant-letter）→ 计算新指纹 → 原子写盘（temp + rename）
3. 回执 kind=receipt（新指纹）→ agent 经验流
4. 需 user 批准的资产（credential / plugin-row）：宿主先发 ask 形态审批信给 user 端点
   （webui 卡片 / CLI 桩），批准后走 2——「审批 = user 端点的消息形态」（R-9）在授权域
   的实例化
```

# E. 与现状五状态复用清单

| 现状 | 去向 |
|---|---|---|
| ac-security requiredTags / needPermission 语义 | C 节投影算法双闸 + 审批信实例化；requiredTags 词汇已随 tag 机制解体退役（cr-484），门禁 = 行集 ∧ 投影 |
| ac-credentials 凭据库 | credentials/ 原位保留（引用制，物理单副本） |
| ac-workspace agentWorkdir / 授权目录 | 内联字面量资产（InlineAsset { workdir, allowedDirs }）进 per-agent grants |
| ac-mcp 行 config.servers | mcp.json 迁数据根（R-12：清单 = 授权资产） |
| AgentConfig.tags（声明面） | 退役——声明面换轨为行集引用（工具点名 ∨ 行名），与授权面双闸形状不变（C1 修订，cr-484） |

# F. 待钉（cr-545 全钉，2026-10-19）

1. ✅ mcp.json 保持独立文件（倾向即裁决：MCP 现有用户可见面不动，auth 引用之——
   mcp-server 授予时宿主同步补写清单）；
2. ✅ denials 编辑面 = F2 分立（用户裁决 2026-10-19，依据「授权位置与壳读取」推导）：
   auth.json 物理写口单源归 auth-registry 行（本档案 A/B 节「两层皆宿主单写」+
   manifest R1「授权注册表写者」），grant 信（agent 入口）与用户编辑（webui 入口）
   是两个入口一个写口——授权编辑面 = auth-registry 自带 auth/* RPC 域（deny/allow/
   agent-view/global-view/credentials/write-credential），agent-admin 保持身份编辑面
   纯度（config/entries/文档，不碰 auth.json）；webui 卡片如何组合两域是前端自由；
3. ✅ 全局层按 agent 维度默认集：缺省 = 空（最小授权原则钉死，不设默认集）。

## 本档案纪律

- 探索档案（explore/）：规格草稿；schema 字段实现时可微调，投影语义 / 墓碑 / 双闸 /
  物化快照四条以裁决档案为准。正式立项时随两母档案迁 src/docs/。
- 引用规则：裁决依据写 R-n / D-n / S-n；待钉项写 ◐。
