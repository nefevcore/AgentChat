// ============================================================
// ac-client-runtime/src/objects.ts —— 层 2 对象层骨架（M27 S0，§0.3）
//
// 跨切只读身份面（名册 agents/presets、会话索引、工作区清单）的
// 运行时对象层：多基础件共读的数据住这里，由 webui/src/api/ 各远程
// 模块喂养（重构后经 runtime 喂养）、客户端服务面暴露（ctx.roster
// 等，S2 起逐域生长）；域插件与基础件一律 inject 消费。
//
// 机制骨架：key → 对象，define 经调用方 fiber effect（拥有者卸载即
// 撤——不残留全局单例）。响应式由喂养方选择（vue reactive 等策略
// 归数据面，本层不绑框架）。读写纪律见 §0.3：跨域读走 inject 服务
// 面；管理/写面仍归域插件。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';

export class ObjectsService extends Service {
  private objects = new Map<string, object>();

  constructor(ctx: Context) {
    super(ctx, 'objects');
  }

  /**
   * 定义一个跨切只读对象（同 key 重复定义抛错——fail-closed 防双源）。
   * 拥有权 = 调用方 fiber：插件卸载即撤销。
   *
   * @returns 喂养方持有的对象实例（工厂同步执行）
   */
  define<T extends object>(key: string, factory: () => T): T {
    if (this.objects.has(key)) {
      throw new Error(`objects "${key}" 已定义——跨切对象层单源纪律（M27 §0.3）`);
    }
    let value: T | undefined;
    this.ctx.fiber.effect(() => {
      value = factory(); // 工厂抛错 → effect 注册失败，不落账
      this.objects.set(key, value);
      return () => {
        this.objects.delete(key);
      };
    }, `objects.define(${key})`);
    return value as T;
  }

  /** 读取（未定义 → undefined；跨域读一律经服务面，不 import 他域 store） */
  get<T extends object>(key: string): T | undefined {
    return this.objects.get(key) as T | undefined;
  }

  /** 已定义键清单（诊断面） */
  keys(): string[] {
    return [...this.objects.keys()];
  }
}

declare module './context.ts' {
  interface ClientContext {
    /** 跨切只读对象层（ac-client-runtime 提供）：define/get/keys */
    objects: ObjectsService;
  }
}
