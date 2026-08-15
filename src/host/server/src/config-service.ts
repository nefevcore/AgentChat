// ============================================================
// ConfigService —— 全局配置服务（L4 门面）
//
// webui/TUI/Desktop 统一通过此服务访问全局配置、凭据，
// 而非直接穿透 @core/config、@agents/credential-store 等。
//
// 适配新架构：
//   · 旧 getGlobalConfig()（core/config 模块级单例）→ services/runtime 注入的
//     全局配置对象（L5 bootstrap initRuntime({ globalConfig })）。
//   · 旧 getAppState() 已移除（新架构无 AppState；运行时对象走 services/runtime）。
//   · 凭据：@agents/credential-store（getGlobalCredential / setCredential 等）。
//   · reloadGlobalConfig：重读 <workspaceRoot()>/config.json 并更新运行时配置。
//
// 依赖方向：services → agents/core（允许）；读文件为运行时可调能力（L4）。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { getGlobalConfig, setGlobalConfig } from './runtime';
import { getGlobalCredential, setGlobalCredential, setCredential } from '@agentchat/agents';
import { workspaceRoot } from '@agentchat/toolkit';
import { createLogger } from '@agentchat/util';

const log = createLogger('[services:config]');

/** 读取工作区 config.json（不存在返回 null） */
function loadConfigFile(wsRoot: string): Record<string, any> | null {
  const configPath = path.join(wsRoot, 'config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, any>;
  } catch (err: any) {
    log.warn(`读取全局配置失败: ${err?.message ?? String(err)}`);
    return null;
  }
}

/** 与 boot/loader.loadGlobalConfig 对齐的默认值（保存配置后不能丢） */
const CONFIG_DEFAULTS: Record<string, any> = {
  maxHops: 5,
  messageQueryDefaultLimit: 20,
  workspaceDir: 'workspace/default',
  agentsDir: '',
  sessionsDir: '',
  groupsDir: '',
  viewerId: 'user',
  llmProviders: {},
  searchProviders: {},
  allowedPaths: [],
  timezone: 'Asia/Shanghai',
  namespaces: {},
};

export class ConfigService {
  /** 获取全局配置 */
  getGlobalConfig(): Record<string, any> {
    return getGlobalConfig();
  }

  /**
   * 热重载全局配置：重读 <workspaceRoot()>/config.json 并更新运行时持有。
   * 注意：
   *   1. 原始 config.json 不含 workspaceDir/agentsDir/sessionsDir/groupsDir/
   *      viewerId 等默认值，直接覆盖会丢失（曾导致 chat~admin~undefined）；
   *      因此与 loadGlobalConfig 保持一致地合并默认值并派生路径。
   *   2. boot 的 AgentLoader/Assembly/PluginManager 都持有启动时的同一个
   *      globalConfig 对象引用；这里原地 mutate 该对象，保证全局配置保存后
   *      Agent 热重载能立刻解析到新 LLM 池。
   * @returns 重载后的配置（读取失败返回 null，保持原配置不变）
   */
  reloadGlobalConfig(): Record<string, any> | null {
    const raw = loadConfigFile(workspaceRoot());
    if (!raw) return null;

    // 默认值 → 文件覆盖 → 路径派生（与 loadGlobalConfig 一致）
    const cfg: Record<string, any> = {
      ...CONFIG_DEFAULTS,
      namespaces: { ...(CONFIG_DEFAULTS.namespaces as Record<string, unknown>) },
      ...raw,
    };
    const w = typeof raw.workspaceDir === 'string'
      ? (path.isAbsolute(raw.workspaceDir) ? raw.workspaceDir : path.resolve(process.cwd(), raw.workspaceDir))
      : workspaceRoot();
    cfg.workspaceDir = w;
    if (typeof cfg.agentsDir !== 'string' || !cfg.agentsDir) cfg.agentsDir = path.join(w, 'agents');
    if (typeof cfg.sessionsDir !== 'string' || !cfg.sessionsDir) cfg.sessionsDir = path.join(w, 'sessions');
    if (typeof cfg.groupsDir !== 'string' || !cfg.groupsDir) cfg.groupsDir = path.join(w, 'groups');

    // 原地更新，保持对象引用一致（AgentLoader/Assembly 已捕获该引用）
    const current = getGlobalConfig();
    for (const key of Object.keys(current)) {
      if (!(key in cfg)) delete current[key];
    }
    Object.assign(current, cfg);
    setGlobalConfig(current);
    log.info('全局配置已重载');
    return current;
  }

  /** 获取全局凭据（掩码处理除外由调用方自行决定） */
  getCredential(credId: string): string | undefined {
    const v = getGlobalCredential(credId);
    return v || undefined;
  }

  /** 设置 Agent 凭据（Agent 级：agentId + provider + value） */
  setAgentCredential(agentId: string, provider: string, value: string): void {
    setCredential(agentId, provider, value);
  }

  /** 设置全局凭据（credId + value） */
  setCredential(credId: string, value: string): void {
    setGlobalCredential(credId, value);
  }
}

/** 单例 */
export const configService = new ConfigService();
