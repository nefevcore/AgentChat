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
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context, Plugin } from '@agentchat/cordis';
import type { ToolResult, ToolCall } from 'ac-tools';
import { issueRequestId, makeEnvelope } from 'ac-envelope-core';

/** cr-806：宿主事实源（boot 落盘 .runtime/host-facts.json）——restart_host
 * 回执的 oldPid/webuiPort 来源；缺席（旧宿主代/写失败）= 探测降级读日志。 */
function readHostFacts(dataRoot: string): { pid: number; port: number; bootAt: string } | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(
      path.join(path.resolve(dataRoot), '.runtime', 'host-facts.json'), 'utf-8',
    )) as { pid?: unknown; port?: unknown; bootAt?: unknown };
    if (typeof raw.pid === 'number' && typeof raw.port === 'number') {
      return { pid: raw.pid, port: raw.port, bootAt: typeof raw.bootAt === 'string' ? raw.bootAt : '' };
    }
  } catch { /* 缺席/坏文件 = 降级 */ }
  return undefined;
}

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
          '请求在本轮 run 自然结束后重启本 Agent 的壳进程——「退出即复活」的重载原语，不丢消息、不触发崩溃熔断。时序：调用后重启即排程，但壳仍在运行——行集、内存状态在本轮内不会更新；请立即停止不必要的工具调用、收尾并给出终稿（写明当前进度与重启后的下一步，终稿是重启后的接力上下文）。壳退出后由宿主自动重拉，重启完成你会收到「已重启」通知，届时状态已重载，按终稿继续即可、勿重做已完成步骤。典型场景：① install_plugin 定型后新插件行需新壳装配进直调面；② 壳侧装载行源码改动不热更新（改后需新壳加载）；③ 壳内状态坏自愈。同一轮内只调一次。',
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
          '重启宿主进程以重载宿主侧装载的代码与状态——「退出即复活」的无损重载原语，不是停机窗口。保壳保 run：模型调用不经过宿主，本壳与当前 run 不受影响（继续当前任务即可）；宿主优雅退出（退出码 42）后由活壳探测复活（supervisor 在场时为其快路），webui 短暂断连后恢复，run 终稿在宿主恢复后送达。最高频场景：改了 packages/ 下宿主装载行（读面/行集/宿主侧服务）的源码——宿主进程不热更新，测试全绿 ≠ 已生效，须本工具重启加载新代码后再验证。其余场景：宿主侧状态坏、宿主级行集目录/插件库变更需重载。注意：回执为壳侧送达确认（宿主退出后无法自回响应，crashed/超时类结果不等于失败）——复活证据以回执给出的 healthz 探测地址/事实源文件为准，勿盲猜端口。批处理/迁移不要指望宿主退出期间执行——应在宿主恢复静止后执行（idle 宿主只在 run 收束时写盘，「需要停机窗口」的担忧通常不存在）。',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_args: Record<string, unknown>, call: ToolCall): Promise<ToolResult> => {
          if (options.postOfficeAddress === undefined) {
            return { ok: false, error: 'CLI 直连形态无邮局——restart_host 不可用（宿主形态壳才可）' };
          }
          // 每次调用独立连接、发毕即关（无缓存）：宿主换代（exit 42）会带走本壳
          // 持有的旧连接，缓存下来的话下一次 restart_host 恒失败（cr-656 活体实锤：
          // 29124→23528 换代后同一壳再调 →「This socket has been ended by the other party」）。
          const { IpcClient } = await import('ac-envelope-core');
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
          // cr-806：回执 = 壳侧送达确认（宿主退出后无法自报）+ 结构化探测锚点
          //（oldPid/webuiPort 来自 boot 落盘的事实源——消除盲猜端口的排查轮回）。
          const facts = readHostFacts(options.dataRoot);
          const factsPath = path.join(path.resolve(options.dataRoot), '.runtime', 'host-facts.json');
          const healthzUrl = facts !== undefined ? 'http://127.0.0.1:' + facts.port + '/api/healthz' : undefined;
          return {
            ok: true,
            output: {
              restarting: true,
              ackBy: 'shell',
              ...(facts !== undefined ? { oldPid: facts.pid, webuiPort: facts.port, healthzUrl } : {}),
              note: '重启请求已送达宿主（本回执为壳侧送达确认——宿主退出后无法自回响应，后续收到 crashed/超时类结果不等于失败）。宿主将优雅退出重启，由活壳/supervisor 拉回，通常 ~10s 内恢复；本 run 不受影响，继续当前任务即可。'
                + (facts !== undefined
                  ? '复活验证：读 ' + factsPath + '（pid 变化即换代完成，当前旧 pid=' + facts.pid + '）或 GET ' + healthzUrl + '（宿主监听恒 127.0.0.1，勿盲猜端口）。'
                  : '本数据根无 host-facts.json（旧宿主代）——复活验证读 .runtime/logs 下最新 host-*.log。'),
            },
          };
        },
      };

      ctx.tools.register(restartShellTool as Parameters<typeof ctx.tools.register>[0]);
      ctx.tools.register(restartHostTool as Parameters<typeof ctx.tools.register>[0]);
    },
  };
}
