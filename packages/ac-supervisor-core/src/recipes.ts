// ============================================================
// recipes.ts —— 配方盘面（supervisor-service-plan §五.1，cr-859）
//
// dataRoot/.runtime/recipes/*.json = 拉起任何进程级对象的盘面知识
// （boot 命令 / 监护策略 / resident|on-demand / owner / mode）。填
// cr-648 监护真空：壳的重启知识（argv）此前只在宿主内存，宿主换代后
// 老壳只回登记不接管——配方落盘后任何活进程（system 缺席降级时）
// 按盘面执行恢复（§三「监护权威与恢复执行分离」）。
//
// 形态约定（§五.1）：
//   · 一个配方一个 json 文件，id 即文件名主干（唯一性由文件系统保证）；
//   · 原子写（tmp + rename）——读者永不见半文；
//   · 读侧容错：单文件坏/非 json 跳过（盘面退化 = 该配方缺席，不炸读者
//     ——恢复执行者读配方失败时自然回落到自己的 argv 知识）。
// ============================================================
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 配方（拉起一个进程级对象的全部盘面知识） */
export interface Recipe {
  /** 配方 id（= 文件名主干）：host / shell:<agentId> / router（§五.4 并入时） */
  id: string;
  /** boot 命令行（exe + args——恢复执行者直接 spawn） */
  boot: { cmd: string; args: string[] };
  /** 监护策略语义（resident 配崩溃监护 / on-demand 配业务监护——§一） */
  policy?: 'crash' | 'business';
  /** resident（常驻）| on-demand（按需生灭——来件拉起） */
  residency: 'resident' | 'on-demand';
  /** 常态监护执行者（supervisor——§五.4 router 并入时移交 system） */
  owner: 'supervisor';
  /** authoritative（执行）| shadow（只记录决策不执行——§二.2 升级形态） */
  mode?: 'authoritative' | 'shadow';
  /** 写入时刻（ISO——诊断对账用） */
  writtenAt: string;
}

/** 配方目录路径（<dataRoot>/.runtime/recipes） */
export function recipesDir(dataRoot: string): string {
  return join(dataRoot, '.runtime', 'recipes');
}

/** id ↔ 文件名编码：文件名 = encodeURIComponent(id)——冒号（NTFS ADS
 * 语法，rename EINVAL）等特殊字符安全落地；id 值仍保留规约原形
 * （host / shell:<agentId>——§五.1）。 */
function idToFileName(id: string): string {
  return encodeURIComponent(id) + '.json';
}

/** 配方文件路径（id 带路径分隔符 / .. 时抛错——id 即文件名，防穿越） */
export function recipePath(dataRoot: string, id: string): string {
  if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error('recipe id 非法（空/含路径段）: ' + id);
  }
  return join(recipesDir(dataRoot), idToFileName(id));
}

/** 校验并窄化为 Recipe（坏形状返回 null——读侧容错）。
 * 逐字段以 unknown 视图校验（不经 Partial 断言——盘面文件是外部输入，
 * 运行时校验不得被编译期类型窄化稀释）。 */
function asRecipe(parsed: unknown): Recipe | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '') return null;
  const boot = r.boot as Record<string, unknown> | undefined;
  if (typeof boot?.cmd !== 'string' || !Array.isArray(boot.args)
    || boot.args.some((a) => typeof a !== 'string')) return null;
  if (r.residency !== 'resident' && r.residency !== 'on-demand') return null;
  if (r.owner !== 'supervisor') return null;
  if (r.policy !== undefined && r.policy !== 'crash' && r.policy !== 'business') return null;
  if (r.mode !== undefined && r.mode !== 'authoritative' && r.mode !== 'shadow') return null;
  return {
    id: r.id,
    boot: boot as { cmd: string; args: string[] },
    policy: r.policy as Recipe['policy'],
    residency: r.residency,
    owner: r.owner,
    mode: r.mode as Recipe['mode'],
    writtenAt: typeof r.writtenAt === 'string' ? r.writtenAt : '',
  };
}

/** 原子写一个配方（tmp + rename；id 非法抛错——写侧 fail-loud） */
export function writeRecipe(dataRoot: string, recipe: Recipe): void {
  const target = recipePath(dataRoot, recipe.id);
  mkdirSync(recipesDir(dataRoot), { recursive: true });
  const tmp = target + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(recipe, null, 2), 'utf-8');
  renameSync(tmp, target);
}

/** 读全部配方（目录缺席/空 = 空数组；单文件坏 = 跳过） */
export function readRecipes(dataRoot: string): Recipe[] {
  let files: string[];
  try {
    files = readdirSync(recipesDir(dataRoot));
  } catch {
    return []; // 目录不存在（system 从未运行或新数据根）
  }
  const out: Recipe[] = [];
  for (const name of files) {
    if (!name.endsWith('.json') || name.includes('.tmp-')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(recipesDir(dataRoot), name), 'utf-8'));
    } catch {
      continue; // 坏文件跳过——盘面退化不炸读者
    }
    const recipe = asRecipe(parsed);
    // id 与文件名解码一致（写侧规约）——防手工放错文件名的伪配方
    if (recipe !== null) {
      let decoded: string;
      try { decoded = decodeURIComponent(name.slice(0, -'.json'.length)); } catch { continue; }
      if (decoded === recipe.id) out.push(recipe);
    }
  }
  return out;
}

/** 读单个配方（缺席/坏 = null） */
export function readRecipe(dataRoot: string, id: string): Recipe | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recipePath(dataRoot, id), 'utf-8'));
  } catch {
    return null;
  }
  return asRecipe(parsed);
}

/** 删除配方（对象退场——幂等，缺席不抛） */
export function removeRecipe(dataRoot: string, id: string): void {
  rmSync(recipePath(dataRoot, id), { force: true });
}
