// ============================================================
// wire.ts —— webui-v3 wire schema 与合成纯函数（cr-924/925 切片①）
//
// 设计源 docs/design/webui-v3.md §4.3：wire = 活 fiber 集的投影，
// 一致性由构造保证。本文件只承担纯合成面（声明校验门 / 撞名防御 /
// 种子版本对拍 / inject 拓扑序 / 图级 rev 哈希）；打脏/flush 与
// wire/graph·rebuilt WS 帧推送住宿主行（apps/ui/src/webui-row.ts v3）。
// 降级语义（§4.2）：点名缺席 / 第三方解析失败 = 警告 + 跳过 + 上报
// warnings 域；全部经 synthesizeWire 单入口。
// ============================================================

/** wire 行（浏览器装载面——§4.3.1 schema） */
export interface WireRow {
  /** 行 id = cordis 插件名（全链寻址键） */
  id: string;
  /** 包版本——审计与等值判据，不参与装载 */
  version: string;
  /** factory bundle revision URL（纯样式行可空） */
  entry?: string;
  /** 附加 CSS revision URL */
  styles?: string[];
  /** 依赖行——预取序 + 拓扑排序输入 */
  inject?: string[];
  /** 席位声明——渲染挂点 */
  seats: string[];
  /** 执行档：true = sandbox iframe（v3 缺省 false——语义翻转注记见 §4.6） */
  isolated: boolean;
}

/** wire 文档（GET /api/ui/wire 应答体） */
export interface Wire {
  /** 图级修订：rows 的 id+revision 序列化哈希（SSE/WS 对账用） */
  rev: string;
  rows: WireRow[];
  /** 种子词 → 壳活实例版本区间（壳构建期生成） */
  seeds: Record<string, string>;
  /** 降级/失败上报面（点名缺席 · 解析失败 · 撞名 · 种子不匹配） */
  warnings: string[];
}

/** flush 步3-4 产物：行名解析后的装载输入（宿主行组装，纯函数不触盘） */
export interface WireRowInput {
  id: string;
  version: string;
  /** 包内 client/dist/manifest.json 的 rev（构建期内容哈希——宿主只读不算） */
  revision: string;
  /** 产物清单 files 键（缺席 = 纯样式行，如 theme 行仅 styles） */
  entry?: string;
  styles?: string[];
  inject?: string[];
  seats: string[];
  isolated?: boolean;
  /** 行种子兼容区间声明（ac.faces.web.seeds——§4.4 版本治理） */
  seeds?: Record<string, string>;
}

/** 声明校验结果（与 manifest.ts ManifestCheck 同风格） */
export interface WebFaceCheck {
  ok: boolean;
  warnings: string[];
}

const ID_RE = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9-]*$/;
/** 产物相对路径：client/dist 下、无逃逸（§4.5 entry 显式词形） */
const DIST_REL_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * ac.faces.web 声明校验门（flush 步3——纯数据，第三方零宿主执行）。
 * entry 词形 = ./client/dist/<file> 显式指产物（§4.5 裁决）。
 */
export function checkWebFace(web: unknown): WebFaceCheck {
  const warnings: string[] = [];
  if (web === null || typeof web !== 'object' || Array.isArray(web)) {
    return { ok: false, warnings: ['ac.faces.web 非对象'] };
  }
  const x = web as Record<string, unknown>;
  if (typeof x.entry !== 'string' || !x.entry.startsWith('./client/dist/') || x.entry.includes('..')) {
    warnings.push('entry 词形非法（须 ./client/dist/<file> 显式指产物）：' + String(x.entry));
  }
  if (x.seats !== undefined) {
    if (!Array.isArray(x.seats) || x.seats.some((s) => typeof s !== 'string' || s === '')) {
      warnings.push('seats 非字符串数组');
    }
  }
  if (x.isolated !== undefined && typeof x.isolated !== 'boolean') warnings.push('isolated 非布尔');
  if (x.inject !== undefined) {
    if (!Array.isArray(x.inject) || x.inject.some((s) => typeof s !== 'string' || s === '')) {
      warnings.push('inject 非字符串数组');
    }
  }
  if (x.seeds !== undefined) {
    const bad = x.seeds === null || typeof x.seeds !== 'object' || Array.isArray(x.seeds)
      || Object.entries(x.seeds as Record<string, unknown>).some(([, v]) => typeof v !== 'string');
    if (bad) warnings.push('seeds 非字符串区间表');
  }
  return { ok: warnings.length === 0, warnings };
}

