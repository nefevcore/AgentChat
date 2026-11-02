// ============================================================
// preset-builtin.ts —— 内置模板读面（cr-540；行集清单 R1「preset-builtin」
// 改造落地）
//
// 裁决簿〈注册表解体〉：内置模板 = 包目录下的静态 Agent 配置文件集，
// 编辑面 create-from-template 直读，无独立承载机制——本文件即读面
//（零 cordis 依赖纯函数）。模板住 templates/<模板键>/：
//   config.json   AgentConfig（身份全量；行集引用词形——tag 词已退役）
//   meta.json     模板元数据（label/description/order/default——产品面）
//   <NAME>.md     模板自带文档（cr-810 人设载体：settings.persona.file 指
//                 向裸文档名，物化时随 config 落地 agents/<id>/）
//
// 行缺席（行集无 preset-builtin）= 模板面不可用：agents 编辑面按良定义
// 降级（身份 CRUD 照常，create-from-template / transient 合成报不可用）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentConfig } from 'ac-agents-core';

/** 内置模板目录（本包 templates/——静态配置集单源） */
export const TEMPLATE_DIR = fileURLToPath(new URL('../templates', import.meta.url));

/** 文档名词法（单词 .md 文件名——禁路径分隔/遍历；agents-row 文档写口同源单源） */
export const DOC_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/i;

/** 模板自带文档（cr-810：人设等 .md 实体随物化落地 agents/<id>/） */
export interface TemplateDoc {
  /** 文档名（如 AGENTS.md） */
  name: string;
  content: string;
}

/** 模板 = 元数据 + 身份配置（创建时物化为真实身份，preset 标志剥除） */
export interface AgentTemplate {
  /** 模板键（= 目录名，如 standard / dsh-minimal / creator） */
  id: string;
  label: string;
  description?: string;
  order?: number;
  /** 缺省模板标志（唯一——目录内至多一个） */
  default?: boolean;
  config: AgentConfig;
  /** 模板目录自带 .md 文档（词法同 DOC_NAME；空 = 无文档模板） */
  docs?: TemplateDoc[];
}

/** 模板清单（缺省目录按 order 再按 id 排序；目录缺席 = 空表） */
export function listTemplates(dir: string = TEMPLATE_DIR): AgentTemplate[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: AgentTemplate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const template = readTemplateAt(dir, entry.name);
    if (template !== undefined) out.push(template);
  }
  return out.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
    || (a.id < b.id ? -1 : 1));
}

/** 单模板读取（未知/词法非法模板键 = undefined——调用方按「模板不存在」处理） */
export function readTemplate(id: string, dir: string = TEMPLATE_DIR): AgentTemplate | undefined {
  if (id.length === 0 || /[/\\]/.test(id) || id === '.' || id === '..') return undefined;
  return readTemplateAt(dir, id);
}

/**
 * 模板 config → 物化身份 config：剥 preset 标志与模板自身 id、改写目标 id
 * （创建物/预设物化同口径——cr-811 三处并源：adoptShell / agents-row /
 * preset-origin reconcile）。
 */
export function materializeConfigOf(templateConfig: AgentConfig, agentId: string): AgentConfig {
  const { preset: _preset, id: _templateId, ...body } = templateConfig;
  return { ...body, id: agentId };
}

/** 目录内单模板读取（config.json 必需且须含 id；meta.json 可缺省） */
function readTemplateAt(dir: string, key: string): AgentTemplate | undefined {
  const config = readJson<AgentConfig>(path.join(dir, key, 'config.json'));
  if (config === undefined || typeof config.id !== 'string' || config.id === '') return undefined;
  const meta = readJson<TemplateMetaFile>(path.join(dir, key, 'meta.json')) ?? {};
  const out: AgentTemplate = { id: key, label: meta.label ?? config.name ?? key, config };
  const description = meta.description ?? config.description;
  if (description !== undefined) out.description = description;
  if (meta.order !== undefined) out.order = meta.order;
  if (meta.default === true) out.default = true;
  const docs = readTemplateDocs(path.join(dir, key));
  if (docs.length > 0) out.docs = docs;
  return out;
}

/** 模板目录 .md 文档清单（词法闸 DOC_NAME 单源——非 .md/词法非法名静默排除） */
function readTemplateDocs(dir: string): TemplateDoc[] {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: TemplateDoc[] = [];
  for (const entry of names) {
    if (!entry.isFile() || DOC_NAME.test(entry.name) !== true) continue;
    const content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
    if (content.trim()) out.push({ name: entry.name, content });
  }
  return out;
}

/** meta.json 磁盘形状（产品面元数据——非身份契约的一部分） */
interface TemplateMetaFile {
  label?: string;
  description?: string;
  order?: number;
  default?: boolean;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}
