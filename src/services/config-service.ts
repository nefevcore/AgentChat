// ============================================================
// ConfigService —— 全局配置服务（v0.5.0 P3）
//
// webui/TUI/Desktop 统一通过此服务访问全局配置、凭据、
// 应用状态，而非直接穿透 @core/config、@infra/credential-store 等。
// ============================================================

import { getGlobalConfig, reloadGlobalConfig } from '@core/config';
import { getGlobalCredential, setGlobalCredential, setCredential } from '@infra/credential-store';
import { getAppState } from '@core/app-state';

export class ConfigService {
  /** 获取全局配置 */
  getGlobalConfig() {
    return getGlobalConfig();
  }

  /** 热重载全局配置 */
  reloadGlobalConfig() {
    return reloadGlobalConfig();
  }

  /** 获取全局凭据（掩码处理除外由调用方自行决定） */
  getCredential(credId: string): string | undefined {
    return getGlobalCredential(credId);
  }

  /** 设置 Agent 凭据（Agent 级：agentId + provider + value） */
  setAgentCredential(agentId: string, provider: string, value: string): void {
    setCredential(agentId, provider, value);
  }

  /** 设置全局凭据（credId + value） */
  setCredential(credId: string, value: string): void {
    setGlobalCredential(credId, value);
  }

  /** 获取应用运行时状态 */
  getAppState() {
    return getAppState();
  }
}

/** 单例 */
export const configService = new ConfigService();
