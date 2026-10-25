// ============================================================
// auto-title.ts —— 会话自动命名行（cr-672）
//
// 问题：preview 的会话标题此前只有「宿主按账本首行截断」一条派生面——
// 首条消息原样变标题（多条会话重名「继续 AgentChat preview 轨…」；定时
// 唤醒类会话直接拿到触发词与 DSML 残片）。主线的自动命名（LLM 一句概括）
// 在重建里缺席。
//
// 机制归位：标题生成要 LLM（llm/llm-pool 行只住壳）＋ 标题写权归宿主
// singles 行（session.json 单写者）——故本行是观察型壳行：
//   loop/run-started   暂存（路由终值 model/provider + 首条用户消息）
//   loop/after-step    首个完成步 → 结合 Agent 首步思考/正文生成（标题
//                      概括「这轮在谈什么」；工具轮里用户消息常只是「继续」）
//   → 标题请求信（title-request）→ 邮局 → 宿主 singles 行 write-if-absent
//     + singles/updated 广播
//   loop/after-run     兜底（run 夭折/无步完成 → 截断回落，会话不留无名列）
//
// 幂等三面：宿主 write-if-absent（用户手改/fork 继承的标题不被覆盖）；
// 壳侧本代已处置集合（同会话只算一次）；盘上标题预检（session.json 已有
// 标题即不花一次 LLM 调用——壳 idle-exit/restart 频繁，重算标题是纯浪费）。
// 只命名用户会话（run source='user'）：agent↔agent / 机制触发会话的标题归
// 宿主派生面（同一会话多壳各跑，谁都不该单独定名）。
// 失败静默降级：LLM 失败 → 截断回落；信封失败 → 只记 stderr（标题是装饰性
// 面，不得放大为 run 失败）。
// ============================================================
import type { Context, Plugin } from '@agentchat/cordis';
import { DATE_SNAPSHOT_PREFIX, cleanTitle, fallbackTitle, isArchiveReviewRun, titlePrompt } from 'ac-core-utils';
import { issueRequestId } from 'ac-envelope-core';
import { makeTitleRequestEnvelope } from 'ac-envelope-core';
import { readSessionTitle } from 'ac-ledger';
import type { LoopRunRequest, LoopStepRecord } from 'ac-agent-loop';

/** 行配置（boot 装配参数） */
export interface AutoTitleRowOptions {
  dataRoot: string;
  agentId: string;
  /** 邮局 ipc 地址（标题请求信封面）；缺省 = CLI 直连形态无宿主写面 → 不命名 */
  postOfficeAddress?: string;
}

/** 待命名 run（暂存态） */
interface StagedTitle {
  model: string;
  provider?: string;
  userText: string;
}

