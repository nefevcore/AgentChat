// ============================================================
// restart.ts —— 安全重启行（cr-629）：restart_shell / restart_host 两工具
//
// 背景：Agent 自杀（杀宿主/杀壳）后即使被 supervisor/壳侧复活拉起，
// 会话也不续跑——在途信封已被 run 消费（不在 inbox）、机器队列在内存，
// 重启即蒸发。安全重启 = 把「自杀」变成可续跑的原语：
//   · restart_shell（cr-658 自然收束语义）：只挂起标记、不中断 run——
//     本轮自然 settle（终稿/回信恰好一次）后以重启码 42 优雅退出 →
//     宿主 respawn（warden 42 = 有意重启，不计崩溃熔断）→ 新壳 boot
//     按 marker 会话键注入「已重启」通知（桶对端 sender，timer/goal 同款）
//     开续跑轮——续跑上下文 = 账本轨迹读面（historyMessagesFor）。
//   · restart_host：信封请求宿主 graceful 重启（exit 42，拉起恒归活壳
//     —— D5 边 2 裁决，supervisor 仅快路兜底）——本壳与在途
//     run 不受影响（LLM 直连 provider），终稿回信经 postReply 断链重试
//     在宿主复活后送达；停机戳恒不写（cr-630 裁决：戳只辖用户停机/换代，
//     活壳探测复活不经戳），双宿主竞态由数据根单写者 IPC 管道裁决。
// ============================================================
import type { Context, Plugin } from '@agentchat/cordis';
import type { ToolResult, ToolCall } from 'ac-tools';
import { issueRequestId, makeEnvelope } from 'ac-envelope-core';

/** 行配置（boot 装配参数） */
export interface RestartRowOptions {
  dataRoot: string;
  agentId: string;
  /** 邮局 ipc 地址（restart_host 的信封面；缺席 = CLI 直连形态 fail-loud） */
  postOfficeAddress?: string;
}

/** conversation 服务的安全重启面（preview ConversationService 结构子集） */
interface RestartFace {
  requestRestart(): boolean;
}

export function makeRestartRow(options: RestartRowOptions): Plugin {
  return {
    name: 'shell-restart-row',
    inject: ['tools'],
    apply(ctx: Context) {
      const conv = (): RestartFace | undefined =>
        ctx.get('conversation', false) as unknown as RestartFace | undefined;


      // cr-664 D4：同轮重复调用硬防——行内旗标，二次起直接返回已排程态
      //（不再触服务面；requestRestart 虽幂等，工具回执须让模型明确「无需再刷」）。
      let shellRestartScheduled = false;
      const restartShellTool = {
        name: 'restart_shell',
        description:
          '请求在本轮 run 自然结束后重启本 Agent 的壳进程。时序：调用后重启即排程，但壳仍在运行——行集、内存状态在本轮内不会更新；请立即停止不必要的工具调用、收尾并给出终稿（写明当前进度与重启后的下一步，终稿是重启后的接力上下文）。壳退出后由宿主自动重拉（不计崩溃熔断），重启完成你会收到「已重启」通知，届时状态已重载，按终稿继续即可。与直接杀进程的区别：不丢消息、不触发崩溃熔断、上下文完整。适用：怀疑壳内状态坏、行集更新需重载。注意：同一轮内不要重复调用。',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (): Promise<ToolResult> => {
          // cr-664 D5：CLI 直连形态（无邮局）无宿主重拉面——退 42 无人拉回，
          // fail-loud 拒绝（与 restart_host 同款守卫）。
          if (options.postOfficeAddress === undefined) {
            return { ok: false, error: 'CLI 直连形态无宿主重拉面——restart_shell 不可用（退出后无人拉回）。请继续当前任务；如需重载行集请手动重启 CLI。' };
          }
          const face = conv();
          if (face === undefined || typeof face.requestRestart !== 'function') {
            return { ok: false, error: 'conversation 服务缺席或不支持安全重启——行集不含 conversation 行' };
          }
          if (shellRestartScheduled) {
            return {
              ok: true,
              output: { restarting: true, alreadyScheduled: true, note: '重启已排程（本轮早前已调用）——无需重复调用。请收尾并给出终稿。' },
            };
          }
          shellRestartScheduled = true;
          const inFlight = face.requestRestart();
          return {
            ok: true,
            output: {
              restarting: true,
              inFlight,
              note: inFlight
                ? '重启已排程：将在本轮 run 自然结束后执行。当前壳仍在运行——行集/内存状态在本轮剩余步骤内不会更新，请尽快收尾并给出完整终稿（含进度与重启后的下一步）；重启后会收到「已重启」通知，届时直接继续，勿重做已完成步骤、勿再次 restart_shell。'
                : '已请求重启：壳即将优雅退出，由宿主重拉。',
            },
          };
        },
      };

      const restartHostTool = {
        name: 'restart_host',
        description:
          '安全重启宿主进程（保壳保 run）。本壳与当前 run 不受影响（模型调用不经过宿主）；宿主优雅退出（退出码 42）后由活壳探测复活（常态路；supervisor 在场时为其快路），webui 短暂断连后恢复，run 终稿会在宿主恢复后送达。适用：宿主侧状态坏、行集/插件目录变更需宿主重载。与直接杀宿主的区别：终稿不丢、webui 自动恢复、无孤儿竞态。',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_args: Record<string, unknown>, call: ToolCall): Promise<ToolResult> => {
          if (options.postOfficeAddress === undefined) {
            return { ok: false, error: 'CLI 直连形态无邮局——restart_host 不可用（宿主形态壳才可）' };
          }
          // 每次调用独立连接、发毕即关（无缓存）：宿主换代（exit 42）会带走本壳
          // 持有的旧连接，缓存下来的话下一次 restart_host 恒失败（cr-656 活体实锤：
          // 29124→23528 换代后同一壳再调 →「This socket has been ended by the other party」）。
          const { IpcClient } = await import('ac-post-office');
          const client = new IpcClient();
          try {
            await client.connect(options.postOfficeAddress);
            // uuid = host 请求域独立键：会话键原值会撞 R-1（会话登记集 [user, agent]，
            // to=host 的 participants 近似 [agent, host] 非其子集 → conflict fail-loud，
            // 信被邮局静默吞掉——e2e 用新鲜 uuid 测不出，真实环境必撞（cr-641）。
            // host 域子会话键 = 每会话独立登记 [agent, host]，重发幂等 consistent。
            await client.send(makeEnvelope({
              uuid: 'restart-host-' + (call.conversationId ?? options.agentId),
              requestId: 'restart-host-' + issueRequestId(),
              sender: options.agentId,
              to: 'host',
              kind: 'message',
              budget: 0,
              payload: { restartHost: true, conversationId: call.conversationId ?? null },
            }));
          } catch (err) {
            return { ok: false, error: '重启请求送达失败（宿主可能正在换代，稍后重试）：' + String(err) };
          } finally {
            client.close();
          }
          return {
            ok: true,
            output: {
              restarting: true,
              note: '重启请求已送达宿主：宿主将优雅退出重启（supervisor / 活壳负责拉回）。继续当前任务即可——webui 会短暂断连，终稿在宿主恢复后送达。',
            },
          };
        },
      };

      ctx.tools.register(restartShellTool as Parameters<typeof ctx.tools.register>[0]);
      ctx.tools.register(restartHostTool as Parameters<typeof ctx.tools.register>[0]);
    },
  };
}
