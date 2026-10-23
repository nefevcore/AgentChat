// ============================================================
// preset-builtin.ts —— 内置模板读面（cr-540；行集清单 R1「preset-builtin」
// 改造落地）
//
// 裁决簿〈注册表解体〉：内置模板 = 包目录下的静态 Agent 配置文件集，
// 编辑面 create-from-template 直读，无独立承载机制——本文件即读面
//（零 cordis 依赖纯函数）。模板住 templates/<模板键>/：
//   config.json   AgentConfig（身份全量；行集引用词形——tag 词已退役）
//   meta.json     模板元数据（label/description/order/default——产品面）
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
