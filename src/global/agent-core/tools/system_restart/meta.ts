import type { ConfigField } from '@discovery/config-types';

export const meta = {
  name: 'system_restart',
  label: '重启后端',
  description: '请求后端完全重启（Supervisor 模式自动拉起，WS 自动重连）。危险管理操作：触发后当前所有任务中断，几秒后自动恢复。',
  ns: 'tool.system_restart',
  configuration: [] as ConfigField[],
};
