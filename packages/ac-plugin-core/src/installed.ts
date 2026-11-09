// ============================================================
// installed.ts —— installed.patch.yml 登记文档（cr-903 / cr-901 v2.1
// 批2 切片一 §4.3）
//
// <dataRoot>/profile/installed.patch.yml：安装器代写的第三方行登记
//（与基座源文档同方言：cordis-plugin-loader 官方条目数组）。行条目以
// name 定位插件（npm / link: 多物化形态——批 2 切片二落位层接入），
// owner 锚 = 行仅进 owner Agent 候选集；scope = 基座文档名（仅 insert
// 必填——host / webui / shell）。
//
// 批 2 双读窗口：plugin-rows.json 旧读路径并行存在——本模块只提供新
// 文档读写面，合流（installed 进目录派生）与旧路径退役随切片二/批 6。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

/** installed.patch.yml 内一条安装登记 */
export interface InstalledEntry {
  /** 登记行 id（基座文档内定位用——安装器代写，稳定） */
  id: string;
  /** 插件定位（npm 形态 = 包名；link/目录形态 = link:<路径>） */
  name: string;
  /** owner Agent（owner 锚：非 owner 壳不解析不装载；空 = 全体候选） */
  owner?: string;
  /** 目标基座文档名（词面 = 进程种类注册表；出厂三词 host/shell/webui） */
  scope?: string;
  /** 行配置（叠参数——各插件自读，框架不解释） */
  config?: Record<string, unknown>;
  /** 停用（custom 层可 disable——安装器透传用户意图） */
  disabled?: boolean;
}

/** 进程种类注册表读面（repo 声明式清单部署产物；缺席 = host/shell/webui） */
function readProcessKinds(dataRoot: string): string[] {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dataRoot, 'profile', 'processes.json'), 'utf-8')) as {
      processes?: Array<{ id?: unknown }>;
    };
    const ids = (doc.processes ?? []).map((p) => p.id).filter((id): id is string => typeof id === 'string');
    return ids.length > 0 ? ids : ['host', 'shell', 'webui'];
  } catch {
    return ['host', 'shell', 'webui'];
  }
}
/** installed.patch.yml 文档位 */
function installedDocFile(dataRoot: string): string {
  return path.join(dataRoot, 'profile', 'installed.patch.yml');
}

/**
 * 读 installed.patch.yml（缺席 = 空集；损坏/顶层非数组/条目缺 id·name →
 * throw——安装器代写文档，损坏 = 安装链断裂，fail-loud 不静默空集）。
 */
export function readInstalledDoc(dataRoot: string): InstalledEntry[] {
  const file = installedDocFile(dataRoot);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const data = yaml.load(text) as unknown;
  if (!Array.isArray(data)) {
    throw new Error('installed.patch.yml 顶层必须是条目数组：' + file);
  }
  const entries: InstalledEntry[] = [];
  for (const item of data) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('installed.patch.yml 条目必须是对象：' + file);
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== 'string' || obj.id === '' || typeof obj.name !== 'string' || obj.name === '') {
      throw new Error('installed.patch.yml 条目缺 id/name：' + file);
    }
    const scope = obj.scope;
    // scope 词 = 进程种类注册表（cr-910 §4.7：profile/processes.json 声明
    // 面单源；缺席回退三词内置——兼容未部署数据根）
    const known = readProcessKinds(dataRoot);
    if (scope !== undefined && (typeof scope !== 'string' || !known.includes(scope))) {
      throw new Error('installed.patch.yml 条目 scope 非法（注册表词：' + known.join('/') + '）：' + String(scope));
    }
    entries.push({
      id: obj.id,
      name: obj.name,
      ...(typeof obj.owner === 'string' && obj.owner !== '' ? { owner: obj.owner } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(obj.config !== null && typeof obj.config === 'object' && !Array.isArray(obj.config)
        ? { config: obj.config as Record<string, unknown> } : {}),
      ...(obj.disabled === true ? { disabled: true } : {}),
    });
  }
  return entries;
}

/**
 * 写 installed.patch.yml（原子换名；写者 = 安装器——三入口共享同一
 * 安装器，本文档恒单写者）。条目序保持传入序（追加式登记，审计可读）。
 */
export function writeInstalledDoc(dataRoot: string, entries: InstalledEntry[]): void {
  const file = installedDocFile(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = yaml.dump(entries.map((e) => ({
    id: e.id,
    name: e.name,
    ...(e.owner !== undefined ? { owner: e.owner } : {}),
    ...(e.scope !== undefined ? { scope: e.scope } : {}),
    ...(e.config !== undefined ? { config: e.config } : {}),
    ...(e.disabled === true ? { disabled: true } : {}),
  })), { lineWidth: 120, noRefs: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, '# 安装器代写（cr-903 / cr-901 v2.1 批2）——行定位 name + owner 锚；手改会被下次安装覆盖' + '\n' + body, 'utf-8');
  fs.renameSync(tmp, file);
}
