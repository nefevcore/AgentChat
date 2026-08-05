import type { ConfigField } from '@discovery/config-types';

export const meta = {
  name: 'ask_user',
  label: '询问用户',
  description: '向用户提出一个问题并提供选项，等待用户选择后继续。适用于需要用户决策/确认的场景（如二选一、确认执行、选择方向）。用户不响应时默认超时（120s）返回超时。',
  ns: 'tool.ask_user',
  configuration: [] as ConfigField[],
};
