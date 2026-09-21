// ============================================================
// ac-skill —— 技能行（SkillsService，M14）
//
// src 轨道映射：agent-skill 的 discovered_skills runStart 钩子
// → preview 的 loop/before-run waterfall。发现/解析/渲染算法住
// 纯库 ac-skill-core（本行只做装配与 per-Agent 管控）。
//
// 形态差异（地图 §3.2）：
//   · 全局技能目录 <root>/skills/<dirName>/SKILL.md（src 为
//     per-Agent agentDir/skills；preview 全局共享 + per-Agent 白名单——
//     与"Agent 是数据、技能是共享资产"的注册表哲学一致）；
//   · settings['skill'] = { enabled?, whitelist? }——whitelist 命中
//     name 或 dirName；空白名单 = 暴露全部已发现技能（M24 A1 经
//     settingsOf 合成全局默认层）。
//   · 本 Agent 专属技能：<数据根>/files/<agentId>/skills/<dirName>/
//     SKILL.md（workspace.agentWorkdir 同款沙箱定位；无 workspace 行
//     回落 <数据根>/files/<agentId>/ 约定）。只对该 Agent 注入与加载，
//     不受全局 whitelist 约束——"Agent 私有技能"的承载面，补全
//     per-Agent 自身技能的诉求。
//   · 会话工作区技能（2026-11）：singles 会话挂载工作区后，扫描工作区
//     根下的业界约定技能目录（.claude/skills、.github/skills、skills、
//     .agents/skills、.dsh/skills——discoverWorkspaceSkills）——Claude Code /
//     GitHub Copilot 等维护的项目技能直接被会话复用。随会话挂载的
//     项目资产：不经 enabled/whitelist 门控（__standard__ 等无记忆
//     预设同样可见）；同名遮蔽序 = 本 Agent 专属 > 会话工作区 > 全局。
//   · load_skill 工具（参照 DSH dsh-tool-skill）：目录只给摘要
//     （name/description/location），模型按需经工具加载完整正文，
//     不再依赖 read 路径猜测；全局、本 Agent 专属与会话工作区均可按名加载。
//   · /name 手势去重（每消息至多服务一次）：同一 run 的多步循环不再
//     每步重复注入技能正文（此前含 /token 的用户消息在历史中始终在场，
//     每步都会重新触发——长 run 的重复 token 开销）；账本按循环工作
//     数组身份翻页，新 run（会话层浅拷贝新数组）重新服务。
//
// 懒扫描：首次消费（list/注入）才读目录并缓存；refresh() 重扫
// （技能目录增删后调用，webui/管理面的刷新口）。本 Agent 专属技能
// 目录随每次注入/加载现扫（目录小、且随 Agent 沙箱内容演进）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import type {} from 'ac-agents'; // ctx.agents 服务类型增强（type-only）

import { runAddress } from 'ac-agent-loop'; // run 地址（injectDurable 驻留注入通道锚）

import type { ToolResult } from 'ac-tools';
import {
  buildSkillsBlock,
  discoverSkills,
  discoverWorkspaceSkills,
  escapeXml,
  filterSkills,
  isSkillName,
  readSkillBody,
  type SkillGroup,
  type SkillManifest,
  type WorkspaceSkillGroup,
} from 'ac-skill-core';

/** 行配置（cordis.yml config / bootTree configs / 构造直传） */
export interface SkillRowOptions {
  /** 数据根目录（缺省 './data'，相对 cwd；技能目录 = <root>/skills） */
  root?: string;
  /** SKILL.md 路径提示前缀（缺省 <root>/skills 的 POSIX 形） */
  locationPrefix?: string;
}

/** settings['skill'] 配置形状（per-Agent；形状由本插件自定义） */
export interface SkillSettings {
  /** 缺省 true；false = 本 Agent 软停用（ADR-4） */
  enabled?: boolean;
  /** 技能白名单（name 或 dirName 命中皆可；空白名单 = 全部全局技能） */
  whitelist?: string[];
}

/** 某 Agent 的技能可见态（注入与 load_skill 共用同一合成口） */
export interface AgentSkillView {
  /** settings['skill'].enabled=false → 软停用（全局/专属不注入也不可加载；
   *  会话工作区组不受此门控——工作区技能是随会话挂载的项目资产） */
  disabled: boolean;
  /** 全局技能（白名单过滤后；该 Agent 可见的共享技能池） */
  global: SkillManifest[];
  /** 本 Agent 专属技能（files/<agentId>/skills；不受全局白名单约束） */
  own: SkillManifest[];
  /** 本 Agent 专属技能根目录（原始路径；无专属技能时为 undefined） */
  ownRoot?: string;
  /** 本 Agent 专属技能 SKILL.md location 前缀（POSIX 形） */
  ownPrefix?: string;
  /** 会话工作区技能组（singles 挂载工作区的多约定目录扫描；非 singles
   *  会话/未挂工作区 = 空数组） */
  workspace: WorkspaceSkillGroup[];
}

