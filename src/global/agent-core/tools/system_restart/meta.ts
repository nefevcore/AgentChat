import type { ConfigField } from '@discovery/config-types';

export const meta = {
  name: 'system_restart',
  label: '重启后端',
  description: '请求后端完全重启（Supervisor 模式自动拉起，WS 自动重连）。危险管理操作：仅 Supervisor 模式注入，非 Supervisor 模式不可用。',
  ns: 'tool.system_restart',
  configuration: [] as ConfigField[],
};
