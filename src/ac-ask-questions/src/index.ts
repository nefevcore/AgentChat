// ============================================================
// ac-ask-questions/src/index.ts —— ask_questions 工具行
//
// 2026-09-17 自 ac-durable-interaction 拆出：核（open/reply/close
// 状态机 + 三事件，领域无关）与 ask_questions 工具行分离——本行是
// kind='ask_questions' 词汇的认领者，核被 ac-security（approval）、
// ac-web-api（interaction/list|reply RPC）等多方共用。
//   · write-ahead：durableInteraction.open 先落盘（jsonl 后端）再通知
//   · correlationId = toolCallId（执行身份——恢复对账用）
//   · 会话键 = call.conversationId（执行身份；缺省 agentId 1v1）
//   · 等待 = 订阅 durable-interaction/replied（id 匹配）+ deadline/signal
//   · late-reply 唤醒（2026-09-12 补齐）：工具等待中的 run 已收束
//     （后端重启 / 进程中断——步级部分行残留在会话流，工具永不回填）
//     时，用户作答（replied 事件）经 conversation.deliver 以 sender:'event'
//     信封回投答案通知 → 新 run 醒来，历史 partial 行 + 通知文本共同
//     恢复决策上下文（与 ac-job-wakeup 同构的机制唤醒形态）。
//     活跃 run 等待中（正常路径，工具自身的事件驱动半边会拿到答案）
//     不打扰——listRunning 探测判定，避免双消费。
//   · late-reply 补记（2026-09-15 上下文丢失事故修复）：回投前先经
//     session.backfillToolResult 把答案按 correlationId=toolCallId 落成
//     tool-result 补行——partial 行 result:null 被 records() 覆盖后，
//     history() 的 stepsComplete 门放行，run 死前产出的完整轨迹（正文/
//     思维链/提问调用）回到回放上下文。否则新 run 只见通知文本，
//     "partial 行 + 通知共同恢复"的设计意图落空（事故现场：2471 字
//     分析正文整段丢失）。补记失败不阻塞回投——唤醒优先。
//   · 形态面（2026-02）：excludeForms:['self']——自会话桶（机制 run）
//     不投放。用户应答通道在 1v1/群/独立会话，机制 run 里提问无人能答。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import type { DurableInteraction } from 'ac-durable-interaction';

/** 等待轮询间隔（replied 事件驱动之外的双保险——store 可能被外部进程回复） */
const WAIT_POLL_MS = 150;

export const name = 'ac-ask-questions';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ask-questions',
  label: '用户提问工具',
  description: 'ask_questions 工具 + late-reply 唤醒（基于 durable-interaction 核，kind=ask_questions）',
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

/** session 可选能力面（软依赖；窄类型避免行耦合）——backfillToolResult 见 ac-session */
interface SessionLike {
  backfillToolResult(conversationId: string, toolCallId: string, result: unknown): Promise<boolean>;
}

/** 单项答案格式化：多选数组 → 「A、B」；null → (跳过) */
function formatAnswer(v: string | string[] | null | undefined): string {
  if (Array.isArray(v)) return v.length ? `「${v.join('、')}」` : '(跳过)';
  return v ?? '(跳过)';
}

