// ============================================================
// subject.ts —— 主体指纹组合（R-7：主体 = boot 单元的生效行集内容）
//
// 入指纹 = 参与行集推导的一切（出身不问，内容寻址只看生效面）：
//   · identity —— AgentConfig（行集推导输入）
//   · catalog —— 行集目录（同上）
//   · 每行实现文件内容（行包目录盘面）
// 不入 = 运行时结构态 / 记忆 / 账本（数据归 D6 快照与数据轴）。
// 两侧同算法同参同根：宿主 verify 与壳 boot 自报共用本函数——
// 「两形态同源」（D3）从声明变为可检验断言。
// ============================================================

import { collectFiles } from './disk.ts';
import { entryDigest, subjectRoot } from './merkle.ts';
import type { EntryFingerprint, SubjectFingerprint } from './merkle.ts';

/** 主体身份件（虚拟行——config.json / row-catalog.json 的盘面形态） */
export interface SubjectInput {
  /** AgentConfig.json 内容 */
  configJson: string;
  /** row-catalog.json 内容 */
  catalogJson: string;
  /** 装配行 id → 行包目录绝对路径（盘面） */
  rows: Array<{ id: string; root: string }>;
  /** git 注释性伴随（缺席不失效） */
  gitNote?: string;
}

const CONFIG_ENTRY = 'agent-config';
const CATALOG_ENTRY = 'row-catalog';

/** 主体指纹（纯函数——盘上读行内容；两侧同调用） */
export function subjectFingerprint(input: SubjectInput): SubjectFingerprint {
  const entries: EntryFingerprint[] = [
    entryDigest(CONFIG_ENTRY, [{ path: './config.json', content: input.configJson }]),
    entryDigest(CATALOG_ENTRY, [{ path: './row-catalog.json', content: input.catalogJson }]),
  ];
  for (const row of input.rows) {
    entries.push(entryDigest(row.id, collectFiles(row.root)));
  }
  return subjectRoot(entries, input.gitNote);
}