/** llm 服务面的结构子集（chat 聚合调用——思考型模型另行禁用思考） */
interface LlmChatFace {
  chat(input: Record<string, unknown>): Promise<{ text: string }>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function makeAutoTitleRow(options: AutoTitleRowOptions): Plugin {
  return {
    name: 'shell-auto-title-row',
    apply(ctx: Context) {
      const dataRoot = options.dataRoot;
      /** 待命名暂存（run-started 挂账 / 首步或收束即清账） */
      const staged = new Map<string, StagedTitle>();
      /** 本代已处置会话（成功/回落皆算——防跨轮重算） */
      const settled = new Set<string>();

      /** 标题生成（LLM 一句概括；失败/空回复上抛——调用方回落截断） */
      const generate = async (service: LlmChatFace, item: StagedTitle, agentFirstOutput?: string): Promise<string> => {
        const base = {
          model: item.model,
          ...(item.provider !== undefined ? { provider: item.provider } : {}),
          messages: [{ role: 'user', content: titlePrompt(item.userText, agentFirstOutput) }],
          max_tokens: 64,
        };
        try {
          // 思考型模型（GLM/DeepSeek 等）64 token 小预算会被思考独占
          // （finish=length、text 恒空）——双词汇禁用思考，宽容端点忽略未知键。
          const resp = await service.chat({ ...base, thinking: { type: 'disabled' }, reasoning_effort: 'none' });
          return cleanTitle(resp.text);
        } catch (err: unknown) {
          // 未知顶层字段严格 400 的端点（OpenAI 官方）：裸参数重试一次
          if (!/thinking|reasoning_effort/i.test(errText(err))) throw err;
          return cleanTitle((await service.chat(base)).text);
        }
      };

      /** 标题请求信投递（每次调用独立连接、发毕即关——缓存连接会随宿主换代
       *  失效，cr-656 同款） */
      const deliver = async (conversationId: string, title: string): Promise<void> => {
        const { IpcClient } = await import('ac-post-office');
        const client = new IpcClient();
        try {
          await client.connect(options.postOfficeAddress!);
          await client.send(makeTitleRequestEnvelope({
            conversationId,
            requestId: 'title-' + issueRequestId(),
            sender: options.agentId,
            payload: { conversationId, title, agent: options.agentId },
          }));
        } finally {
          client.close();
        }
      };

      /** 处置暂存项：生成 → 回落 → 投递（全程不抛——装饰性面不放大为 run 失败） */
      const fire = async (conversationId: string | undefined, agentFirstOutput?: string): Promise<void> => {
        if (conversationId === undefined) return;
        const item = staged.get(conversationId);
        if (item === undefined) return;
        staged.delete(conversationId);
        settled.add(conversationId);
        let title = '';
        try {
          const service = ctx.get('llm', false) as LlmChatFace | undefined;
          if (service !== undefined) title = await generate(service, item, agentFirstOutput);
        } catch (err: unknown) {
          process.stderr.write('[auto-title] 标题生成失败（回落截断）：' + errText(err) + '\n');
        }
        if (title === '') title = fallbackTitle(item.userText);
        if (title === '') return;
        try {
          await deliver(conversationId, title);
        } catch (err: unknown) {
          process.stderr.write('[auto-title] 标题请求送达失败（' + conversationId + '）：' + errText(err) + '\n');
        }
      };

      /** run-started：只挂账不生成（标题在首步完成后才有 Agent 首步产出可依） */
      const stage = (request: LoopRunRequest): void => {
        const sid = request.conversationId;
        if (options.postOfficeAddress === undefined || sid === undefined || sid === '') return;
        if (settled.has(sid) || staged.has(sid)) return;
        if (isArchiveReviewRun(request.meta)) return; // 机制 run 不是用户对话
        if (request.source !== 'user') return; // 只命名用户会话
        if (readSessionTitle(dataRoot, sid) !== undefined) return; // 已命名（含用户手改）
        // 首条用户消息 = 会话开场（request.messages 含全量历史）：跳过日期快照行
        const firstUser = request.messages.find((m) =>
          m.role === 'user'
          && typeof m.content === 'string'
          && m.content.trim() !== ''
          && !m.content.startsWith(DATE_SNAPSHOT_PREFIX));
        if (firstUser === undefined || typeof firstUser.content !== 'string') return;
        staged.set(sid, {
          model: request.model,
          ...(request.provider !== undefined ? { provider: request.provider } : {}),
          userText: firstUser.content,
        });
      };

      ctx.on('loop/run-started', (request) => {
        stage(request);
      }, { description: '会话命名暂存（run-started）' });
      ctx.on('loop/after-step', (_agent, step: LoopStepRecord, envelope) => {
        // 素材取 Agent 首步理解：思考（reasoning）优先——对任务的理解与规划
        // 比正文更贴「这轮在谈什么」；工具步正文常空。
        const material = step.reasoning?.trim() || step.text.trim() || undefined;
        void fire(envelope?.conversationId, material);
      }, { description: '会话首步后命名' });
      ctx.on('loop/after-run', (request) => {
        void fire(request.conversationId); // 兜底：run 夭折/无步完成 → 截断回落
      }, { description: '会话命名兜底（after-run）' });
    },
  };
}
