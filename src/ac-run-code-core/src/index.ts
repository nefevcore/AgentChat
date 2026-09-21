// ============================================================
// ac-run-code-core —— run_code SDK 投影纯库（零 cordis 依赖）
//
// 程序化模式（PTC）的定义性构件之一：把「本次 run 的生效工具集」
// 投影成一段可擦除 TS 声明文本，让模型在 run_code 程序里以
// `tools.read({...})` 的类型化姿势编排工具调用。
//
// 同源纪律（research §六.2）：投影源 = resolveToolNames 解析后的
// 生效工具集（与 loop 送 LLM 的 normalizeToolSpecs 同入参口径）——
// 由工具行（ac-run-code）按调用身份现算后传入本库；本库只做
// 纯转换，不知道 cordis/ctx 为何物。
//
// KV cache（M2a 语义）：输出按工具名字典序稳定、内容确定——
// 工具集不变则字节不变，声明块可安全进系统提示前缀。
// ============================================================

/** 投影输入的极小工具形状（ToolDefinition 的子集——纯库不依赖契约包运行时） */
export interface ProjectedToolDef {
  name: string;
  description?: string;
  /** JSON Schema 参数表 */
  parameters?: Record<string, unknown>;
}

/** 投影选项 */
export interface ProjectionOptions {
  /** 递归防护：从投影中排除的工具名（缺省 ['run_code']） */
  exclude?: string[];
  /** 头部附加指引（程序书写纪律；缺省用内置文案） */
  guidance?: string;
}

/** 内置程序书写纪律（程序化互斥形态注入用；并存形态不注入投影块） */
export const DEFAULT_GUIDANCE = [
  '工具调用纪律：',
  '- 只读工具（read/glob/grep/web_search 等）可用 Promise.all 并行（上限 5）；',
  '- 写路径（write/edit/str_replace_editor）与命令（pwsh/bash）按提交序串行执行；',
  '- 返回结论的两种方式（按任务形态自选）：① return——程序末尾一次合成压缩后的结论（读文件/搜索结果取摘要，不回传全文；技能正文等指令全文已由注入机制进入上下文，无需也不应搬运；超限会被截断）；② log——沿途 log("…") 按序打印结论，程序无 return 值（undefined/null 均视为无值）时各行按序合成返回；',
  '- return 适合在信息完备时一次合成完整结论；log 适合边执行边给结论、失败时留下过程现场——同一程序内不要混用两通道给结论；',
  '- 结果解包后再 return/log：用 r.output?.xxx 取值，勿透传 {ok, output} 信封或整个结果对象；',
  '- 程序体不做类型检查（可擦除语法）——类型标注可自由省略，访问属性直接写 r.output?.total，无需 as any；',
  '- 语法限可擦除 TS（类型标注/接口可用，enum/命名空间/参数属性不可用）；',
  '- 预算耗尽或中止时程序按 interrupted 收束，已完成的子调用如实计数；',
  '- 字符串书写纪律（防擦除失败——模板串内嵌反引号是头号错误源）：反引号须转义（`用 \\`pwsh\\` 执行`）或改用单/双引号串；多行文本优先 [\'行1\', \'行2\'].join(\'\\n\') 拼接；模板串内字面 ${ 写 \\${。',
  '临时库（lib）：',
  '- 注册：lib.define(\'名\', 函数或源码串)——本程序起生效，同会话后续程序可用；源码串推荐具名 async function 名(...) {...} 或箭头 fn => …（匿名 function 表达式串不可用），程序体字符串按同步求值（可含 return 取预计算值，不能含 await——要调 tools 用 async 函数形态）；value 须为源码字符串或函数（对象/数组等数据本体无法注册——跨程序经序列化传递），resolve 取到的是调用即执行的结果，不是缓存数据。',
  '- 取用：const clip = lib.resolve(\'clip\') 返回库本体直接调用，或直调糖 lib.clip(...)（两形态等价——Proxy 代理已注册名到同一求值通道）；对单名结果解构得 undefined 是头号误用；lib.resolve() 无参返回清单摘要 { 名: { kind, size, preview } }（纯静态不执行任何库源码——查看有什么库用，用哪个库还是 resolve(名) 取本体）。最小示例：lib.define(\'clip\', (s, n = 80) => (s.length > n ? s.slice(0, n) + \'…\' : s)) 注册 → const clip = lib.resolve(\'clip\') 取用。',
  '- 库函数必须自包含——引用外部变量会在调用时报 ReferenceError（外部值经参数或内联常量进入；define 返回值带 warning 即此警告）。',
  '- 容量：lib 存小型工具函数（建议 ≤ 数 KB；容量闸 64KB/32 条，超容即拒），勿存大结果数据——跨程序传递大数据的正解：把「读取+加工」逻辑包成 lib 函数，后续程序调用它现算，不缓存数据本体。',
  '- 典型场景：同一对象会被多个程序反复读/改（如大文件源码多次取用）——注册 readXxx()/patchXxx(args) 一类函数，省去每程序重写取数与加工步骤；跨程序只需传递键名/参数等小值。',
  '结果语义：',
  '- pwsh/bash 退出码非 0 ≠ 工具错误：output.failure_class 区分两类——command-feedback（命令按预期运行后的非零退出：测试红灯/断言失败/grep 无命中——输出在 output 字段，ok=true）与 invocation-error（命令未跑起来/语法失败——ok=false + error）。判断测试结果看 exit_code 与 output，不要因非零退出码误判链路故障绕路重试；',
  '- load_skill 是注入型工具：返回值只有 name/scope/baseDir/status 回执，正文不进返回值（由注入机制随后进入上下文）——程序内判定成功看 status==="injected"，不要把返回值当数据处理；',
].join('\n');

