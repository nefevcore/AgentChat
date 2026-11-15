// ============================================================
// prefix-snapshot.ts —— singles system prompt 前缀物化（cr-888）
//
// 目标不变量：singles 的 [system] 块跨 run 跨重启字节恒定——首 run 把
// PromptSection 注册面的求值结果（段数组 + 指纹）冻结落盘；此后 run 不再
// 现场求值，直接喂快照段给 assembleSystemPrompt（段序由 order 承载）。
//
// 四机制（docs/design/platform/single-system-prompt-materialization-plan.md）：
//   ① 物化（首 run）/ ② diff（每 run 指纹对比）/ ③ 重算（缓存域必死时
//   重建基线——触发面 cr-944 段位漂移 → cr-1114 扩 ptcSdk/tools/
//   sectionTexts 正文域漂移）/ ④ 注入（变化清单 → ledger context 通知行
//   + 指纹更新）。
// 快照正文（人格层）不因 ④ 重写；③ 是唯一重写通道。tools/ptcSdk 漂移随
// cr-1114 升 ③——对应 ④ 通知句已退役（service.ts 同批）。
// 崩溃窗口：先落账（await）后更新指纹——落账后崩 → 重复落同内容行
//（requestId 幂等键收敛冗余，冗余但如实）；反序则漏通知。
//
// 本文件 = 纯 IO/纯函数（编排住 service.ts driveRun）；落点
// meta/prefix-snapshots/<sid>.json（cr-1100 自 meta/sessions/ 分居——与
// singles 元数据同居时被宿主侧 listIds 通配扫描误收成幻影会话；旧位由
// 宿主 singles 行装载时幂等搬空，此处只认新位）。
// ============================================================
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 物化段（求值后的静态文本；order = SECTION_ORDER 具名位） */
export interface SnapshotSection {
  name: string;
  order: number;
  text: string;
}

/** 前缀快照（wire 形 = 持久形态） */
export interface PrefixSnapshot {
  version: 1;
  createdAt: string;
  sections: SnapshotSection[];
  /** §3 diff 指纹键面（model/tools/toolMode/browserTier/issueSubmit/
   * workspace/access（cr-947 合并旧 tier+elevation）/ptcSdk/skills +
   * ext.<扩展键>） */
  settingsFingerprint: Record<string, string>;
}

export function snapshotFileOf(dataRoot: string, sid: string): string {
  // 路径守卫：sid 由 singles 域生成（uuid 形），防御性拒绝路径词形
  if (sid === '' || sid.includes('/') || sid.includes('\\') || sid.includes('..')) {
    throw new Error('会话 id "' + sid + '" 非法（非空，禁路径分隔 / ..）');
  }
  // cr-1100 分居：快照独占目录（类型物理隔离——meta/sessions/ 通配扫描
  // 词汇 = 裸 <sid>.json 会话元数据，不再容忍寄居文件）
  return path.join(dataRoot, 'meta', 'prefix-snapshots', sid + '.json');
}

/** 读快照（缺席/损坏/形状非法 → null = 按 ① 重新物化，fail-safe） */
export function readPrefixSnapshot(dataRoot: string, sid: string): PrefixSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(snapshotFileOf(dataRoot, sid), 'utf-8'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { version?: unknown; createdAt?: unknown; sections?: unknown; settingsFingerprint?: unknown };
  if (r.version !== 1) return null;
  if (typeof r.createdAt !== 'string') return null;
  if (!Array.isArray(r.sections)) return null;
  const sections: SnapshotSection[] = [];
  for (const s of r.sections) {
    if (s === null || typeof s !== 'object') return null;
    const sec = s as { name?: unknown; order?: unknown; text?: unknown };
    if (typeof sec.name !== 'string' || typeof sec.order !== 'number' || typeof sec.text !== 'string') return null;
    sections.push({ name: sec.name, order: sec.order, text: sec.text });
  }
  const fp = r.settingsFingerprint;
  if (fp === null || typeof fp !== 'object' || Array.isArray(fp)) return null;
  const settingsFingerprint: Record<string, string> = {};
  for (const [k, v] of Object.entries(fp as Record<string, unknown>)) {
    if (typeof v !== 'string') return null;
    settingsFingerprint[k] = v;
  }
  return { version: 1, createdAt: r.createdAt, sections, settingsFingerprint };
}

