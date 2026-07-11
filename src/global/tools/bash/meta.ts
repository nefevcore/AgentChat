import type { ConfigField } from '../../../discovery/config-types';

export const meta = {
  name: 'bash',
  label: '终端',
  description: '执行 Shell 命令',
  ns: 'tool.bash',
  configuration: [
    { name: 'defaultTimeout', label: '默认超时 (ms)', type: 'number', default: 30_000 },
    { name: 'maxTimeout', label: '最大超时 (ms)', type: 'number', default: 120_000 },
    { name: 'outputMaxLen', label: '输出最大长度', type: 'number', default: 50_000 },
    { name: 'maxBuffer', label: '最大缓冲区 (bytes)', type: 'number', default: 10 * 1024 * 1024 },
  ] as ConfigField[],
};
