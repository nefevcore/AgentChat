// ============================================================
// persona 解析词法（2026-10-10 cr-321 自 ac-persona 下沉，行为字节不变）
//
// 收录判据：ac-singles 前缀快照修订键（M21/D5）须与 ac-persona 装配行
// 逐字节同口径复算 persona 终态——口径漂移 = KV 前缀快照静默失效；与
// normalizeToolSpecs（cr-318）同构的跨行词法协议单源。
//
// 人设来源（settings[具名]，M14 形状升级；M24 X1 hooks→settings 收口）：
//   · settings['persona'] = string           兼容旧形状（内联文本）
//   · settings['persona'] = { text?, file? } file 优先（本地实体覆盖）、
//     text 回退（内联）；enabled=false 软停用
// file 解析：裸文件名（如 'AGENTS.md'）→ agentStore 的 Agent 文档
// （可选能力：store 未传则跳过该路径）；带分隔符路径 → 相对 cwd 的
// 文件系统路径。persona 文档双名同义（2026-09-16 对齐生态事实标准
// AGENTS.md）：读时 AGENTS.md 优先、AGENT.md（存量名）回退，写口归一
// 写 AGENTS.md。读取后剥离 YAML frontmatter（src tryLoadFile 同规则）。
// 均无 → undefined（不注入）。
//
// 零 cordis 依赖：agentStore 以最小结构形状 PersonaDocStore 入参，
// 不 import 服务类型。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** settings['persona'] 对象形状（per-Agent；形状由 persona 域自定义） */
export interface PersonaSettings {
  /** 缺省 true；false = 本 Agent 软停用（ADR-4） */
  enabled?: boolean;
  /** 内联人设文本 */
  text?: string;
  /** 人设文件：裸名 → agentStore 文档（AGENTS.md/AGENT.md 同义）；带路径 → 文件系统 */
  file?: string;
}

/** agentStore 文档读口的最小结构形状（可选能力：未装/未传 = undefined） */
export interface PersonaDocStore {
  readDoc(agentId: string, name: string): string | undefined;
}

/** 剥离 YAML frontmatter + trim（src tryLoadFile 同规则） */
function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n*/, '').trim();
}

/** 读取文件系统路径（缺失/不可读 → null） */
function readFsFile(file: string): string | null {
  try {
    const content = fs.readFileSync(path.resolve(file), 'utf-8');
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

/**
 * persona 裸文档名候选（双名同义，2026-09-16 对齐生态事实标准）：
 * AGENTS.md 优先、AGENT.md（存量名）回退——不论配置写哪个名，读序一致
 * （写口归一写 AGENTS.md，读序保证保存后新名即时生效、旧名不遮蔽）。
 * 其他裸名（如 'SYSTEM.md'）原样单候选。
 */
function personaDocCandidates(file: string): string[] {
  const lower = file.toLowerCase();
  return lower === 'agents.md' || lower === 'agent.md' ? ['AGENTS.md', 'AGENT.md'] : [file];
}

/**
 * 解析人设文本：file 优先（目录实体本地覆盖）→ text 回退（内联）。
 * 返回 undefined = 无人设（不注入）。store 仅对「裸文档名 + agentId
 * 齐备」生效——路径形态 = 本地文件系统覆盖，不走目录实体；agentId
 * 缺省（直连 loop）同样只走文件系统/回退。
 */
export function resolvePersonaText(
  store: PersonaDocStore | undefined | null,
  agentId: string | undefined,
  cfg: unknown,
): string | undefined {
  if (typeof cfg === 'string') return cfg.trim() || undefined;
  if (cfg === null || cfg === undefined || typeof cfg !== 'object') return undefined;
  const settings = cfg as PersonaSettings;
  if (settings.enabled === false) return undefined;

  if (typeof settings.file === 'string' && settings.file.trim()) {
    const file = settings.file.trim();
    // 裸文档名（无路径分隔/无遍历）→ agentStore 的 Agent 文档（可选能力）；
    // 双名同义时逐候选名解析：store 文档 → 文件系统路径，先到先得，
    // 内容 strip 后为空视同未命中（继续下一候选 / 回退 text）。
    const bare = !file.includes('/') && !file.includes('\\') && !file.includes('..');
    const candidates = bare ? personaDocCandidates(file) : [file];
    const docStore = bare && agentId ? store : undefined;
    for (const name of candidates) {
      let content: string | null = null;
      if (docStore && agentId) {
        const doc = docStore.readDoc(agentId, name);
        content = doc && doc.trim() ? doc : null;
      }
      if (content === null) content = readFsFile(name);
      if (content !== null) {
        const stripped = stripFrontmatter(content);
        if (stripped) return stripped;
      }
    }
  }
  if (typeof settings.text === 'string' && settings.text.trim()) return settings.text.trim();
  return undefined;
}
