import type { ConfigField } from '@core/types';

export const meta = {
  name: 'continue_turn',
  label: '继续推理',
  description: '触发自己基于当前会话上下文立即开始下一轮推理（自我 steer）。长回复被截断或需要继续深入时调用，当前回合结束后自动续推。',
  ns: 'tool.continue_turn',
  configuration: [] as ConfigField[],
};
