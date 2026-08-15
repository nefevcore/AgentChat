// @agentchat/hello —— preview 链路验证插件（函数形态）
// 演示：cordis 4 插件三要素 —— 具名导出 apply(ctx, config) + Schemastery 配置校验。
import type { Context } from '@agentchat/cordis';
import Schema from '@agentchat/schemastery';

export const name = 'hello';

export interface Config {
  greeting: string;
  targets: string[];
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  targets: Schema.array(String).default(['agentchat']),
});

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('hello');
  for (const target of config.targets) {
    const line = `${config.greeting}, ${target}!`;
    console.log(line);
    logger.info(line);
  }
}