/** workspace 服务最小结构面（结构化读取，不引运行时依赖） */
interface WorkdirSource {
  agentWorkdir(agentId: string): string;
}

/** session 服务最小结构面（context 行落账 + 历史读取口；行未装时技能行只做步内注入） */
interface SessionRecordFace {
  recordContext(
    conversationId: string,
    agentId: string,
    content: string,
    extra: { source: string; label?: string; split?: boolean },
  ): void;
  /** 已落账行（跨 run 在场判定用；结构面只声明消费的字段） */
  records(conversationId: string): Promise<
    Array<{ role?: string; source?: string; agent_id?: string; content?: unknown }>
  >;
}

/** load_skill 工具输出形状（词汇 v2 轻量化：正文不随返回值走——注入
 *  机制保证在场，见 skill-injection-and-storage-vocab §1） */
export interface SkillLoadOutput {
  /** 技能名（<name>） */
  name: string;
  /** 来源：global = 全局共享池 / agent = 本 Agent 专属 / workspace = 会话工作区 */
  scope: 'global' | 'agent' | 'workspace';
  /** 技能目录（SKILL.md 所在目录；相对引用以此为基准） */
  baseDir: string;
  /** 注入状态：正文已注入会话上下文（context 行/步内注入），按其指令执行 */
  status: 'injected';
}

