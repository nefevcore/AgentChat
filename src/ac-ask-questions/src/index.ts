// ============================================================
// ac-ask-questions/src/index.ts —— ask_questions 工具行（挂起形态）
//
// 2026-02 挂起重构（src/docs/ask-questions-suspension-plan.md）：
// 工具体不再等待——execute 是发起体（校验归一 → open 落盘 → context 行
// → 即时返回 awaiting 标记），等待由系统持有：
//   · loop/run-idle 监听器（本行注册）：run 自然停点挂起等 replied，
//     答案注入同 run 续走（消息数组连续，KV 前缀稳定）；
//   · 崩溃恢复（late-reply）：run 死后作答 → deliver 唤醒新 run，
//     答案纯 context 行（裁决 #4：不走 backfillToolResult）。
// 活续走与崩溃恢复产出相同的会话转录形状（ask 步 + context 答案行）。
//
// 历史（2026-09-17 自 ac-durable-interaction 拆出的核/行分离不变）：
// 核（open/reply/close 状态机 + 三事件）被 ac-security（approval）、
// ac-web-api（interaction/list|reply RPC）等多方共用。
//   · write-ahead：durableInteraction.open 先落盘（jsonl 后端）再通知
//   · correlationId = toolCallId（执行身份——恢复对账用）
//   · 会话键 = call.conversationId（执行身份；缺省 agentId 1v1）
//   · 交互面（2026-02 起，2026-12 契约化）：requiresInteraction:true——
//     自会话桶（机制 run，无人值守）自动排除。用户应答通道在 1v1/群/
//     独立会话，机制 run 里提问无人能答。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import type { DurableInteraction } from 'ac-durable-interaction';

/** 挂起等待的轮询双保险间隔（replied 事件之外——store 可能被外部进程回复） */
const WAIT_POLL_MS = 150;

/** 本 run 未消费交互登记表：id → {agent, conversationId}（idle 监听器对账粒度） */
const openByRun = new Map<string, { agent: string; conversationId: string }>();

export const name = 'ac-ask-questions';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ask-questions',
  label: '用户提问工具',
  description: 'ask_questions 工具（发起体 + loop/run-idle 挂起等待 + late-reply 唤醒；基于 durable-interaction 核，kind=ask_questions）',
};

export const inject = ['tools', 'durableInteraction'];

/** conversation 可选能力面（行未装 = 无唤醒，作答只落记录不回投——组合可选惯例） */
interface ConversationLike {
  listRunning(): Array<{ agentId: string; conversationId: string }>;
  deliver(agentId: string, message: string | Record<string, unknown>, options?: {
    sender?: string; source?: string; conversationId?: string;
    elevation?: 'sandbox-access' | 'full-access';
  }): Promise<unknown>;
}

/**
 * session 可选能力面（软依赖；窄类型避免行耦合）——recordContext 落 context 行：
 * 提问行（execute 发起时）与答案/超时行（idle 监听器 resolved 后——
 * 2026-09-21 修正：答案此前只进 run 内消息数组不落账，run 收束后转录
 * 缺席，跨 run 语义丢失；见 idle 监听器注释）。
 */
interface SessionLike {
  recordContext(conversationId: string, agentId: string, content: string, extra: { source: string; label?: string }): string;
}

/** 单项答案格式化：多选数组 → 「A、B」；null → (跳过) */
function formatAnswer(v: string | string[] | null | undefined): string {
  if (Array.isArray(v)) return v.length ? `「${v.join('、')}」` : '(跳过)';
  return v ?? '(跳过)';
}

/** 应答通知正文：answers 与工具结果同形（Agent 醒来即可继续决策） */
function answerNotice(record: DurableInteraction): string {
  const payload = record.payload as { questions?: Array<{ question?: string }> } | null;
  const qs = Array.isArray(payload?.questions) ? payload!.questions! : [];
  const answer = record.answer as { answers?: Array<string | string[] | null> } | null;
  const answers = Array.isArray(answer?.answers) ? answer!.answers! : [];
  const lines = qs.map((q, i) => {
    const label = q?.question ? `「${q.question}」` : `第 ${i + 1} 题`;
    return `- ${label}: ${formatAnswer(answers[i])}`;
  });
  return `[系统通知] 你此前发起的提问（interaction ${record.id}）已收到用户回答：\n${lines.join('\n')}\n请基于以上回答继续之前的任务。`;
}