/** JSON Schema 单值 → 可擦除 TS 类型标注（宽松：不强校验 additionalProperties） */
function schemaTypeToTs(schema: unknown, required: boolean): string {
  let base: string;
  if (schema === true || schema === undefined) base = 'unknown';
  else if (typeof schema !== 'object' || schema === null) base = 'unknown';
  else {
    const s = schema as Record<string, unknown>;
    const anyOf = Array.isArray(s.anyOf) ? s.anyOf : undefined;
    const oneOf = Array.isArray(s.oneOf) ? s.oneOf : undefined;
    if (anyOf && anyOf.length > 0) {
      const union = anyOf.map((x) => schemaTypeToTs(x, true)).join(' | ');
      return required ? union : `${union} | undefined`;
    }
    if (oneOf && oneOf.length > 0) {
      const union = oneOf.map((x) => schemaTypeToTs(x, true)).join(' | ');
      return required ? union : `${union} | undefined`;
    }
    switch (s.type) {
      case 'string': base = 'string'; break;
      case 'number':
      case 'integer': base = 'number'; break;
      case 'boolean': base = 'boolean'; break;
      case 'array': base = `Array<${schemaTypeToTs(s.items, true)}>`; break;
      case 'object': {
        const props = s.properties;
        if (props === undefined || typeof props !== 'object' || props === null) { base = 'Record<string, unknown>'; break; }
        const inner: string[] = [];
        const req = new Set(Array.isArray(s.required) ? (s.required as unknown[]) .filter((x): x is string => typeof x === 'string') : []);
        for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
          inner.push(`${safePropName(key)}${req.has(key) ? '' : '?'}: ${schemaTypeToTs(sub, req.has(key))};`);
        }
        base = inner.length > 0 ? `{ ${inner.join(' ')} }` : 'Record<string, unknown>';
        break;
      }
      default: base = 'unknown';
    }
  }
  return required ? base : `${base} | undefined`;
}

/** 属性名非标识符安全时加引号 */
function safePropName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** 单工具声明行（description → JSDoc；参数 → 类型化对象字面量） */
function projectTool(def: ProjectedToolDef): string {
  const lines: string[] = [];
  const doc = (def.description ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (doc.length > 0) {
    lines.push(`  /**`);
    for (const l of doc) lines.push(`   * ${l.replace(/\*\//g, '*\\/')}`);
    lines.push(`   */`);
  }
  let argsType = 'Record<string, unknown>';
  if (def.parameters !== undefined && typeof def.parameters === 'object') {
    argsType = schemaTypeToTs(def.parameters, true);
    // 参数对象可能是 { type:'object', properties:{...} }——顶层已由 object 分支展开；
    // 非对象形状退回宽松类型。
    if (argsType === 'unknown' || argsType === 'Record<string, unknown>') {
      // 保持宽松（模型自由传参，运行时按 schema 由工具行校验）
    }
  }
  lines.push(`  ${safePropName(def.name)}(args: ${argsType}): Promise<{ ok: boolean; output?: unknown; error?: string }>;`);
  return lines.join('\n');
}

/**
 * 生效工具集 → SDK 投影声明文本（可擦除 TS）。
 * 字典序稳定输出；排除 exclude 名单（缺省 run_code——递归防护：
 * 程序内不能再 spawn run_code 程序）。
 *
 * guidance 传空串 '' = 不嵌注释（系统提示注入方的纪律经代码块外的
 * 纯文本走一份——块内双份是纯重复，2026-12 裁决）；undefined = 内置
 * DEFAULT_GUIDANCE。两形态输出都字节确定（KV cache 前缀不变量保持）。
 */
export function buildSdkProjection(
  defs: readonly ProjectedToolDef[],
  options: ProjectionOptions = {},
): string {
  const exclude = new Set(options.exclude ?? ['run_code']);
  const guidance = options.guidance ?? DEFAULT_GUIDANCE;
  const sorted = defs
    .filter((d) => d && typeof d.name === 'string' && d.name !== '' && !exclude.has(d.name))
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const body = sorted.map(projectTool).join('\n');
  return [
    `// tools SDK —— 本次 run 生效工具的类型化投影（字典序；声明与运行时桥接同名同构）`,
    ...(guidance !== '' ? [`// ${guidance.split('\n').join('\n// ')}`] : []),
    `declare const tools: {`,
    body,
    `};`,
    // lib：会话级临时库（内置 API——闭包第二参数；与 tools 同注入）
    // log：输出收集通道（复合返回协议）——程序无 return 值（undefined/null）时按序合成返回
    `declare const log: {`,
    `  /** 输出收集：按调用顺序打印结论（字符串直传，其余 JSON 序列化）；程序无 return 值（undefined/null 均视为无值）时各行按序合成返回值，有 return 值时不回流 */`,
    `  (...args: unknown[]): void;`,
    `};`,
    `declare const lib: {  // 已注册库名可直调（Proxy 糖）：lib.<名>(...) 等价 lib.resolve('<名>')(...)`,
    `  /** 注册库（value = 函数源码或含 return 的程序体字符串）；本程序起生效，同会话后续程序可用 */`,
    `  define(name: string, value: unknown): { ok: boolean; registered: string; sizeBytes: number };`,
    `  /** 取用已注册库——传名单名返回该库本体（直接调用，勿解构！解构 undefined 是头号误用）；无参 = 清单摘要 { 名: { kind, size, preview } }（纯静态，不执行任何库源码）；未注册报错并附可用名单 */`,
    `  resolve(name: string): unknown;`,
    `  resolve(): Record<string, unknown>;`,
    `  resolve(name?: string): unknown;`,
    `};`,
    ``,
    `export {};`,
  ].join('\n');
}
