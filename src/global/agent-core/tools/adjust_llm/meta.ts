export const meta = {
  name: 'adjust_llm',
  label: '调节LLM强度',
  description: '调节自身 LLM 参数（温度/深度思考/最大输出），灵活控制推理强度与成本。任务难时提升强度（开 thinking、温度 0），闲聊/简单任务降低强度省 token（关 thinking、温度 0.8）。persist=true 时写入配置（重启后仍生效）。',
  ns: 'tool.adjust_llm',
};