/** /name 用户调用手势（DSH SKILL_GESTURE 同款）：用户消息中以空白为界、
 *  kebab-case 的 /<name> token；行中 URL（https://）不命中 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

/** 扫描单条用户消息中的 /<name> 调用手势（去重保序） */
function scanSkillGestures(message: { role?: string; content?: unknown }): string[] {
  const names: string[] = [];
  if (message.role !== 'user') return names;
  const content = message.content;
  const texts = typeof content === 'string' ? [content]
    : Array.isArray(content)
      ? content.filter((b): b is { type: 'text'; text: string } =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text'
        && typeof (b as { text?: unknown }).text === 'string')
        .map((b) => b.text)
      : [];
  for (const text of texts) {
    for (const match of text.matchAll(SKILL_GESTURE)) {
      const name = match[2];
      if (name !== undefined && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** 手势注入体识别：本行产出的 <system-reminder> user 消息（正文含
 *  技能指令，可能出现 /token 词形——识别以跳过扫描，防级联触发） */
function isGestureInjection(message: { role?: string; content?: unknown }): boolean {
  return message.role === 'user'
    && typeof message.content === 'string'
    && (message.content.startsWith('<system-reminder>用户以 /<name> 显式调用以下技能')
      || message.content.startsWith('<system-reminder>以下技能已加载（load_skill）'));
}

/** 子调用登记键：<agentId>|<conversationId>（双身份齐备才有账） */
function subcallKey(agentId: string | undefined, conversationId: string | undefined): string | undefined {
  if (agentId === undefined || conversationId === undefined) return undefined;
  return agentId + '|' + conversationId;
}

/** [引用约定] 词形锚点（ac-fs-tools @路径 / ac-session-query #会话 /
 *  ac-collab-tools @名称 三条 owner 行注入的共同前缀） */
const REFERENCE_GUIDE_ANCHOR = '[引用约定]';

/**
 * 收敛式定序插入：技能块恒居 [引用约定] 组之前。Loader 路径（官方 boot）
 * 行并发创建（行序 ≠ 激活序），主档 append 序不可依赖；技能块锚定
 * [引用约定] 词形插到首条引用约定所在行之前，使任意激活顺序收敛到同一
 * 形态（技能块在前、引用约定组聚齐在后）——与尾档「system-prompt 恒
 * unshift / datetime 恒 push」同族的收敛式定序。锚点不存在 = 追加末尾
 * （保持既有 append 语义）。
 */
function insertSkillsBlock(base: string | undefined, block: string): string {
  if (base === undefined || base === '') return block;
  const anchor = base.indexOf(REFERENCE_GUIDE_ANCHOR);
  if (anchor < 0) return `${base}\n\n${block}`;
  // 锚点回退到所在行行首并剥掉 head 尾部换行（统一以 \n\n 重接，防空洞/粘连）
  let cut = anchor;
  while (cut > 0 && (base[cut - 1] === '\n' || base[cut - 1] === '\r')) cut--;
  const head = base.slice(0, cut).replace(/[\r\n]+$/, '');
  const tail = base.slice(cut);
  return head ? `${head}\n\n${block}\n\n${tail}` : `${block}\n\n${tail}`;
}

/** 技能名 → 目录定位的越界守卫（load 面路径白名单） */
function assertInside(root: string, dirName: string): string {
  const rootAbs = path.resolve(root);
  const dir = path.resolve(rootAbs, dirName);
  if (dir !== rootAbs && !dir.startsWith(rootAbs + path.sep)) {
    throw new Error(`技能目录越界（${dirName}）`);
  }
  return dir;
}

export class SkillsService extends Service {
  /** 事件闭包/工具执行访问 ctx.agents/settings、ctx.tools 注册——M12 铁律 1。
   *  agentLoop 不进硬依赖：injectDurable 驻留注入按需探测（ctx.get
   *  可选口）——loop 行缺席时技能行照常装配（目录/手势/加载面不受拖垮，
   *  与可选能力行「摘行不拖垮 RPC 面」红线同口径）；事件回调里 loop 缺席
   *  则无 run 可驻留，探测恒 undefined 即跳过。 */
  static inject = ['agents', 'tools'];

  private dataRoot: string;
  private skillsRoot: string;
  private locationPrefix: string;
  private cache: SkillManifest[] | null = null;
  /** run_code 子调用技能待落账清单：键 = <agentId>|<conversationId>，
   *  值 = 本 run 内新登记的技能（name → 注入正文；after-execute 登记
   *  （已落账在场判定——重复 load 不重登记），before-step 首见驻留注入
   *  + 落账，after-run 兜底清账——跨 run 不残留） */
  private subcallPending = new Map<string, Map<string, { name: string; body: string }>>();

  constructor(ctx: Context, options: SkillRowOptions = {}) {
    super(ctx, 'skills');
    const root = options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data';
    this.dataRoot = path.resolve(root);
    this.skillsRoot = path.join(this.dataRoot, 'skills');
    this.locationPrefix =
      options.locationPrefix ?? `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/skills`;

    // ---- before-run 注入 <available_skills>：会话工作区（约定目录） +
    //      全局（白名单过滤）+ 本 Agent 专属 ----
    this.ctx.on('loop/before-run', (call, next) => {
      const state = this.agentSkillState(call.request.agent, call.request.conversationId);
      const groups: SkillGroup[] = [];
      // 工作区组：随 singles 会话挂载的项目资产——不经 enabled/whitelist
      // 门控（与附件同语义：挂了就在，__standard__ 等无记忆预设同样可见）
      for (const g of state.workspace) {
        groups.push({ skills: g.skills, locationPrefix: g.locationPrefix });
      }
      if (!state.disabled) {
        if (state.global.length > 0) {
          groups.push({ skills: state.global, locationPrefix: this.locationPrefix });
        }
        if (state.own.length > 0 && state.ownPrefix) {
          groups.push({ skills: state.own, locationPrefix: state.ownPrefix });
        }
      }
      const block = buildSkillsBlock(groups);
      if (block) {
        call.request = {
          ...call.request,
          system: insertSkillsBlock(call.request.system, block),
        };
      }
      return next();
    }, { description: '注入 <available_skills> 会话工作区 + 全局 + 本 Agent 专属技能目录' });

    // ---- /name 用户显式调用：before-run 判定 + 持久化注入（存储词汇 v2，
    //      skill-injection-and-storage-vocab §1）——只判「当前触发消息」=
    //      request.messages 尾部连续 user 块（已服务者与后续消息之间有
    //      context/reply 行天然分界）；命中技能经 session 落账 role:'context'
    //      行（跨 run 永久回放，KV 前缀友好）+ 同字节 append 进
    //      request.messages（当前 run 即刻生效——双写同源，无瞬态/持久漂移）。
    //      语义变更（显式签收，档案 §5）：历史手势不再逐 run 重扫（去重
    //      依据 = 历史 context 行在场）；mid-run steer 的手势不再服务（判定
    //      收窄为 run 触发消息）；手势未命中不再补偿（一次性判定）。
    //      gestureServed 账本退役——注入体持久在场即天然去重。
    this.ctx.on('loop/before-run', (call, next) => {
      const req = call.request;
      // 无会话键无处落账（宿主直调 agentLoop 的测试路径）：跳过判定
      if (req.conversationId === undefined) return next();
      const state = this.agentSkillState(req.agent, req.conversationId);
      const names = this.pendingGestureNames(req.messages);
      if (names.length === 0) return next();
      // 与目录注入同一可见性口径（locateSkill 内含遮蔽序与门控）
      const bodies = names
        .map((name) => this.renderSkillContent(name, state))
        .filter((body) => body !== '');
      if (bodies.length === 0) return next(); // 未命中：一次性判定，不再补偿（档案 §5-2）
      this.injectSkillContext(req.agent, req.conversationId, bodies);
      // 双写同源：append 进 request.messages（当前 run 首步即可见——
      // session 落账行与工作数组注入体同字节，history() 回放亦同形）
      req.messages = [
        ...req.messages,
        {
          role: 'user',
          content: `<system-reminder>用户以 /<name> 显式调用以下技能，按其指令执行；这些技能已内联注入，无需再经 load_skill 加载。\n${bodies.join('\n')}</system-reminder>`,
        },
      ];
      return next();
    }, { description: '/name 手势 before-run 判定 + context 行持久化注入（每消息一次）' });

    // ---- load_skill：按 <name> 加载完整指令（参照 DSH skill 工具） ----
    // infra 标签（2026-09-16 全量标签化）：技能加载属会话基础设施
    this.ctx.tools.register({
      name: 'load_skill',
      requiredTags: ['infra'],
      description:
        '按名称加载一个技能的完整指令正文（<available_skills> 中列出的技能：会话工作区、全局与本 Agent 专属均可；加载后按其指令执行，不再重复加载）。注意：注入型工具——返回值只有 name/scope/baseDir/status:"injected" 回执，正文不进返回值（由注入机制随后进入上下文）；程序内判定成功看 status 字段，不要把返回值当数据处理。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '技能名（<available_skills> 条目中的 <name>，kebab-case）',
          },
        },
        required: ['name'],
      },
      execute: (args, call) =>
        this.loadSkill(
          typeof args.name === 'string' ? args.name : '',
          call.agentId,
          call.conversationId,
        ),
    });

    // ---- run_code 子调用 load_skill：after-execute 登记（已落账在场

    //      判定——跨 run 重复 load 不再登记）→ before-step 首见时

    //      injectDurable 驻留注入（run 级：进 execute 工作数组一次，后续步

    //      继承前缀——KV 全命中；旧「每步尾部重现」形态 2026-11 退役：尾部

    //      字节稳定但位于前缀分叉点之后，等于每步重算整块正文）→ after-run

    //      收束兜底（无下一步形态直落）。当前 run 后续步靠驻留继承，下轮

    //      run 起历史 context 行在场。直调不登记——run 行 steps 携带结果，

    //      replayTrajectory 展开即正文在场。
    this.ctx.on('tool/after-execute', async (call, result) => {
      if (call.name !== 'load_skill' || !result.ok) return;
      if (call.runCodeSubcall !== true) return;
      const out = result.output as SkillLoadOutput | undefined;
      if (!out || typeof out.name !== 'string') return;
      const agentId = call.agentId;
      const conversationId = call.conversationId;
      const key = subcallKey(agentId, conversationId);
      if (agentId === undefined || conversationId === undefined || key === undefined) return;
      // 正文现读（返回值已轻量化）：与 loadSkill 同源 renderSkillContent
      const state = this.agentSkillState(agentId, conversationId);
      const body = this.renderSkillContent(out.name, state);
      if (body === '') return; // 读取失败（不注入坏块，与手势口径一致）
      // 同步占位（并行 load 不互覆登记）：并行子调用在各自 await 期间都见
      // pending === undefined 会各建新 Map 后互相覆盖——先同步 claim 再进
      // 异步判定。
      let pending = this.subcallPending.get(key);
      if (pending === undefined) {
        pending = new Map<string, { name: string; body: string }>();
        this.subcallPending.set(key, pending);
      }
      if (!pending.has(out.name)) {
        // 跨 run 去重（每技能一行 bug 根修）：已落账的注入体在历史 context
        // 行在场（回放已可见）→ 不再登记。原实现每 run 重新登记 + 每步重
        // 注入 + 收束再落一行 = 同一技能 3+ 份正文在场。records() 含在途
        // flush（mtime 门控缓存，低频 load 成本可忽略）。
        const recorded = await this.recordedSkillContexts(agentId, conversationId);
        if (recorded.includes(out.name)) return;
        if (this.subcallPending.get(key) !== pending) {
          // await 期间 run 已收束（after-run 清账）→ 直落 context 行兜底
          this.recordSkillContext(
            agentId,
            conversationId,
            [this.renderInjectedReminder([body])],
            `已加载技能 ${out.name}`,
            true,
          );
          return;
        }
      }
      pending.set(out.name, { name: out.name, body });
    });
    this.ctx.on('loop/before-step', (call, next) => {
      const key = subcallKey(call.agent, call.conversationId);
      const pending = key === undefined ? undefined : this.subcallPending.get(key);
      if (pending === undefined || pending.size === 0) return next();
      const names = [...pending.keys()].filter((n) => n !== '__recorded__').sort();
      if (names.length === 0) return next();
      const bodies = names.map((n) => pending.get(n)!.body);
      const content = this.renderInjectedReminder(bodies);
      // 落账（变体乙 split）：首见 pending 集即切分落 context 行（落位 =
      // 进入消息数组的位置）；pending 变化（新技能）再落新行。per-run 首步
      // 注入时刻 = 正文实际进入消息数组的位置。__recorded__ 只防本 run 内
      // 指纹变化后的重复落账（数值键身份比对：过滤后重 set 不丢身份）；
      // 跨 run 在场判定在登记时做（已落账技能不再入 pending）。
      const fingerprint = names.join('|');

      const state = pending.get('__recorded__');

      // 指纹读 body（写入字段）——原实现误读 fp 字段导致比对从未生效

      const recordedFp = state !== undefined ? (state as unknown as { body?: string }).body : undefined;

      if (recordedFp !== fingerprint) {

        pending.set('__recorded__', { name: '__recorded__', body: fingerprint } as { name: string; body: string });

        this.recordSkillContext(call.agent, call.conversationId, [content], `已加载技能 ${names.join('、')}`, true);

        // 【run 级驻留注入（2026-11 裁决）】指纹变化（新技能/首次）→ 注入体

        // 经 injectDurable 进 execute 工作数组一次，后续步自然继承。旧形态

        // 是「每步 before-step 重现注入体」——字节虽稳定但每次都在请求尾部

        // （前缀分叉点之后），KV 严格前缀匹配下等于每步重算整块正文（实测

        // 11KB 技能 ≈5K tokens/步 × 6 步 ≈ 3 万 tokens 浪费）。驻留后注入

        // 点进前缀，后续步全量命中。指纹未变（后续步）→ 不再注入（数组里

        // 已有）。持久性由上方落账的 context 行承担（跨 run 可见）。

        const handle = runAddress(call.agent, call.conversationId);
        const loop = this.ctx.get('agentLoop', false) as
          | { injectDurable(handle: string, message: { role: 'user'; content: string }): boolean }
          | undefined;
        if (handle !== undefined && loop !== undefined) {
          loop.injectDurable(handle, { role: 'user', content });
        }

      }

      return next();

    }, { description: 'run_code 子调用技能注入（run 级驻留——进数组一次后续步继承）+ context 行落账' });
    // 收束兜底（2026-09-20 单步 run 丢失修复）：before-step 注入时刻落账
    // 需要「下一步」存在——load 后无下一步的形态（max-steps 耗尽/中断）
    // pending 挂着无人消费 = context 行丢失。after-run 时指纹未落过即补落
    // （split=true：run 已收束走直落分支，位置在收束行后——次优但正文在
    // 场）。落过（指纹一致）→ 跳过。
    this.ctx.on('loop/after-run', (request) => {
      const key = subcallKey(request.agent, request.conversationId);
      if (key === undefined) return;
      const pending = this.subcallPending.get(key);
      this.subcallPending.delete(key);
      if (pending === undefined) return;
      const fp = pending.get('__recorded__');
      const recorded = fp !== undefined ? (fp as unknown as { body?: string }).body : undefined;
      // 未曾落账（本 run 无下一步）→ 收束后直落；已落账（指纹一致）→ 跳过
      const names = [...pending.keys()].filter((n) => n !== '__recorded__').sort();
      if (names.length === 0) return;
      const fingerprint = names.join('|');
      if (recorded === fingerprint) return;
      const bodies = names.map((n) => pending.get(n)!.body);
      this.recordSkillContext(
        request.agent,
        request.conversationId,
        [this.renderInjectedReminder(bodies)],
        '已加载技能 ' + names.join('、'),
        true,
      );
    });
  }

  /** 已发现全局技能清单（懒扫描：首次调用触发；按名称排序） */
  list(): SkillManifest[] {
    if (this.cache === null) this.refresh();
    return this.cache ?? [];
  }

  /** 重扫全局技能目录（目录增删后的刷新口） */
  refresh(): SkillManifest[] {
    this.cache = discoverSkills(this.skillsRoot);
    return this.cache;
  }

  /** 某 Agent 可见的全局（白名单过滤）+ 本 Agent 专属技能（供注入/管理面） */
  listForAgent(agentId: string, conversationId?: string): { global: SkillManifest[]; own: SkillManifest[]; workspace: WorkspaceSkillGroup[] } {
    const state = this.agentSkillState(agentId, conversationId);
    return {
      global: state.disabled ? [] : state.global,
      own: state.disabled ? [] : state.own,
      workspace: state.workspace,
    };
  }

  /**
   * 某 Agent（+ 可选会话）的技能可见态：enabled / 全局白名单 / 专属目录
   * 现扫 / 会话工作区约定目录扫描。注入与 load_skill 共用——各入口看到
   * 的是同一份清单。工作区组不受 disabled/whitelist 门控（会话挂载资产）。
   */
  private agentSkillState(agentId: string | undefined, conversationId?: string): AgentSkillView {
    const state: AgentSkillView = { disabled: false, global: [], own: [], workspace: [] };
    // 会话工作区组（singles 挂载；其余会话形态恒空）——现扫不缓存：
    // 工作区内容随用户编辑演进，弹层/注入按需扫描成本低（约定目录 readdir）
    const wsRoot = this.workspaceOf(conversationId);
    if (wsRoot) state.workspace = discoverWorkspaceSkills(wsRoot);
    if (agentId === undefined) {
      state.global = filterSkills(this.list());
      return state;
    }
    const cfg = this.ctx.agents.settingsOf(agentId, 'skill');
    let whitelist: string[] | undefined;
    if (cfg !== undefined && cfg !== null && typeof cfg === 'object') {
      const skillSettings = cfg as SkillSettings;
      if (skillSettings.enabled === false) {
        state.disabled = true;
        return state;
      }
      if (Array.isArray(skillSettings.whitelist)) {
        whitelist = skillSettings.whitelist.filter((s): s is string => typeof s === 'string');
      }
    }
    state.global = filterSkills(this.list(), whitelist);
    const ownRoot = this.agentOwnSkillsRoot(agentId);
    // 预设/未注册 Agent 的 workdir = 数据根 → own 目录即全局 skills 目录：
    // 重复扫描只会把全局清单镜像成"专属"（skills/list 读面会看到双份），
    // 直接不计。常规 Agent（files/<id>）不受影响。
    if (ownRoot === this.skillsRoot) return state;
    const own = discoverSkills(ownRoot);
    if (own.length > 0) {
      state.own = own;
      state.ownRoot = ownRoot;
      state.ownPrefix = ownRoot.replace(/\\/g, '/');
    }
    return state;
  }

  /** 本 Agent 专属技能根：workspace.agentWorkdir 唯一事实源；未装 workspace
   *  行回落 <数据根>/files/<agentId>/ 同一约定（与 ac-memory/ac-archive 口径一致） */
  private agentOwnSkillsRoot(agentId: string): string {
    const ws = this.ctx.get('workspace') as WorkdirSource | undefined;
    const dir = ws ? ws.agentWorkdir(agentId) : path.join(this.dataRoot, 'files', agentId);
    return path.join(dir, 'skills');
  }

  /**
   * 会话工作区根（singles 挂载工作区 → 本机路径；其余会话形态/未挂 = null）。
   * workspace.conversationWorkspaceRoot 唯一事实源（与沙箱基准/允许根、
   * 提示词 [工作目录] 展示同源不漂移）；workspace 行未装时回落自带链
   * （singles 记录 → listWorkspaces——技能行不因此硬依赖 workspace）。
   */
  private workspaceOf(conversationId: string | undefined): string | null {
    if (!conversationId) return null;
    const ws = this.ctx.get('workspace') as
      | { conversationWorkspaceRoot?(cid: string): string | null }
      | undefined;
    if (typeof ws?.conversationWorkspaceRoot === 'function') {
      return ws.conversationWorkspaceRoot(conversationId);
    }
    const singles = this.ctx.get('singles') as
      | { get(sid: string): { workspaceId?: string } | null }
      | undefined;
    const record = singles?.get(conversationId);
    const wsId = typeof record?.workspaceId === 'string' ? record.workspaceId : '';
    if (!wsId) return null;
    const workspace = this.ctx.get('workspace') as
      | { listWorkspaces(): Array<{ id: string; path: string }> }
      | undefined;
    return workspace?.listWorkspaces().find((w) => w.id === wsId)?.path ?? null;
  }

  /** 按名定位技能（优先序 = 特异性：本 Agent 专属 > 会话工作区 > 全局；
   *  disabled 时全局/专属清单恒空——命中只可能是工作区组） */
  private locateSkill(name: string, state: AgentSkillView): { hit: SkillManifest; root: string; scope: SkillLoadOutput['scope'] } | null {
    const ownHit = state.own.find((s) => s.name === name);
    if (ownHit) return { hit: ownHit, root: state.ownRoot as string, scope: 'agent' };
    for (const g of state.workspace) {
      const wsHit = g.skills.find((s) => s.name === name);
      if (wsHit) return { hit: wsHit, root: g.root, scope: 'workspace' };
    }
    const globalHit = state.global.find((s) => s.name === name);
    if (globalHit) return { hit: globalHit, root: this.skillsRoot, scope: 'global' };
    return null;
  }

  /** /name 手势注入的正文渲染（<skill_content> 包装）；定位不到/读取
   *  失败 → 空串（不注入坏块，模型可回落 load_skill 拿到可读错误） */
  private renderSkillContent(name: string, state: AgentSkillView): string {
    const located = this.locateSkill(name, state);
    if (!located) return '';
    try {
      const dir = assertInside(located.root, located.hit.dirName);
      const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
      return `<skill_content name="${escapeXml(name)}">\n${readSkillBody(content)}\n</skill_content>`;
    } catch {
      return '';
    }

  }

  /**

   * before-run 手势判定：request.messages 尾部连续 user 块中的 /<name>

   * token（去重）——「当前触发消息」语义（档案 §1）。历史消息不判定：

   * 其手势已被服务（注入体/技能 context 行在历史中场即天然分界），逐 run

   * 重扫重注入正是 KV 漏损的根因。注入体自身跳过（防级联）。

   */

  private pendingGestureNames(messages: { role?: string; content?: unknown }[]): string[] {

    const names: string[] = [];

    let sawInjection = false;
    for (let i = messages.length - 1; i >= 0; i--) {

      const message = messages[i];

      if (message.role !== 'user') break; // 尾部连续 user 块到非 user 为止

      if (isGestureInjection(message)) {
        // 已有注入体在块内 = 手势已服务（busy 排队重触发窗口）——天然
        // 去重：注入体之前的消息正是触发它的消息，整块跳过
        sawInjection = true;
        continue;
      }
      if (sawInjection) continue; // 注入体之前的消息：已服务过

      for (const name of scanSkillGestures(message)) {

        if (!names.includes(name)) names.push(name);

      }

    }

    return names.reverse(); // 保持消息内出现序

  }

  /**

   * 手势通道落账（档案 §1）：session 落账 context 行（跨 run 永久回放）。

   * 工作数组 append 已由 before-run 钩子完成（同字节渲染）。

   */

  private injectSkillContext(

    agentId: string | undefined,

    conversationId: string | undefined,

    bodies: string[],

  ): void {

    this.recordSkillContext(

      agentId,

      conversationId,

      bodies,

      '用户调用技能 ' + this.skillNamesOf(bodies),

    );

  }

  /** context 行落账（session 结构化面；source:'skill' + label） */

  private recordSkillContext(

    agentId: string | undefined,

    conversationId: string | undefined,

    bodies: string[],

    label: string,

    split = false,

  ): void {

    if (agentId === undefined || conversationId === undefined) return;

    const session = this.ctx.get('session') as SessionRecordFace | undefined;

    if (!session || typeof session.recordContext !== 'function') return; // session 行未装：只做步内注入，不落账

    session.recordContext(conversationId, agentId, bodies.join('\n\n'), {

      source: 'skill',

      label,

      ...(split ? { split: true } : {}),

    });

  }

  /** 已落账技能 context 行的技能名清单（跨 run 在场判定）：扫历史行
   *  source='skill' 且 content 含 <skill_content name="<name>"> 的注入体，
   *  提取已注入技能名。手势行（"用户调用技能"）同源扫——两种通道去重
   *  口径一致：注入体在场即不再重注。session 行未装 → 空清单（回落
   *  旧行为：无历史可判，登记不拦截）。 */
  private async recordedSkillContexts(agentId: string, conversationId: string): Promise<string[]> {
    const session = this.ctx.get('session', false) as SessionRecordFace | undefined;
    if (!session || typeof session.records !== 'function') return [];
    let records: Array<{ role?: string; source?: string; agent_id?: string; content?: unknown }> = [];
    try {
      records = await session.records(conversationId);
    } catch {
      return []; // 读失败按无历史处理（fail-open，与手势口径一致）
    }
    const names: string[] = [];
    for (const r of records) {
      if (r.source !== 'skill') continue;
      if (r.agent_id !== undefined && r.agent_id !== agentId) continue;
      const content = typeof r.content === 'string' ? r.content : '';
      const m = content.match(/<skill_content name="([^"]+)">/);
      if (m && m[1] && !names.includes(m[1])) names.push(m[1]);
    }
    return names;
  }

  /** 子调用注入体渲染（before-step 与 after-run 兜底共用，字节同源） */
  private renderInjectedReminder(bodies: string[]): string {
    return '<system-reminder>以下技能已加载（load_skill），按其指令执行；正文已注入，无需重复加载。\n' + bodies.join('\n') + '</system-reminder>';
  }

  /** 注入体 → label 技能名串（skill_content name 提取） */

  private skillNamesOf(bodies: string[]): string {

    const names: string[] = [];

    const re = /<skill_content name="([^"]+)">/;

    for (const body of bodies) {

      const m = body.match(re);

      if (m && !names.includes(m[1])) names.push(m[1]);

    }

    return names.join('、');

  }

  /** load_skill 执行体：按名解析（本 Agent 专属 > 会话工作区 > 全局）+ 读正文 */
  private loadSkill(name: string, agentId: string | undefined, conversationId?: string): ToolResult {
    if (!isSkillName(name)) throw new Error(`技能名 "${name}" 非法（须 kebab-case，如 pdf-export）`);
    if (!agentId) throw new Error('技能加载需要 Agent 身份（load_skill 仅供 Agent 会话内调用）');
    const state = this.agentSkillState(agentId, conversationId);
    const located = this.locateSkill(name, state);
    if (!located) {
      throw new Error(
        state.disabled
          ? `技能 "${name}" 不可用（该 Agent settings.skill.enabled=false，全局/专属技能已停用；会话工作区技能不受此门控）`
          : `技能 "${name}" 不存在或当前不可用（仅目录中列出的技能可加载）`,
      );
    }
    const dir = assertInside(located.root, located.hit.dirName);
    const file = path.join(dir, 'SKILL.md');
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      throw new Error(`技能 "${name}" 读取失败：${err instanceof Error ? err.message : String(err)}`);
    }
    // 返回值轻量化（档案 §1 前提）：正文不随返回值走（run_code 场景防
    // 「返回一份 + 注入一份」双份冗余与搬运诱饵）——注入由 after-execute
    // 登记 + before-step 瞬态注入 + 收束落账三段保证；程序内分析 SKILL.md
    // 改走 read（baseDir 在返回值）。
    const output: SkillLoadOutput = {
      name: located.hit.name,
      scope: located.scope,
      baseDir: dir.replace(/\\/g, '/'),
      status: 'injected',
    };
    return { ok: true, output };
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 技能服务（ac-skill 提供）：全局 + 本 Agent 专属 + 会话工作区技能发现、before-run 注入、load_skill */
    skills: SkillsService;
  }
}

