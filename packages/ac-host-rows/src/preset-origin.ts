// ============================================================
// preset-origin.ts —— 预设模板升级通路（cr-812 copy-on-write）
//
// 物化记 origin（agents/<id>/preset-origin.json）：
//   { template: 模板键, hash: 模板指纹, configHash: 物化 config 指纹,
//     docs: { 文档名: 内容指纹 } }
// 升级判定（reconcilePresetOrigin，宿主 boot 每启执行）：
//   · origin 缺席（机制前物化/用户手建）→ 补记现状为基线（不回写内容）
//   · 模板指纹未变 → noop
//   · 模板指纹已变：config/docs 逐项「活体 == origin 所记指纹」= 未编辑
//     → 跟随新版；否则保留 + 提示（用户数据优先）
// 指纹 = sha256 前 16 hex；模板指纹 = config 规范序列化 + docs 逐名内容。
// 纯库零 cordis 依赖：宿主 boot / 测试直接消费。
// ============================================================
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentDir, type AgentConfig } from 'ac-agents-core';
import { readTemplate, materializeConfigOf } from './preset-builtin.ts';

/** origin 记录形状（agents/<id>/preset-origin.json） */
export interface PresetOrigin {
  /** 模板键（如 creator） */
  template: string;
  /** 物化时模板指纹（config+docs） */
  hash: string;
  /** 物化时 config 指纹（升级判「config 是否被编辑」） */
  configHash?: string;
  /** 物化时文档逐名内容指纹（升级判「文档是否被编辑」） */
  docs?: Record<string, string>;
}

/** 预设身份词形（__<template_key>__ = 内置模板键） */
export const PRESET_ID = /^__([a-z0-9-]+)__$/;

/** 内容指纹（sha256 前 16 hex） */
export function fingerprintOf(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** 模板指纹：config 规范序列化 + docs 逐名内容 */
export function templateFingerprint(template: { config: unknown; docs?: Array<{ name: string; content: string }> | undefined }): string {
  const parts = [JSON.stringify(template.config), ...(template.docs ?? []).map((d) => d.name + '\u0000' + d.content)];
  return fingerprintOf(parts.join('\u0001'));
}

/** 物化形态 origin 合成（config + docs 全量指纹） */
export function originOf(templateKey: string, hash: string, config: AgentConfig, docs: Array<{ name: string; content: string }>): PresetOrigin {
  return {
    template: templateKey,
    hash,
    configHash: fingerprintOf(JSON.stringify(config)),
    ...(docs.length > 0 ? { docs: Object.fromEntries(docs.map((d) => [d.name, fingerprintOf(d.content)])) } : {}),
  };
}

/** 读 origin（缺席/损坏 = undefined） */
export function readOrigin(dataRoot: string, agentId: string): PresetOrigin | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(originFile(dataRoot, agentId), 'utf-8')) as PresetOrigin;
    return typeof parsed.template === 'string' && typeof parsed.hash === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 写 origin（原子写） */
export function writeOrigin(dataRoot: string, agentId: string, origin: PresetOrigin): void {
  const file = originFile(dataRoot, agentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(origin, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

function originFile(dataRoot: string, agentId: string): string {
  return path.join(agentDir(dataRoot, agentId), 'preset-origin.json');
}

/**
 * 单身份 copy-on-write 升级判定（纯函数不落盘——宿主 boot 执行返回动作）。
 * 活体读面由调用方传入：liveConfig（config.json 解析体，缺席 = null）、
 * liveDocs（盘上 .md 文档逐名内容）。返回：
 *   baseline —— origin 缺席，补记现状（nextOrigin 即基线指纹）
 *   noop —— 模板指纹未变 / 模板键不匹配 / 模板缺席，无事可做
 *   follow —— 未编辑项跟随新版（config 重物化 + overwriteDocs 清单 + 新 origin）
 *   notice —— 模板已变但物化体被编辑，保留现状（附逐项提示，供日志/UI）
 */
export type ReconcileResult =
  | { baseline: PresetOrigin }
  | { noop: true }
  | { follow: { config: AgentConfig; overwriteDocs: Array<{ name: string; content: string }>; nextOrigin: PresetOrigin } }
  | { notice: string };

export function reconcilePresetOrigin(input: {
  agentId: string;
  templateKey: string;
  liveConfig: AgentConfig | null;
  liveDocs: Record<string, string>;
  origin: PresetOrigin | undefined;
  currentTemplate: { config: AgentConfig; docs?: Array<{ name: string; content: string }> | undefined } | undefined;
}): ReconcileResult {
  const { agentId, templateKey, liveConfig, liveDocs, origin, currentTemplate } = input;
  if (currentTemplate === undefined) return { noop: true };
  const currentHash = templateFingerprint(currentTemplate);
  if (origin === undefined) {
    // 机制前物化/用户手建：现状即基线（不回写内容）
    if (liveConfig === null) return { noop: true };
    return { baseline: originOf(templateKey, currentHash, liveConfig, Object.entries(liveDocs).map(([name, content]) => ({ name, content }))) };
  }
  if (origin.template !== templateKey || origin.hash === currentHash) return { noop: true };
  const notices: string[] = [];
  // config 判定：活体 == origin 所记物化指纹 → 未编辑 → 跟随重物化
  let nextConfig: AgentConfig | null = null;
  if (liveConfig === null) {
    notices.push('config 缺席，按模板重建');
    nextConfig = materializeConfigOf(currentTemplate.config, agentId);
  } else if (origin.configHash === undefined || fingerprintOf(JSON.stringify(liveConfig)) === origin.configHash) {
    nextConfig = materializeConfigOf(currentTemplate.config, agentId);
  } else {
    notices.push('config 已被编辑，保留现状');
  }
  // docs 判定：活体缺席（模板新增文档）→ 跟随落地；在场且 == origin 所记
  // 指纹 → 未编辑跟随；在场但 origin 未记（用户自建同名）→ 保留；否则已编辑保留
  const overwriteDocs: Array<{ name: string; content: string }> = [];
  for (const doc of currentTemplate.docs ?? []) {
    const originDoc = origin.docs?.[doc.name];
    if (!(doc.name in liveDocs)) {
      overwriteDocs.push(doc);
    } else if (originDoc === undefined) {
      notices.push(`文档 ${doc.name} 在 origin 未记录，保留现状`);
    } else if (fingerprintOf(liveDocs[doc.name]) === originDoc) {
      overwriteDocs.push(doc);
    } else {
      notices.push(`文档 ${doc.name} 已被编辑，保留现状`);
    }
  }
  if (notices.length > 0) return { notice: `${agentId}：模板新版就绪（${notices.join('；')}）` };
  if (nextConfig === null) return { noop: true };
  return {
    follow: {
      config: nextConfig,
      overwriteDocs,
      nextOrigin: originOf(templateKey, currentHash, nextConfig, overwriteDocs),
    },
  };
}
