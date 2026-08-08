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
import { getGlobalCredential, setGlobalCredential, setCredential } from '@agents/credential-store';
import { workspaceRoot } from '@plugins/builtin/tools/shared';
import { createLogger } from '@core/logger';

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

export class ConfigService {
  /** 获取全局配置 */
  getGlobalConfig(): Record<string, any> {
    return getGlobalConfig();
  }

  /**
   * 热重载全局配置：重读 <workspaceRoot()>/config.json 并更新运行时持有。
   * @returns 重载后的配置（读取失败返回 null，保持原配置不变）
   */
  reloadGlobalConfig(): Record<string, any> | null {
    const cfg = loadConfigFile(workspaceRoot());
    if (cfg) {
      setGlobalConfig(cfg);
      log.info('全局配置已重载');
    }
    return cfg;
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