/** ask_questions 应答通知正文：answers 与工具结果同形（Agent 醒来即可继续决策） */
function lateReplyNotice(record: DurableInteraction): string {
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

/** 载荷问题列表原样提取（补记 result 的 questions 字段——与工具正常返回同形） */
function questionsOf(record: DurableInteraction): unknown {
  const payload = record.payload as { questions?: unknown } | null;
  return Array.isArray(payload?.questions) ? payload!.questions : [];
}

export function apply(ctx: Context) {
  const service = ctx.durableInteraction;

  // ---- late-reply 唤醒：answered 且原 run 已死 → 回投答案（重开 run 闭环） ----
  ctx.on('durable-interaction/replied', async (record) => {
    if (record.kind !== 'ask_questions') return; // approval 等其他交互各有等待方
    const owner = record.owner;
    const convKey = record.key;
    if (!owner || !convKey) return; // 旧记录缺执行身份——无处回投
    const conversation = ctx.get('conversation', false) as ConversationLike | undefined;
    if (!conversation) return; // 会话行未装——作答只落记录（组合可选）
    // 正常路径（run 活着、工具在事件驱动等待）：不打扰——工具自身会拿到
    // 答案并回填消息流，此处回投会造成同一答案双消费（新 run 重复作答）。
    const running = conversation.listRunning().some((r) => r.agentId === owner && r.conversationId === convKey);
    if (running) return;
    // 补记（2026-09-15 事故修复）：答案先落 tool-result 补行（correlationId
    // 对账），让 run 死前残留的 partial 行获得结果——history() 门放行后新
    // run 读到完整轨迹。result 形状与 ask_questions 工具正常返回一致
    // （answers = 用户原始回答；回投通知文本才是人读格式）。
    if (record.correlationId !== undefined && record.correlationId) {
      const session = ctx.get('session', false) as SessionLike | undefined;
      if (session) {
        try {
          await session.backfillToolResult(convKey, record.correlationId, {
            ok: true,
            output: { answers: record.answer ?? null, questions: questionsOf(record), interaction_id: record.id },
          });
        } catch (err) {
          // 补记失败不阻塞回投——唤醒优先（新 run 至少还有通知文本）
          ctx.logger.warn(`[ask-questions] late-reply 补记失败 ${owner}（${convKey}）: ${String(err)}`);
        }
      }
    }
    // 提权继承走会话水位（2026-09-12 终版设计：ac-conversation deliver 边界
    // 对 source='event' 且未显式带档位时自动继承 conv-settings 水位）——
    // payload.elevation 留痕仅作诊断，不单独透传（防双路径漂移）。
    void conversation
      .deliver(owner, lateReplyNotice(record), {
        sender: owner,
        source: 'event',
        conversationId: convKey,
      })
      .catch((err: unknown) => {
        ctx.logger.warn(`[ask-questions] late-reply 唤醒 ${owner}（${convKey}）失败: ${String(err)}`);
      });
  }, { description: 'late-reply 唤醒：run 已死时的作答回投（sender:event 信封）+ 补记恢复上下文' });

  // ---- ask_questions：向用户批量提问等待决策（write-ahead + 事件等待） ----

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

  // infra 标签（2026-09-16 全量标签化）：用户交互属会话基础设施。
  // excludeForms:['self']（形态轴，2026-02）：自会话（对角线桶 a~a——
  // timer/goal-round/job-wakeup 机制 run 落点）无人值守，ask_questions
  // 在那里永无应答（ac-security 无人桶判定同口径——不设 deadline 会
  // 挂到 setTimeout 上限）。预防性裁剪：模型误用即挂死整轮的病灶面
  // 直接不投放，1v1/群/独立会话照常。
  ctx.tools.register({
    name: 'ask_questions',
    requiredTags: ['infra'],
    excludeForms: ['self'],
    description: '向用户提问并等待回答。用于需要用户决策或确认的场景（write-ahead：重启后可恢复对账）。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '问题' },
              options: { type: 'array', items: { type: 'string' }, description: '选项（纯字符串数组，如 ["选项一","选项二"]；不要发对象）' },
              multi: { type: 'boolean', description: '多选（用户可勾选多项，答案为数组）' },
            },
            required: ['question', 'options'],
          },
          description: '选择题列表（最多 5 题；每题可 multi: true 开多选）',
        },
        timeout_ms: { type: 'number', description: '等待超时毫秒（不设 = 一直等）', minimum: 0 },
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
      const rawTimeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 0;
      const timeoutMs = rawTimeout < 0 ? 0 : rawTimeout;

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
        ...(call.agentId !== undefined ? { owner: call.agentId } : {}),
        ...(timeoutMs > 0 ? { deadline: Date.now() + timeoutMs } : {}),
      });

      // 等待：replied 事件（id 匹配）驱动 + 轮询双保险 + deadline/signal
      const settled = await new Promise<DurableInteraction | 'timeout' | 'aborted' | undefined>((resolve) => {
        let done = false;
        const finish = (v: DurableInteraction | 'timeout' | 'aborted') => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearTimeout(poller);
          disposeListener();
          call.signal?.removeEventListener('abort', onAbort);
          resolve(v);
        };
        // 事件驱动（同进程 reply）
        const disposeListener = ctx.on('durable-interaction/replied', (payload) => {
          if (payload.id === record.id) finish(payload);
        }, { description: 'ask_questions 应答等待（事件驱动半边）' });
        // 轮询双保险（跨进程 reply：jsonl 文件被外部回答）
        const poller = setInterval(() => {
          const cur = service.get(record.id);
          if (cur && cur.state !== 'pending') finish(cur);
        }, WAIT_POLL_MS);
        const timer =
          timeoutMs > 0
            ? setTimeout(() => finish('timeout'), timeoutMs)
            : setTimeout(() => {}, 2_147_483_000); // 永久等待（不设 deadline）
        const onAbort = () => finish('aborted');
        call.signal?.addEventListener('abort', onAbort, { once: true });
      });

      if (settled === 'timeout') {
        service.close(record.id, 'timeout');
        return { ok: false, error: `用户未响应（超时 ${timeoutMs}ms）`, output: { questions: qs, interaction_id: record.id } };
      }
      if (settled === 'aborted') {
        service.close(record.id, 'aborted');
        return { ok: false, error: '等待被中止（signal abort）', output: { questions: qs, interaction_id: record.id } };
      }
      if (!settled || settled.state === 'closed') {
        return {
          ok: false,
          error: `交互已关闭（${settled?.closedReason ?? 'unknown'}）`,
          output: { questions: qs, interaction_id: record.id },
        };
      }
      // answered：answers 期望为与 questions 对齐的数组（回复方约定）
      return {
        ok: true,
        output: { answers: settled.answer, questions: qs, interaction_id: record.id },
      };
    },
  });
}