/** 原子写（tmp + rename，同 singles session.json 惯例） */
export function writePrefixSnapshot(dataRoot: string, sid: string, snap: PrefixSnapshot): void {
  const file = snapshotFileOf(dataRoot, sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

/** 存量快照旧档位词强度序（cr-1082 后仅服务旧快照 diff 一次性迁移通知——词汇轴已死） */
const LEGACY_ACCESS_ORDER: Record<string, number> = { 'base-access': 0, 'sandbox-access': 1, 'full-access': 2 };

/** 指纹规范化（幂等键的输入——键序稳定防同内容异序哈希） */
function canonicalFp(fp: Record<string, string>): string {
  return JSON.stringify(Object.keys(fp).sort().map((k) => [k, fp[k]]));
}

/**
 * §4 变化注入清单（cr-947 起 tier/elevation 合并为 access 单类）：逐键 diff → 通知句清单 + 幂等键。
 * 合并规则：一次 diff 检出多项 → 多句并列（调用方合并一条 context 行）；
 * toolMode 连带的清单变化归 toolMode 一句，不重复报。措辞按方案 §4 表
 * 逐条锁定（对齐 system-prompt 按条目锁措辞先例，防渐进膨胀）。
 */
export function diffFingerprints(
  oldFp: Record<string, string>,
  nextFp: Record<string, string>,
  opts: { defaultWorkdir: string },
): { notices: string[]; requestId: string } {
  const notices: string[] = [];
  const val = (s: string): string => (s === '' ? '默认' : s);
  // #2 toolMode（先判——收窄连带的清单变化归此句）
  const modeChanged = oldFp.toolMode !== nextFp.toolMode;
  if (modeChanged) {
    if (nextFp.toolMode === 'tc-programmatic') {
      notices.push('[会话设置] 工具调用模式已切换：程序化——一切工具调用经 run_code 编排完成，不再逐个直调。');
    } else if (nextFp.toolMode === 'tc-none') {
      notices.push('[会话设置] 工具调用模式已切换：工具已全部停用，纯对话。');
    } else {
      notices.push('[会话设置] 工具调用模式已恢复工具直调。');
    }
  }
  // #1 工具集（cr-1114 批1：tools 键漂移已升 ③ 重算——syncPrefixSnapshot 抢先
  // 重写快照，本句不可达，退役。语义：工具集变化 = 正文字节变 = KV cache
  // 前缀必死，重算即对齐，无需通知行。）
  // #3 browserTier：降档/停用/从停用恢复都通知；observe→'' 等 knob 清除 = 回落
  // tags——若 Agent 本有 browser 档标签则档位静默变化，无法区分，静默
  if (oldFp.browserTier !== nextFp.browserTier) {
    if (nextFp.browserTier === 'disabled') {
      notices.push('[会话设置] 浏览器工具本会话已停用。');
    } else if (oldFp.browserTier === 'disabled') {
      notices.push('[会话设置] 浏览器工具已恢复可用（档位 ' + val(nextFp.browserTier) + '）。');
    } else if (nextFp.browserTier !== '') {
      notices.push('[会话设置] 浏览器能力档位已调整：' + val(oldFp.browserTier) + ' → ' + nextFp.browserTier + (nextFp.browserTier === 'observe' ? '（交互动作不再可用）' : '') + '。');
    }
  }
  // #4 issueSubmit：disabled → enabled/清除（清除 = 回落 tags）都算启用；
  // enabled → 清除 = 回落 tags——若 Agent 本就有 issue-report 标签则静默（无法区分，不通知）
  if (oldFp.issueSubmit !== nextFp.issueSubmit) {
    if (nextFp.issueSubmit === 'disabled') {
      notices.push('[会话设置] ISSUE 提交已停用。');
    } else if (oldFp.issueSubmit === 'disabled') {
      notices.push('[会话设置] ISSUE 提交已启用。');
    }
  }
  // #5 workspace（挂载根路径）
  if (oldFp.workspace !== nextFp.workspace) {
    if (nextFp.workspace === '') {
      notices.push('[会话设置] 工作区已移除，回到默认工作目录 ' + opts.defaultWorkdir + '。');
    } else if (oldFp.workspace === '') {
      notices.push('[会话设置] 工作区已挂载：' + nextFp.workspace + '。');
    } else {
      notices.push('[会话设置] 工作区已切换：' + oldFp.workspace + ' → ' + nextFp.workspace + '。');
    }
  }
  // #6 技能卸载（装载不注入——技能注入机制本身落 context 行已自明）
  if (oldFp.skills !== nextFp.skills) {
    const oldNames = oldFp.skills === '' ? [] : oldFp.skills.split(',');
    const nextSet = new Set(nextFp.skills === '' ? [] : nextFp.skills.split(','));
    const removed = oldNames.filter((n) => !nextSet.has(n));
    if (removed.length > 0) notices.push('[会话设置] 技能 ' + removed.join('、') + ' 已卸载，其指引不再适用。');
  }
  // #7 安全档位（cr-947 合并旧 #7 tier + #8 elevation 两类：行为面只看
  // 合成终值——底座/信封/会话覆盖任一变化都体现为 access 键变；降档
  // 附授权提示，升档只报事实）。存量快照读兼容：旧两键（tier/elevation）
  // 取 rank 高者作旧值——旧 tier 含 base 值、旧 elevation 只有两档。
  const legacyFp = oldFp as Record<string, string | undefined>;
  // cr-1082：nextFp 恒无 access 键——只有旧快照真有值（access/tier/elevation
  // 任一在场）才通知一次迁移；两边缺席零噪声。
  const oldAccessRaw = legacyFp.access ?? [
    legacyFp.tier, legacyFp.elevation,
  ].filter((v): v is string => v !== undefined && v !== '')
    .reduce((hi, cur) => (LEGACY_ACCESS_ORDER[cur] ?? 0) >= (LEGACY_ACCESS_ORDER[hi] ?? 0) ? cur : hi, '');
  const nextAccess = (nextFp as Record<string, string | undefined>).access ?? '';
  const oldAccess = oldAccessRaw === '' ? 'base-access' : oldAccessRaw;
  if (oldAccessRaw !== nextAccess) {
    const down = (LEGACY_ACCESS_ORDER[nextAccess] ?? 0) < (LEGACY_ACCESS_ORDER[oldAccess] ?? 0);
    notices.push('[会话设置] 安全档位已调整：' + val(oldAccess) + ' → ' + val(nextAccess) + (down ? '，部分工具调用将需要授权。' : '。'));
  }
  // #11 段集增删（cr-944 §3）：新增/移除注册段——行为面变化（模型按旧段集
  // 认知 system），对齐 #1 精神注入通知；sectionTexts 纯文本漂移不通知
  //（裁决 B：散文不产生可执行先验——键值仍进指纹，漂移只报一次即指纹对齐）。
  if (oldFp.sectionSet !== nextFp.sectionSet) {
    // 段名集为不可逆 hash——通知只报事实不定名（名集差异由注册面对账，重算/下一
    // 物化自然收编；此处通知引导模型以当前 system 为准）。
    notices.push('[会话设置] 系统提示词段落构成已变化（新增/移除了指引段落），以当前会话为准。');
  }
  // #9 PTC_SDK 漂移（cr-1114 批1：ptcSdk 键漂移已升 ③ 重算——本句不可达，
  // 退役。快照正文重写即携带新 SDK 投影，无需通知行。）
  // #10 生态扩展键
  const extKeys = [...new Set([...Object.keys(oldFp), ...Object.keys(nextFp)].filter((k) => k.startsWith('ext.')))].sort();
  for (const k of extKeys) {
    const ov = oldFp[k] ?? '';
    const nv = nextFp[k] ?? '';
    if (ov === nv) continue;
    notices.push('[会话设置] ' + k.slice(4) + ' 已变化：' + (ov === '' ? '无' : ov) + ' → ' + (nv === '' ? '无' : nv) + '。');
  }
  const requestId = notices.length === 0 ? '' : 'conv-notice-' + crypto.createHash('sha256')
    .update(canonicalFp(oldFp) + '|' + canonicalFp(nextFp)).digest('hex').slice(0, 16);
  return { notices, requestId };
}
