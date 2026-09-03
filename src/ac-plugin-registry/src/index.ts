// ============================================================
// ac-plugin-registry —— 插件注册中心行
//
// 行内四件事：
//   1. ctx.plugin(PluginRegistryService)（root 经行配置传入）
//   2. register_plugin / install_plugin / unregister_plugin 工具（管理面
//      工具随 owning 域——地图 §3.4）：工具体只上报意图（ToolResult.interrupt，
//      M11 语义化中断通道），loop 收束后由本行消费执行——"请求 → 收尾 →
//      宿主执行 → 续跑"闭环的宿主半边住在 owning 域行内
//   3. 宿主半边回执 + 回触（G6/L6、H1 闭环自驱动）——设计见 writeReceipt /
//      retrigger 助手文档（单处权威；回投发起会话——回执与下一轮同会话，
//      完整闭环用户可见），register/install 统一走 receiptAndRetrigger
// 启动扫描：loadInstalled()（安全模式 / gates 屏障 / 熔断 / hash 复验
// 见 service.ts；缺目录/损坏记录跳过不阻断）。
// ============================================================
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import type { LoopRunRequest, LoopRunResult } from 'ac-agent-loop';
import { pairKey } from 'ac-agent-loop';
import { loadManifestFromDir, type PluginPermission } from 'ac-plugin-core';
import { PluginRegistryService, type PluginRegistryRowOptions } from './service.ts';

export const name = 'ac-plugin-registry';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'plugin-registry',
  label: '插件注册中心',
  description: '动态插件装载/安装态恢复/staging 人审 + 行偏好层 patch RPC（目录页数据源）',
  automatic: true,
};


export const inject = ['tools'];

