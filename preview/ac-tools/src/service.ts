// ============================================================
// ac-tools/src/service.ts —— 工具注册中心（cordis Service）
//
// 本包同时是工具域契约的 owning package：域类型见 ./contract.ts，
// tool/* 事件目录见 ./events.ts（谁 emit 谁声明）。
//
// ctx.tools：fiber 归属注册 + 事件化执行链。
//   · register —— this.ctx 经 tracker 指向【调用方插件】，注册随其
//     卸载自动回收（effect 逆序执行）——工具行作者零 dispose 代码。
//   · execute —— tool/before-execute（waterfall：安全 veto / 参数改写）
//     → 工具体 → tool/after-execute（emit：审计/持久化/WS 广播订阅）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { ToolCall, ToolExecution, ToolDefinition, ToolResult, ToolTransform } from './contract.ts';

export class ToolsService extends Service {
  private defs = new Map<string, ToolDefinition>();

  constructor(ctx: Context) {
    super(ctx, 'tools');
  }

  /**
   * 注册工具（fiber 归属：随调用方插件卸载自动回收）。
   * @returns effect disposer（一般无需手动调用）
   */
  register(def: ToolDefinition) {
    if (!def.name) throw new Error('工具注册缺少 name');
    if (this.defs.has(def.name)) throw new Error(`工具 "${def.name}" 已注册`);
    return this.ctx.fiber.effect(() => {
      this.defs.set(def.name, def);
      return () => {
        this.defs.delete(def.name);
      };
    }, `tools.register(${def.name})`);
  }

  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name);
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.defs.values()];
  }

  /**
   * 事件化执行链：
   *   waterfall tool/before-execute（veto：不调 next；改写：变异 execution.call 后 next()）
   *   → 工具体 → waterfall tool/transform-result（变换/替换最终结果）
   *   → emit tool/after-execute（通知的是变换后的结果；error 非空 = 工具体抛错）。
   * 工具体抛错不向上传播，收敛为 { ok: false, error }。
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    const def = this.defs.get(call.name);
    if (!def) return { ok: false, error: `unknown tool: ${call.name}` };
    const execution: ToolExecution = { call };
    return this.ctx.waterfall('tool/before-execute', execution, async () => {
      const finalCall = execution.call; // 读取时机在拦截之后：改写生效
      // 中央接线（M7）：工具体调 onProgress → 逐片 emit tool/progress，
      // 再委托调用方自挂的回调。包装对象传入工具体（不改写调用方对象）。
      const wired: ToolCall = {
        ...finalCall,
        onProgress: (chunk: string) => {
          this.ctx.emit('tool/progress', finalCall, chunk);
          finalCall.onProgress?.(chunk);
        },
      };
      const started = Date.now();
      let result: ToolResult;
      let error: unknown;
      try {
        result = await def.execute(wired.args ?? {}, wired);
      } catch (err) {
        error = err;
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      // 变换链：工具体产出 → 变换器改写 payload.result → 最终回填值
      const payload: ToolTransform = { call: finalCall, result, durationMs: Date.now() - started };
      const final = await this.ctx.waterfall(
        'tool/transform-result',
        payload,
        async () => payload.result,
      );
      this.ctx.emit('tool/after-execute', finalCall, final, error);
      return final;
    });
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 工具注册中心（ac-tools 提供；各工具域行 inject 后注册） */
    tools: ToolsService;
  }
}