/** 区间首个主版本号（^3.4 / ~3 / >=3.2 / 3.x / v4 → 3/3/3/3/4；不可解析 = null） */
function majorOf(range: string): number | null {
  const m = new RegExp('[~^>=< ]*v?(' + String.fromCharCode(92) + 'd+)').exec(range.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * 种子版本对拍（§4.4）：跨大版本（如 vue 4 壳 vs vue 3 行）禁静默炸
 * ——不匹配 = flush 警告跳过 + 物化 throw 兜底。次版本以下区间细判
 * 暂不做（对拍面收窄到主版本轴；细化随首次真实冲突再立项）。
 */
export function seedCompatible(shellRange: string, rowRange: string): boolean {
  const a = majorOf(shellRange);
  const b = majorOf(rowRange);
  return a !== null && b !== null && a === b;
}

/** FNV-1a 32 位（图级 rev 对账键——内容真哈希在构建期 manifest rev） */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 产物 URL（revision URL——HTTP 缓存语义由 URL 承担，§4.5） */
export function assetUrl(id: string, revision: string, file: string): string {
  return '/ui-asset/' + encodeURIComponent(id) + '/' + encodeURIComponent(revision) + '/' + file;
}

/**
 * wire 合成（flush 步5——纯函数）：校验门 → 撞名防御 → 种子对拍 →
 * inject 拓扑排（缺席/环 = 警告跳过）→ rev 哈希。输入序在无依赖关系时
 * 保持稳定（确定性输出）。
 */
export function synthesizeWire(inputs: WireRowInput[], shellSeeds: Record<string, string>): Wire {
  const warnings: string[] = [];
  const seen = new Set<string>();
  // 步3+撞名防御：逐行校验，违例警告 + 跳过；后到撞名跳过后者（§4.3.2 步3）
  const kept: WireRowInput[] = [];
  for (const row of inputs) {
    if (typeof row.id !== 'string' || !ID_RE.test(row.id)) {
      warnings.push('行 id 词形非法：' + String(row.id));
      continue;
    }
    if (seen.has(row.id)) {
      warnings.push('撞名防御：行 id 重复，跳过后者 ' + row.id);
      continue;
    }
    if (typeof row.version !== 'string' || row.version === '') {
      warnings.push(row.id + '：version 缺失');
      continue;
    }
    if (typeof row.revision !== 'string' || row.revision === '') {
      warnings.push(row.id + '：revision（产物清单 rev）缺失');
      continue;
    }
    if (row.entry !== undefined && !DIST_REL_RE.test(row.entry)) {
      warnings.push(row.id + '：entry 产物词形非法 ' + String(row.entry));
      continue;
    }
    if (row.styles !== undefined && (row.styles.some((s) => !DIST_REL_RE.test(s)))) {
      warnings.push(row.id + '：styles 产物词形非法');
      continue;
    }
    // 种子对拍：行声明区间 × 壳活实例区间（§4.4——不匹配跳过，安装态可见）
    let seedOk = true;
    for (const [word, range] of Object.entries(row.seeds ?? {})) {
      const shell: string | undefined = (shellSeeds as Record<string, string | undefined>)[word];
      if (shell === undefined || !seedCompatible(shell, range)) {
        warnings.push(row.id + '：种子 ' + word + ' 区间不匹配（壳 ' + (shell ?? '缺席') + ' / 行 ' + range + '）');
        seedOk = false;
      }
    }
    if (!seedOk) continue;
    seen.add(row.id);
    kept.push(row);
  }
  // inject 点名缺席 = 降级跳过（§4.2——语义在装载层终结）
  const ids = new Set(kept.map((r) => r.id));
  const reachable: WireRowInput[] = [];
  for (const row of kept) {
    const missing = (row.inject ?? []).filter((dep) => !ids.has(dep));
    if (missing.length > 0) {
      warnings.push(row.id + '：inject 点名缺席 ' + missing.join(','));
      continue;
    }
    reachable.push(row);
  }
  // Kahn 拓扑排（稳定：剩余集内保持输入序；排不出的剩余成员 = 环，跳过）
  // 行数 = 通道包量级（~30），O(n²) 扫表可忽略——直白胜过邻接表。
  const done = new Set<string>();
  const ordered: WireRowInput[] = [];
  const depsOf = (r: WireRowInput): string[] => (r.inject ?? []).filter((d) => d !== r.id);
  for (;;) {
    const layer = reachable.filter((r) => !done.has(r.id)
      && depsOf(r).every((d) => done.has(d)));
    if (layer.length === 0) break;
    for (const r of layer) {
      done.add(r.id);
      ordered.push(r);
    }
  }
  for (const r of reachable) {
    if (!done.has(r.id)) warnings.push('inject 环：跳过 ' + r.id);
  }
  const rows: WireRow[] = ordered.map((r) => ({
    id: r.id,
    version: r.version,
    ...(r.entry !== undefined ? { entry: assetUrl(r.id, r.revision, r.entry) } : {}),
    ...(r.styles !== undefined && r.styles.length > 0 ? { styles: r.styles.map((s) => assetUrl(r.id, r.revision, s)) } : {}),
    ...(r.inject !== undefined && r.inject.length > 0 ? { inject: r.inject } : {}),
    seats: r.seats,
    isolated: r.isolated === true,
  }));
  const revOf = new Map(kept.map((k) => [k.id, k.revision]));
  const rev = fnv1a(rows.map((r) => r.id + '@' + (revOf.get(r.id) ?? '')).sort().join(';'));
  return { rev, rows, seeds: shellSeeds, warnings };
}
