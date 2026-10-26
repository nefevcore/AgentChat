// ============================================================
// provider 薄行模板（M23 §3.7）——复制到 <数据根>/files/<agentId>/<name>/ 后：
//   1. 全局替换 PLACEHOLDER-AGENTID 为你的 Agent id；
//   2. 填 BASE_URL / 模型清单 / 密钥环境变量名；
//   3. install_plugin 安装。
//
// 模板规约：
//   · 命名：<agentId>-<name> 前缀规约——内置 provider 名（openai/deepseek/
//     glm）是保留字，撞名 = 装载管道可诊断拒绝（F13/G1）；
//   · contracts 必填（manifest）：宿主契约不兼容时装不上（fail-closed）；
//   · 协议住纯库：OpenAI 兼容平台不要新写协议，复用 ac-openai-completions
//     换 baseUrl；薄行只留工厂注册胶水；
//   · 选用在数据面：装载即供给，AgentConfig.provider/model 选用——
//     per-Agent 生效不经装载层；
//   · 密钥：不落 manifest（会被 staging 复制进插件库）——运行时从
//     process.env 读；
//   · 迭代语义：改动必 bump version 重装（同 hash 幂等不重试装载）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { OpenAICompletions } from 'ac-openai-completions';

const BASE_URL = 'https://api.example.com/v1';
const API_KEY_ENV = 'EXAMPLE_API_KEY';

export function apply(ctx: Context) {
  ctx.llm.register(
    'PLACEHOLDER-AGENTID-my-provider',
    () =>
      new OpenAICompletions({
        baseUrl: BASE_URL,
        apiKey: process.env[API_KEY_ENV] ?? '',
      }),
    {
      models: ['example-model-1', 'example-model-2'], // model 路由清单：精确 > 前缀
      description: 'Example 平台 OpenAI 兼容适配（密钥读 env）',
    },
  );
}