/** 载荷问题列表原样提取（展示文本与返回 output 的 questions 字段） */
function questionsOf(record: DurableInteraction): unknown {
  const payload = record.payload as { questions?: unknown } | null;
  return Array.isArray(payload?.questions) ? payload!.questions : [];
}

/** 发起时给会话流看的展示文本（context 行正文——UI 按 source 呈现，LLM 回放 user 语义位） */
function askNotice(qs: Array<{ question: string; options: string[]; multi?: true }>, interactionId: string): string {
  const lines = qs.map((q, i) => {
    const opts = q.options.map((o, j) => `${String.fromCharCode(65 + j)}. ${o}`).join('　');
    return `- ${q.question}${q.multi ? '（多选）' : ''}: ${opts}`;
  });
  return `[用户提问] 已发起提问（interaction ${interactionId}），等待用户回答：\n${lines.join('\n')}`;
}

export function apply(ctx: Context) {
  const service = ctx.durableInteraction;

  // ---- late-reply 唤醒：answered 且原 run 已死 → 回投答案（重开 run 闭环） ----
  ctx.on('durable-interaction/replied', async (record) => {
    if (record.kind !== 'ask_questions') return; // approval 等其他交互各有等待方
    const owner = record.owner;
    const convKey = record.key;
    if (!owner || !convKey) return; // 旧记录缺执行身份——无处回投
    // 精确判定（2026-02 挂起重构）：登记表在场 = idle 监听器还挂着（同 run 等待
    // 中）→ 不打扰（监听器自身的事件半边会拿到答案并注入续走）。登记表缺席 =
    // run 已死（正常收束后清账 / 进程崩溃从未清账——重启后登记表为空）→ 回投。
    if (openByRun.has(record.id)) return;
    const conversation = ctx.get('conversation', false) as ConversationLike | undefined;
    if (!conversation) return; // 会话行未装——作答只落记录（组合可选）
    // 提权继承走会话水位（2026-09-12 终版设计：ac-conversation deliver 边界
    // 对 source='event' 且未显式带档位时自动继承 conv-settings 水位）——
    // payload.elevation 留痕仅作诊断，不单独透传（防双路径漂移）。
    void conversation
      .deliver(owner, answerNotice(record), {
        sender: owner,
        source: 'event',
        conversationId: convKey,
      })
      .catch((err: unknown) => {
        ctx.logger.warn(`[ask-questions] late-reply 唤醒 ${owner}（${convKey}）失败: ${String(err)}`);
      });
  }, { description: 'late-reply 唤醒：run 已死时的作答回投（sender:event 信封；纯 context 行，不 backfill）' });

  // ---- loop/run-idle 监听器：自然停点挂起等待本 run 未消费的 ask 交互 ----
  // 只认本 run 打开的交互（发起体写入登记表）；等待 = replied/closed 事件 +
  // 轮询双保险 + signal abort。resolved 后注入答案 context 消息（同 run 续走）。
  ctx.on('loop/run-idle', async (call, next) => {
    const rest = await next(); // 组合可选：其他 idle 住户的材料照常透传
    const agent = call.request.agent;
    const conversationId = call.request.conversationId;
    if (agent === undefined || conversationId === undefined) return rest;
    const mine = [...openByRun.entries()].filter(
      ([, v]) => v.agent === agent && v.conversationId === conversationId,
    );
    if (mine.length === 0) return rest;
    // 挂起：等待全部本 run 交互终态（并行 ask 场景），signal abort 空手返回
    const settled = await new Promise<Array<{ record: DurableInteraction; outcome: 'answered' | 'closed' }>>((resolve) => {
      const want = new Set(mine.map(([id]) => id));
      const out: Array<{ record: DurableInteraction; outcome: 'answered' | 'closed' }> = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(poller);
        disposeListener();
        disposeClosed();
        call.request.signal?.removeEventListener('abort', onAbort);
        // abort 空手收尾：剩余登记清账——run 即将收束，之后作答走 late-reply
        for (const id of want) openByRun.delete(id);
        resolve(out);
      };
      const observe = (record: DurableInteraction) => {
        if (!want.has(record.id)) return;
        openByRun.delete(record.id); // 消费对账：late-reply 不会再回投
        out.push({ record, outcome: record.state === 'answered' ? 'answered' : 'closed' });
        want.delete(record.id);
        if (want.size === 0) finish();
      };
      const disposeListener = ctx.on('durable-interaction/replied', (r) => observe(r), { description: 'ask idle 等待（replied）' });
      const disposeClosed = ctx.on('durable-interaction/closed', (r) => observe(r), { description: 'ask idle 等待（closed）' });
      const poller = setInterval(() => {
        for (const id of [...want]) {
          const cur = service.get(id);
          if (cur && cur.state !== 'pending') {
            observe(cur);
            continue;
          }
          // deadline 自查：过期未答 → close(timeout)（closed 事件回环 observe）
          if (cur?.deadline !== undefined && cur.deadline <= Date.now()) {
            service.close(id, 'timeout');
          }
        }
        if (call.request.signal?.aborted || want.size === 0) finish();
      }, WAIT_POLL_MS);
      const onAbort = () => finish();
      call.request.signal?.addEventListener('abort', onAbort, { once: true });
      // 立即查一次：用户在模型收尾步期间已秒答（answered 在场——事件早发了）
      for (const id of [...want]) {
        const cur = service.get(id);
        if (cur && cur.state !== 'pending') observe(cur);
      }
      if (want.size === 0) finish();
    });
    if (settled.length === 0) return rest; // abort / 无终态 → 空手（loop 收束路径接管）
    // 答案/超时注入（user 语义位——projectRecord 对 context 行同款回放）。
    // 落账先行（2026-09-21 修正，session f5adb5d9 实测暴露）：recordContext
    // 在 run 活跃时落 journal 注入行，settlement 按消费点真序提升为 context
    // 行（与提问行同路径）——答案跨 run/重启存活，活续走与崩溃恢复（late-
    // reply deliver 纯 context 行）产出完全相同的转录形状（suspension plan
    // 裁决 #4/#5 的既定形状，此前实现漏掉了落账半边）。
    const session = ctx.get('session', false) as SessionLike | undefined;
    const injected = settled.map(({ record, outcome }) =>
      outcome === 'answered'
        ? { role: 'user' as const, content: answerNotice(record) }
        : { role: 'user' as const, content: `[系统通知] 你此前发起的提问（interaction ${record.id}）用户未响应（${record.closedReason ?? 'closed'}）——请自行决断是否继续等待或另寻方案。` },
    );
    for (let i = 0; i < settled.length; i++) {
      if (!session) break; // 会话行未装——答案仍注入 run 内（组合可选，降级不阻断）
      try {
        session.recordContext(conversationId, agent, injected[i].content, {
          source: 'durable-interaction',
          // label = UI 文案（流式 session/context-injected 事件与刷新历史
          // 两路径同源直出——正文整段对事件分隔行过长）
          label: settled[i].outcome === 'answered' ? '已收到用户回答' : '提问未获响应',
        });
      } catch (err) {
        ctx.logger.warn(`[ask-questions] 答案 context 行落账失败（${settled[i].record.id}）: ${String(err)}`);
      }
    }
    return [...injected, ...rest];
  }, { description: 'ask_questions 挂起等待：run 自然停点等用户回答，注入续走同 run' });

  // ---- ask_questions：向用户批量提问（发起体——即时返回，等待归 loop/run-idle） ----

  /**
   * 选项/问题文本归一（2026-09-15 反馈修复：模型发 {label, description}
   * 对象形态的选项——schema 声明 string[] 但模型不守约是常态，此前
   * String() 直转成 "[object Object]" 且污染选项照常放行）。归一规则：
   * 字符串原样；{label, description} → "label —— description"；其余形态
   * （数字/布尔可显示，null/undefined/空串丢弃）。
   */
  function optionText(v: unknown): string {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const label = typeof o.label === 'string' ? o.label.trim() : typeof o.text === 'string' ? o.text.trim() : '';
      const desc = typeof o.description === 'string' ? o.description.trim() : typeof o.desc === 'string' ? o.desc.trim() : '';
      if (label && desc) return `${label} —— ${desc}`;
      return label || desc;
    }
    return '';
  }

  /**
   * 单题归一（2026-09-17 事故新增：两种新的模型不守 schema 变体）：
   * · 变体 A「嵌套题形」：options 里嵌的是 {question, options}——模型把
   *   整个题结构塞进了 options 数组（事故现场 5cb5b75c）。上提子题为
   *   独立题（子题的 question/options 再走常规归一）。
   * · 变体 B「映射形选项」：options: [{"选项全文": "value"}]——单键对象，
   *   键是给用户看的选项文本（事故现场 35c642be，且 JSON 键内带 \t 转义）。
   *   取键为选项文本（值是模型内部代称，不展示）。
   * 两者都不可救时返回 null（该题丢弃）。
   */
  function normalizeQuestionItem(q: Record<string, unknown> | null | undefined): Array<{ question: string; options: string[]; multi?: true }> | null {
    if (!q || typeof q !== 'object') return null;
    const question = optionText(q.question);
    const rawOptions = q.options;

    // 变体 A：嵌套题形——上提子题
    if (Array.isArray(rawOptions) && rawOptions.length > 0 && rawOptions.every((o) => o && typeof o === 'object' && !Array.isArray(o) && 'question' in (o as Record<string, unknown>) && Array.isArray((o as Record<string, unknown>).options))) {
      const lifted: Array<{ question: string; options: string[]; multi?: true }> = [];
      for (const sub of rawOptions as Array<Record<string, unknown>>) {
        const subQ = normalizeQuestionItem(sub);
        if (subQ) lifted.push(...subQ);
      }
      if (lifted.length > 0) return lifted;
      return null;
    }

    // 常规/变体 B：optionText 已认 {label,text,description,desc} 对象；这里
    // 额外认「单键对象、键即选项文本」形（映射形）——optionText 对未知键
    // 对象返回 ''，映射形选项在 map 后全空被丢弃，所以在 map 前逐项分流。
    const options: string[] = [];
    if (Array.isArray(rawOptions)) {
      for (const item of rawOptions) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const o = item as Record<string, unknown>;
          // 显式 label/text 形优先（optionText 已处理），否则单键映射形取键
          const direct = optionText(item);
          if (direct) { options.push(direct); continue; }
          const keys = Object.keys(o);
          if (keys.length >= 1) {
            const keyText = optionText(keys[0]);
            if (keyText) { options.push(keyText); continue; }
          }
        }
        options.push(optionText(item));
      }
    }
    // 去重 + 上限 6
    const deduped: string[] = [];
    for (const s of options) {
      if (s && !deduped.includes(s)) deduped.push(s);
      if (deduped.length >= 6) break;
    }
    if (!question || deduped.length === 0) return null;
    return [{ question, options: deduped, ...(q.multi === true ? { multi: true } : {}) }];
  }

  /** 校验失败时回显收到的结构摘要（帮模型一轮自愈：看懂错在哪而不是猜） */
  function describeQuestionsArg(raw: unknown): string {
    try {
      const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
      return s ? (s.length > 200 ? `${s.slice(0, 200)}…` : s) : '(空)';
    } catch {
      return '(不可序列化)';
    }
  }

  ctx.tools.register({
    name: 'ask_questions',
    requiredTags: ['infra'],
    requiresInteraction: true, // 交互轴：self 会话（机制 run）自动排除（formDeniedBy 单源）
    description: '向用户提问并等待回答（发起后本 run 挂起，用户回答到达后自动继续）。用于需要用户决策或确认的场景。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '问题' },
              options: { type: 'array', items: { type: 'string' }, description: '选项（纯字符串数组，如 ["选项一","选项二"]，至多 6 个、超出截断；不要发对象）' },
              multi: { type: 'boolean', description: '多选（用户可勾选多项，答案为数组）' },
            },
            required: ['question', 'options'],
          },
          description: '选择题列表（最多 5 题；每题可 multi: true 开多选）',
        },
        deadline_ms: { type: 'number', description: '[已废弃，勿使用] 旧版等待超时参数——不再生效，传了会被忽略（等待无超时，直到用户回答）', minimum: 0 },
      },
      required: ['questions'],
    },
    async execute(args, call): Promise<ToolResult> {
      // 校验问题列表（每题 question + 至少一个 option；上限 5 题 6 选项）。
      // normalizeQuestionItem 认三种形态：常规 / 嵌套题形（上提）/ 映射形
      // 选项（取键）——模型不守 schema 的已知变体全部就地归一。
      const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
      if (rawQuestions.length === 0) {
        return { ok: false, error: '缺少 questions 参数（需要 [{question, options:[字符串]}]）' };
      }
      const qs: Array<{ question: string; options: string[]; multi?: true }> = [];
      for (const raw of rawQuestions.slice(0, 5)) {
        const item = normalizeQuestionItem(raw);
        if (item) qs.push(...item);
        // 单题归一失败不整体报废——其余有效题照常放行；全失败才报错
      }
      if (qs.length === 0) {
        return {
          ok: false,
          error: `questions 无效：每题需 {question: 字符串, options: [字符串,...]}（收到：${describeQuestionsArg(args.questions)}）`,
        };
      }

      const conversationId = call.conversationId ?? call.agentId;
      if (!conversationId) {
        return { ok: false, error: '缺少会话上下文（ask_questions 需要会话归属键）' };
      }
      const agentId = call.agentId !== undefined ? String(call.agentId) : undefined;

      // write-ahead：open 先落盘再通知（opened 事件随 open 发出）
      const record = service.open({
        key: String(conversationId),
        kind: 'ask_questions',
        payload: {
          questions: qs,
          // 原 run 提权档位留痕（2026-09-12 反馈：重启后 late-reply 唤醒的
          // 新 run 丢权限 → 逐工具审批疲劳）——回投时透传恢复原档位。
          // 放 payload（types 契约的展示/处理数据区，加字段免迁移）。
          ...(call.elevation ? { elevation: call.elevation } : {}),
        },
        ...(call.toolCallId !== undefined ? { correlationId: call.toolCallId } : {}),
        ...(agentId !== undefined ? { owner: agentId } : {}),
      });

      // 登记表：idle 监听器对账粒度（本 run 未消费交互）+ late-reply 防双投
      if (agentId !== undefined) {
        openByRun.set(record.id, { agent: agentId, conversationId: String(conversationId) });
      }

      // context 行（会话流留痕——LLM 回放 user 语义位、UI 按 source 呈现）。
      // session 软依赖（可选能力面）：缺席时降级——返回结果仍可用（弹窗照常
      // 由 interactions.jsonl 驱动），但无 context 行、无 idle 挂起（等待退化为
      // 「模型读 notice 自行收尾 → late-reply」形态）。
      const session = ctx.get('session', false) as SessionLike | undefined;
      if (session) {
        try {
          session.recordContext(String(conversationId), agentId ?? String(conversationId), askNotice(qs, record.id), {
            source: 'durable-interaction',
            // label = UI 文案（流式事件与刷新历史两路径同源直出——正文整段
            // 对事件分隔行过长）。
            label: '已发起提问，等待用户回答',
          });
        } catch (err) {
          ctx.logger.warn(`[ask-questions] context 行落账失败（${record.id}）: ${String(err)}`);
        }
      }


      // 即时返回：发起体契约——等待归 loop/run-idle（同 run）或 late-reply（run 死后）
      return {
        ok: true,
        output: {
          status: 'awaiting_user',
          interaction_id: record.id,
          questions: qs,
          notice: '已向用户发起提问。本 run 将在空闲时挂起等待，收到回答后自动继续——你现在可以给出收尾说明（或继续做不依赖答案的工作），不要重复发起同一提问。',
        },
      };
    },
  });
}
