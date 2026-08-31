// ============================================================
// ac-hello —— 链路验证插件（最小完整样例）
//
// 演示薄行的全部第一性原语：
//   · inject 声明依赖（ctx.tools 由 ac-tools 提供）
//   · apply 内注册工具 —— fiber 归属，本行卸载自动消失
//   · ctx.on 订阅事件 —— 同样随本行卸载自动撤销
// ============================================================
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-tools'; // ctx.tools 服务类型 + tool/* 事件目录增强

export const name = 'ac-hello';
export const inject = ['tools'];

export function apply(ctx: Context) {
  ctx.logger('ac-hello').info('链路验证插件已挂载（hello 工具 + tool/after-execute 订阅）');

  // 注册即归属：本行卸载时 hello 工具自动消失（无需 dispose 代码）
  ctx.tools.register({
    name: 'hello',
    description: '链路验证工具：回显消息',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: '要回显的内容' } },
      required: ['message'],
    },
    execute: (args) => ({ ok: true, output: `hello: ${String(args.message ?? '(空)')}` }),
  });

  // 订阅即归属：本行卸载时监听器自动撤销
  ctx.on('tool/after-execute', (call, result) => {
    ctx.logger('ac-hello').debug(`tool ${call.name} → ok=${result.ok}`);
  }, { description: '链路验证：hello 工具执行通知' });
}
