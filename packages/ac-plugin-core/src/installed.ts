// ============================================================
// installed.ts —— installed.yml 登记文档（cr-903 / cr-901 v2.1 批2
// 切片一 §4.3 / cr-1004 文件族改名 + scope 退役）
//
// <dataRoot>/profile/installed.yml：安装器代写的第三方行登记（与基座
// 源文档同方言：cordis-plugin-loader 官方条目数组）。行条目以 name 定位
// 插件（npm / link: 多物化形态）；owner 锚 = 行仅进 owner Agent 候选集。
// **登记的是事实，适配是求值**（cr-1004 §三）：无 scope 投影字段——
// 各基座求值器反向分析包 face 声明（ac-rowset-core fitInstalledRows）。
//
// 唯一装载输入：cr-908 批6 装配菜单合流后即单源；plugin-rows.json 旧读
// 路径已退役（cr-1001）；旧文件名 installed.patch.yml 读侧兼容（首次
// 写新名即消亡）。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

/** installed.yml 内一条安装登记 */
export interface InstalledEntry {
  /** 登记行 id（基座文档内定位用——安装器代写，稳定） */
  id: string;
  /** 插件定位（npm 形态 = 包名；link/目录形态 = link:<路径>） */
  name: string;
  /** owner Agent（owner 锚：非 owner 壳不解析不装载；空 = 全体候选） */
  owner?: string;
  /** 行配置（叠参数——各插件自读，框架不解释） */
  config?: Record<string, unknown>;
  /** 停用（custom 层可 disable——安装器透传用户意图） */
  disabled?: boolean;
}

/** installed.yml 文档位（旧名 installed.patch.yml 只读兼容——安装器单写者
 * 首次写新名即消亡） */
function installedDocFile(dataRoot: string): string {
  return path.join(dataRoot, 'profile', 'installed.yml');
}
function legacyInstalledDocFile(dataRoot: string): string {
  return path.join(dataRoot, 'profile', 'installed.patch.yml');
}

/**
 * 读 installed.yml（缺席 = 空集；损坏/顶层非数组/条目缺 id·name →
 * throw——安装器代写文档，损坏 = 安装链断裂，fail-loud 不静默空集）。
 */
export function readInstalledDoc(dataRoot: string): InstalledEntry[] {
  let file = installedDocFile(dataRoot);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    file = legacyInstalledDocFile(dataRoot);
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      return [];
    }
  }
  const data = yaml.load(text) as unknown;
  if (!Array.isArray(data)) {
    throw new Error('installed.yml 顶层必须是条目数组：' + file);
  }
  const entries: InstalledEntry[] = [];
  for (const item of data) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('installed.yml 条目必须是对象：' + file);
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== 'string' || obj.id === '' || typeof obj.name !== 'string' || obj.name === '') {
      throw new Error('installed.yml 条目缺 id/name：' + file);
    }
    entries.push({
      id: obj.id,
      name: obj.name,
      ...(typeof obj.owner === 'string' && obj.owner !== '' ? { owner: obj.owner } : {}),
      // 存量 scope 字段容忍读取、不再投影（cr-1004：适配是求值非登记）
      ...(obj.config !== null && typeof obj.config === 'object' && !Array.isArray(obj.config)
        ? { config: obj.config as Record<string, unknown> } : {}),
      ...(obj.disabled === true ? { disabled: true } : {}),
    });
  }
  return entries;
}

/**
 * 写 installed.yml（原子换名；写者 = 安装器——三入口共享同一
 * 安装器，本文档恒单写者）。条目序保持传入序（追加式登记，审计可读）。
 */
export function writeInstalledDoc(dataRoot: string, entries: InstalledEntry[]): void {
  const file = installedDocFile(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = yaml.dump(entries.map((e) => ({
    id: e.id,
    name: e.name,
    ...(e.owner !== undefined ? { owner: e.owner } : {}),
    ...(e.config !== undefined ? { config: e.config } : {}),
    ...(e.disabled === true ? { disabled: true } : {}),
  })), { lineWidth: 120, noRefs: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, '# 安装器代写（cr-903 / cr-1004）——行定位 name + owner 锚；适配分析在基座求值器（scope 已退役）；手改会被下次安装覆盖' + String.fromCharCode(10) + body, 'utf-8');
  fs.renameSync(tmp, file);
  // 旧名副本清除（改名收敛——单写者域，无歧义窗口）
  const legacy = legacyInstalledDocFile(dataRoot);
  if (fs.existsSync(legacy)) fs.rmSync(legacy, { force: true });
}