export function apply(ctx: Context, options: PluginRegistryRowOptions = {}) {
  // 直构（非 ctx.plugin）：行 apply 闭包要访问本行自身提供的 pluginRegistry
  // 服务（自依赖 inject 禁止——ac-web-tools BrowserService 同款形态）
  const registry = new PluginRegistryService(ctx, options);

  // ---- 管理面工具：上报意图（不执行——宿主半边在 after-run 消费） ----
  // 装载类工具分工（G6，两侧描述互引）：
  //   register_plugin = 临时试跑（会话级，重启即失）
  //   install_plugin  = 定型驻留（永久安装，安装态 = registry.json）
  // 一轮 run 只收束于首个 toolInterrupt（一轮一件，L7）——工具体描述写明。
  ctx.tools.register({
    name: 'register_plugin',
    description:
      '临时试跑本地插件目录（会话级装载：TS 入口直接装载，重启即失；不写入安装态）。目录须含 manifest.json，缺省约定在调用方沙箱 files/<agentId>/ 下。授权面 = manifest permissions 全集（免审语义，admin 边界）。与 install_plugin 的分工：本工具用于开发迭代中临时试跑；要永久驻留（重启后仍生效）必须用 install_plugin。迭代方式 = 改代码 → 再次 register_plugin（无热重载；热重载仅宿主 plugin/load RPC 的 watch 参数，Agent 侧不可用）。每轮对话只处理首个装载类中断（一轮只能装一件）。上报装载意图，本轮结束后执行，结果以回执进入当前会话并自动触发你的下一轮。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '插件目录（相对 cwd 或绝对路径，须含 manifest.json）' },
      },
      required: ['dir'],
    },
    // 动态 import 任意代码进宿主进程 = admin 边界（src CAPABILITY_ADMIN 语义；
    // M15 对账修正：此前 'dev' 是门禁降级）
    requiredTags: ['admin'],
    execute: async (args) => ({
      ok: true,
      output: { dir: args.dir, note: '装载将在本轮对话收束后执行（会话级，重启即失；永久安装请用 install_plugin）' },
      interrupt: {
        type: 'register-plugin',
        dir: args.dir,
      },
    }),
  });

  ctx.tools.register({
    name: 'install_plugin',
    description:
      '永久安装本地插件目录（免审：暂存 → 自动批准 → 立即装载；安装态写入 registry.json，重启自动恢复）。目录须含 manifest.json，缺省约定在调用方沙箱 files/<agentId>/ 下。授权面 = manifest permissions 全集（免审 = 无人审 ≠ 无门槛：仅 admin Agent 自开发自安装）。与 register_plugin 的分工：本工具用于定型驻留；开发迭代中的临时试跑用 register_plugin（会话级）。迭代重装语义：同 name+version 且内容一致 → 幂等返回已装状态（不重试装载）；有任何改动必须先 bump manifest.json 的 version 再重装。每轮对话只处理首个装载类中断（一轮只能装一件）。上报安装意图，本轮结束后执行，结果以回执进入当前会话并自动触发你的下一轮（可直接开始测试）。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '插件目录（相对 cwd 或绝对路径，须含 manifest.json）' },
      },
      required: ['dir'],
    },
    requiredTags: ['admin'],
    execute: async (args) => ({
      ok: true,
      output: { dir: args.dir, note: '安装将在本轮对话收束后执行（永久安装；临时试跑请用 register_plugin）' },
      interrupt: {
        type: 'install-plugin',
        dir: args.dir,
      },
    }),
  });

  ctx.tools.register({
    name: 'unregister_plugin',
    description:
      '卸载插件（会话级装载直接卸载；removeFromLibrary=true 时 = 永久卸载：移出插件库 registry.json，旧版本目录进 .backup——与 install_plugin 的"安装"对义的"卸载"，非仅停用）。上报卸载意图，本轮结束后执行，结果以回执进入当前会话（永久卸载附备份目录与消费方清单——已共享给其他 Agent 时列出悬空引用）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '插件名（manifest.name）' },
        removeFromLibrary: { type: 'boolean', description: '是否同时移出插件库 = 永久卸载进 .backup（缺省 false 仅卸载装载，安装态保留）' },
      },
      required: ['name'],
    },
    requiredTags: ['admin'], // 与 register_plugin 同边界（admin；M15 对账修正）
    execute: async (args) => ({
      ok: true,
      output: { name: args.name, note: '卸载将在本轮对话收束后执行' },
      interrupt: {
        type: 'unregister-plugin',
        name: args.name,
        ...(typeof args.removeFromLibrary === 'boolean' ? { removeFromLibrary: args.removeFromLibrary } : {}),
      },
    }),
  });

  // ---- 宿主半边辅助：目录解析 / 回执 / 回触 ----

  /** 相对目录按调用方沙箱基准解析（files/<agentId>；显式 settings.security.workdir 最优先） */
  function resolveDir(dir: string, agentId: string | undefined): string {
    if (path.isAbsolute(dir)) return path.resolve(dir);
    const ws = ctx.get('workspace') as
      | { sandboxWorkdir(id?: string): string | undefined }
      | undefined;
    const base = ws?.sandboxWorkdir(agentId) ?? process.cwd();
    return path.resolve(base, dir);
  }

  /**
   * 回执落账（F14/L6、G6）：session.append（owning 落盘口）追加 M21 中性
   * 格式（role:'agent' + agent_id=owner）。寻址用回调自带的 request
   * （conversationId 已是组键）——无会话上下文（宿主直调等）只记日志。
   */
  function writeReceipt(request: LoopRunRequest, text: string): void {
    const conversationId = request.conversationId;
    const owner = request.agent;
    if (!conversationId || !owner) {
      ctx.logger.info(`[pluginRegistry] 回执（无会话上下文，仅日志）: ${text}`);
      return;
    }
    const session = ctx.get('session') as
      | { append(conversationId: string, agentId: string, message: { role: string; content: string }): Promise<string> }
      | undefined;
    if (!session) {
      ctx.logger.warn('[pluginRegistry] session 服务不可用，回执仅日志（行组合缺 ac-session）');
      ctx.logger.info(`[pluginRegistry] 回执: ${text}`);
      return;
    }
    void session
      .append(conversationId, owner, { role: 'assistant', content: text })
      .catch((err: unknown) => {
        ctx.logger.warn(`[pluginRegistry] 回执落账失败: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /**
   * 回触（H1 闭环自驱动；2026-09-02 反馈修正回投目标）：回执落账后经
   * sender:'event' 信封回触**发起会话**（request.conversationId）——回执
   * 与下一轮驱动在同一会话，用户看得见完整闭环（install/register 成败
   * 都回触：失败文案可独立驱动下一步 bump version / 修复重装）。此前
   * 固定回 owner 自会话（pairKey(owner, owner)）：用户会话只剩失败回执
   * 即沉默、Agent 却在自会话里继续——表现为"会话中断"。无会话上下文
   * （宿主直调）回退自会话；conversation 串行化门排队（placement
   * next-run）+ MAX_AUTO_WAKES 防自激由 ac-conversation 承担。
   */
  function retrigger(request: LoopRunRequest, prompt: string): void {
    const owner = request.agent;
    if (!owner) {
      ctx.logger.info(`[pluginRegistry] 回触（无 Agent 身份，仅日志）: ${prompt}`);
      return;
    }
    const conversation = ctx.get('conversation') as
      | {
          deliver(
            agentId: string,
            inbound: { role: 'user'; content: string },
            options: {
              conversationId: string;
              sender: string;
              source: 'event';
              placement: 'next-run';
            },
          ): Promise<unknown>;
        }
      | undefined;
    if (!conversation) {
      ctx.logger.warn('[pluginRegistry] conversation 服务不可用，跳过回触（行组合缺 ac-conversation）');
      return;
    }
    const conversationId = request.conversationId ?? pairKey(owner, owner);
    void conversation
      .deliver(owner, { role: 'user', content: prompt }, {
        conversationId,
        sender: owner,
        source: 'event',
        placement: 'next-run',
      })
      .catch((err: unknown) => {
        ctx.logger.warn(`[pluginRegistry] 回触失败（${conversationId}）: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** 回执 + 回触一体（回执与回触同进发起会话——完整闭环用户可见） */
  function receiptAndRetrigger(request: LoopRunRequest, receipt: string, nextPrompt: string): void {
    writeReceipt(request, receipt);
    retrigger(request, nextPrompt);
  }

  // ---- 宿主半边：loop 收束后消费 toolInterrupt 执行装卸（主处理器只分发） ----

  /** register_plugin 消费：会话级装载（免审快照 = manifest permissions 全集，G6） */
  function consumeRegister(request: LoopRunRequest, dirInput: string): void {
    const owner = request.agent;
    const dir = resolveDir(dirInput, owner);
    // 免审快照 = manifest permissions 全集（G6：grants 参数已去除）
    let permissions: PluginPermission[] | undefined;
    try {
      permissions = loadManifestFromDir(dir).permissions;
    } catch {
      /* manifest 不可读 → 装载管道出可诊断 rejected 回执 */
    }
    void registry
      .load({
        dir,
        sessionOnly: true,
        ...(owner !== undefined ? { agentId: owner } : {}),
        ...(permissions ? { allowedPermissions: permissions } : {}),
      })
      .then((outcome) => {
        if (outcome.status === 'rejected') {
          const receipt = `[plugin] register_plugin 装载失败（${dir}）：${outcome.error}。下一步：修复错误后重新 register_plugin（会话级试跑）；定型驻留改用 install_plugin 并 bump version。`;
          receiptAndRetrigger(request, receipt, `[plugin] 你请求的会话级装载失败：${outcome.error}。请修复后重试 register_plugin，或 bump version 后 install_plugin 定型。`);
        } else {
          const receipt = `[plugin] register_plugin 已装载 ${outcome.name}（会话级，重启即失）。工具已注册进全局注册表，可直接调用测试。测试通过后用 install_plugin 永久安装（记得 bump version）。`;
          receiptAndRetrigger(request, receipt, `[plugin] 你请求的插件 "${outcome.name}" 已完成会话级装载（重启即失）。请立即开始测试它的工具；通过后用 install_plugin 定型驻留。`);
        }
        ctx.logger.info(`[pluginRegistry] register_plugin ${outcome.status === 'rejected' ? '失败' : '完成'}: ${outcome.name ?? dir}`);
      })
      .catch((err: unknown) => {
        // 装载管道异常（manifest 读取竞态等）：回执+回触驱动修复循环，杜绝 unhandledRejection
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`[pluginRegistry] register_plugin 装载异常（${dir}）: ${msg}`);
        receiptAndRetrigger(
          request,
          `[plugin] register_plugin 装载异常（${dir}）：${msg}。请修复后重试（会话级试跑）；定型驻留改用 install_plugin 并 bump version。`,
          `[plugin] 你请求的会话级装载出现内部异常：${msg}。请修复后重试 register_plugin。`,
        );
      });
  }

  /** install_plugin 消费：免审定型安装（rejected / 幂等 / 装载失败 / 成功 四态回执） */
  function consumeInstall(request: LoopRunRequest, dirInput: string): void {
    const owner = request.agent ?? 'host';
    const dir = resolveDir(dirInput, request.agent);
    void registry.installFromDir(dir, owner).then((result) => {
      if (result.status === 'rejected') {
        const receipt = `[plugin] install_plugin 安装失败：${result.error}${result.warning ? `（警告：${result.warning}）` : ''}。请按错误修复；若提示同版本哈希不一致，先在 manifest.json bump version 再重装。`;
        receiptAndRetrigger(request, receipt, `[plugin] 你请求的安装未完成：${result.error}。请修复后重新 install_plugin（同版本改动必须先 bump version）。`);
        return;
      }
      if (result.idempotent === true) {
        const state =
          result.load.status === 'loaded' ? '已装载（运行中）'
          : result.load.status === 'rejected' ? `装载失败：${result.load.error}`
          : '未装载（上次会话已卸载或未装载）';
        const receipt = `[plugin] install_plugin 幂等返回：${result.name}@${result.version} 已安装且内容一致（hash ${result.hash.slice(0, 8)}…），未重复装载。当前状态：${state}。注意：同 hash 重装不会重试装载——想重新装载请 bump version 后重装。`;
        receiptAndRetrigger(request, receipt, `[plugin] install_plugin 幂等返回：${result.name}@${result.version} 内容与已装版本一致，未重复装载（当前：${state}）。如需重试装载或更新代码，请 bump manifest version 后重装。`);
        return;
      }
      if (result.load.status === 'rejected') {
        const receipt =
          `[plugin] install_plugin 已安装 ${result.name}@${result.version}，但装载失败（安装不受影响，重启后会再试）：${result.load.error}。` +
          `${result.backupDir ? `旧版本备份：${result.backupDir}（可手工回滚）。` : ''}` +
          `修复后 bump version 重装即可；连续失败 3 次将熔断（boot 不再自动重试）。${result.warning ? `（警告：${result.warning}）` : ''}` +
          `${result.uiNonIsolated ? '（注意：该插件携带非隔离 UI——可读会话流、以用户会话身份调全部 RPC。）' : ''}`;
        receiptAndRetrigger(request, receipt, `[plugin] 你安装的 ${result.name}@${result.version} 已入安装态但装载失败：${result.load.error}。请修复代码，bump manifest version 后重新 install_plugin。`);
        return;
      }
      const receipt =
        `[plugin] install_plugin 完成：${result.name}@${result.version} 已安装并装载成功（安装态 = registry.json，重启自动恢复）。` +
        `请立即开始测试它的工具；后续迭代 = 改代码 → bump version → install_plugin 重装。${result.warning ? `（警告：${result.warning}）` : ''}` +
        `${result.uiNonIsolated ? '（注意：该插件携带非隔离 UI——可读会话流、以用户会话身份调全部 RPC。）' : ''}`;
      receiptAndRetrigger(request, receipt, `[plugin] 你安装的 ${result.name}@${result.version} 已装载成功。请立即开始测试它的工具；迭代时记得 bump version 再重装。`);
    })
    .catch((err: unknown) => {
      // 安装文件域/registry 写入异常：回执+回触驱动修复循环，杜绝 unhandledRejection
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`[pluginRegistry] install_plugin 安装异常（${dir}）: ${msg}`);
      receiptAndRetrigger(
        request,
        `[plugin] install_plugin 安装异常：${msg}。请修复后重试；同版本改动必须先 bump manifest version。`,
        `[plugin] 你请求的安装出现内部异常：${msg}。请修复后重新 install_plugin。`,
      );
    });
  }

  /** unregister_plugin 消费：removeFromLibrary=true → uninstall（代码回滚）；否则仅卸载装载 */
  function consumeUnregister(request: LoopRunRequest, name: string, removeFromLibrary: boolean): void {
    const consume = async (): Promise<void> => {
      if (removeFromLibrary) {
        const un = await registry.uninstall(name);
        const receipt =
          `[plugin] uninstall 完成：${un.name} 已移出插件库（代码回滚——目录进 ${un.backupDir ?? '.backup/'}；运行时副作用不随之回滚）。` +
          `${un.consumers && un.consumers.length > 0 ? `注意：该插件工具此前已共享给 ${un.consumers.length} 个 Agent（${un.consumers.join(', ')}），卸载后这些引用悬空。` : ''}`;
        receiptAndRetrigger(request, receipt, `[plugin] 你卸载的 ${un.name} 已完成（代码回滚进 .backup）。${un.consumers && un.consumers.length > 0 ? `其工具曾共享给：${un.consumers.join(', ')}（引用已悬空，必要时通知对方）。` : ''}请继续后续工作。`);
        ctx.logger.info(`[pluginRegistry] unregister_plugin 完成: ${JSON.stringify(un)}`);
      } else {
        const ok = await registry.unload(name);
        const receipt = ok
          ? `[plugin] 已卸载 ${name} 的装载（安装态保留，重启后会自动恢复装载；要彻底移除用 removeFromLibrary: true）。`
          : `[plugin] ${name} 未在装载中（无需卸载）。`;
        receiptAndRetrigger(request, receipt, `[plugin] 卸载装载${ok ? '完成' : '无效果（未装载）'}：${name}。请继续后续工作。`);
        ctx.logger.info(`[pluginRegistry] unregister_plugin 完成: ${JSON.stringify(ok)}`);
      }
    };
    consume().catch((err: unknown) => {
      // 卸载文件域（.backup 迁移等）异常：回执+回触，杜绝 unhandledRejection
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`[pluginRegistry] unregister_plugin 卸载异常（${name}）: ${msg}`);
      receiptAndRetrigger(
        request,
        `[plugin] unregister_plugin 卸载异常（${name}）：${msg}。安装态未受影响，可重试。`,
        `[plugin] 你请求的卸载出现内部异常：${msg}。可重试 uninstall_plugin。`,
      );
    });
  }

  ctx.on('loop/after-run', (request: LoopRunRequest, result: LoopRunResult) => {
    if (result.finish !== 'interrupted') return;
    const ti = result.interruptReason?.toolInterrupt;
    if (!ti) return;
    if (ti.type === 'register-plugin' && typeof ti.dir === 'string') consumeRegister(request, ti.dir);
    else if (ti.type === 'install-plugin' && typeof ti.dir === 'string') consumeInstall(request, ti.dir);
    else if (ti.type === 'unregister-plugin' && typeof ti.name === 'string') consumeUnregister(request, ti.name, ti.removeFromLibrary === true);
  }, { description: '收束检测装载/卸载意图 → 宿主执行（interrupt 半边）' });

  // 行偏好急救通道 plugin/patch-list·patch-set 注册在子行 patch-rpc.ts
  // （2026-08-30：急救 RPC 必须住在级联闭包外——ac-web-api 的静态 inject
  // 在行停用级联中阵亡；按「部分功能依赖独立成子插件行」拆行，避免把
  // 整个安装域硬绑到传输层。见 ./patch-rpc.ts） ----

  // ---- 启动扫描：已安装插件装载（安全模式/gates 屏障/熔断/hash 复验见 service） ----
  // C1：fire-and-forget 必须自带 catch——readRegistry 抛错（状态文件损坏）
  // 时这里是 unhandledRejection → Node ≥15 默认崩宿主 → supervisor 退避
  // 重拉 ×5 → 熔断全下线（C2 链）。降级为告警：已装插件本轮不装载，
  // 宿主与急救 RPC 面保活。
  void registry.loadInstalled().then(
    (outcomes) => {
      for (const o of outcomes) {
        if (o.status === 'rejected') {
          ctx.logger.warn(`[pluginRegistry] 启动装载 "${o.name}" 失败: ${o.error}`);
        }
      }
    },
    (err: unknown) => {
      ctx.logger.error(
        `[pluginRegistry] 启动装载扫描失败（已装插件本轮跳过，宿主继续）: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  );
}

export { PluginRegistryService } from './service.ts';
// 行偏好急救通道子行（级联闭包外注册 patch-list/patch-set；cordis.yml 走
// 本地路径行 './ac-plugin-registry/src/patch-rpc.ts'，TREE 走此出口）
export * as patchRpcRow from './patch-rpc.ts';
export type {
  PluginRegistryRowOptions,
  PluginLoadSpec,
  PluginLoadOutcome,
  PluginInstallResult,
  PluginSkipInfo,
  PluginLoadCall,
  PluginModule,
  LoadedPlugin,
  DevPluginInfo,
} from './service.ts';