// KV Cache effect（M21/D9 声明纪律）: Prefix-stable —— <available_skills>
// 渲染确定性（目录与白名单不变则字节不变；本 Agent 专属组随 Agent 沙箱
// skills/ 内容与请求 Agent 而定；会话工作区组随会话挂载工作区的约定
// 目录内容而定）。插入位置同样确定性：锚定 [引用约定] 词形（三条引用
// 约定行自身条件安装、只依赖工具集），同 Agent + 同工具集 → 位置不变。
// 显式失效：技能增删/白名单修改/工作区技能增删 = invalidate-from-X
// （该桶一次 system 重置）。load_skill 走工具结果（仅追加历史），不进
// system——不参与 system 前缀。

export const name = 'ac-skill';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'skill',
  label: '技能注入',
  description: '注入 <available_skills>（全局技能目录 + 本 Agent 专属 files/<agent>/skills + 会话工作区约定目录 .claude/.github/skills 等）+ load_skill 按名加载 + /name 用户显式调用确定性注入',
  fields: [
    { name: 'whitelist', type: 'list', description: '全局技能白名单——留空 = 全部全局技能可见；本 Agent 专属技能不受此约束；每行一个技能名' },
    { name: 'enabled', type: 'boolean', default: true, description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
  ],
  listeners: [
    { event: 'loop/before-run', role: '注入 <available_skills> + /name 手势判定', description: 'Agent 循环启动前拦截：技能目录注入（装配链一环）+ 当前触发消息尾部 user 块的 /<name> 判定——命中落账 context 行（跨 run 永久回放）+ 工作数组双写（每消息一次）', respectsEnabled: true },
    { event: 'loop/before-step', role: 'run_code 子调用技能驻留注入', description: '本 run 内 load_skill 子调用新登记的技能，指纹首见时经 injectDurable 驻留注入（进工作数组一次，后续步继承前缀——KV 全命中）+ context 行切分落账；已落账技能跨 run 不重注', respectsEnabled: true },
    { event: 'loop/after-run', role: 'run_code 技能收束兜底', description: 'run 收束时 pending 仍有未落账指纹（load 后无下一步的形态）→ 收束行后直落 context 行兜底（正文在场）', respectsEnabled: true },
    { event: 'tool/after-execute', role: 'run_code 子调用 load_skill 登记', description: 'load_skill 子调用成功后现读正文登记 pending（已落账在场判定——跨 run 重复 load 不再登记）', respectsEnabled: true },
    { event: 'loop/steer-dropped', role: 'steer 未消费兜底', description: 'run 收束清队时未被消费的注入按原形态补落账（不丢用户事实）', respectsEnabled: false },
  ],
};

export const inject = ['agents', 'tools'];

export function apply(ctx: Context, options: SkillRowOptions = {}) {
  ctx.plugin(SkillsService, options);
}
