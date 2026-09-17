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

/** 内置程序书写纪律（互斥形态基线；并存形态由调用方补选择策略） */
export const DEFAULT_GUIDANCE = [
  '工具调用纪律：',
  '- 只读工具（read/glob/grep/web_search 等）可用 Promise.all 并行（上限 5）；',
  '- 写路径（write/edit/str_replace_editor）与命令（pwsh/bash）按提交序串行执行；',
  '- return 只返回下一步需要的结论（读文件/搜索结果取摘要，不回传全文；超限会被截断）；',
  '- 结果解包后 return：用 r.output?.xxx 取值，勿透传 {ok, output} 信封或整个结果对象；',
  '- 程序体不做类型检查（可擦除语法）——类型标注可自由省略，访问属性直接写 r.output?.total，无需 as any；',
  '- 语法限可擦除 TS（类型标注/接口可用，enum/命名空间/参数属性不可用）；',
  '- 预算耗尽或中止时程序按 interrupted 收束，已完成的子调用如实计数。',
  '临时库（lib）：',
  '- 跨程序复用的工具函数先注册再使用：lib.define(\'名\', 函数)（本程序起生效，同会话后续程序可用）；',
  '- 取用：const { 名 } = lib.resolve(\'名\')（或 lib.resolve() 看全部已注册库）——resolve 结果按已知库形状直接解构/调用，无需 as any；',
  '- 库函数必须自包含——引用外部变量会在调用时报 ReferenceError（外部值经参数或内联常量进入）；',
  '- 库内要调工具写 async 函数（tools 为内置参数名）；预计算/常量表可注册含 return 的程序体字符串。',
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
    `// ${guidance.split('\n').join('\n// ')}`,
    `declare const tools: {`,
    body,
    `};`,
    // lib：会话级临时库（内置 API——闭包第二参数；与 tools 同注入）
    `declare const lib: {`,
    `  /** 注册库（value = 函数源码或含 return 的程序体字符串）；本程序起生效，同会话后续程序可用 */`,
    `  define(name: string, value: unknown): { ok: boolean; registered: string; sizeBytes: number };`,
    `  /** 取用已注册库（无参 = 全部 { 名: 值 }——按已知库形状直接解构，无需 as any）；未注册报错并附可用名单 */`,
    `  resolve(name?: string): Record<string, unknown>;`,
    `};`,
    ``,
    `export {};`,
  ].join('\n');
}
