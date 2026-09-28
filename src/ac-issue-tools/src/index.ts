// ============================================================
// ac-issue-tools/src/index.ts —— ISSUE 反馈工具行（submit_issue）
//
// 用户经 Agent 把 ISSUE 直接发到 Git 托管台（GitHub/Gitee；
// apiBase 覆盖可接 GitHub 兼容自建台如 Gitea），多一条反馈
// 通道。链路形态照 ac-web-tools：
//   · 目的地解析链：args（LLM 显式覆盖）→ settings
//     [issue-tools] → 行配置 → 内置缺省（本产品主仓库）
//   · 令牌三源链：行直配 → ac-credentials（provider
//     github/gitee，Agent 级→全局）→ env GITHUB_TOKEN/GITEE_TOKEN
//   · 门禁：requiredTags [web]（网络词表复用，无新标签）+
//     needPermission（非 LLM 出口通道——base 档审批、sandbox
//     档自由）
// ============================================================
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-tools'; // ctx.tools 服务类型增强（type-only，无运行时依赖）
import type { ExtensionMeta } from 'ac-extension-core';

export const name = 'ac-issue-tools';

// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明 ──
export const extension: ExtensionMeta = {
  name: 'issue-tools',
  label: 'ISSUE 反馈',
  description: 'submit_issue 工具：把 ISSUE 发到 GitHub/Gitee 仓库（反馈通道）',
  automatic: true,
  fields: [
    { name: 'enabled', type: 'boolean', description: '停用 submit_issue 工具（缺省启用）' },
    { name: 'server', type: 'string', enum: ['github', 'gitee'], description: '默认托管台（缺省 github）' },
    { name: 'repo', type: 'string', description: '目标仓库 owner/repo（缺省 = 本产品主仓库）' },
    { name: 'apiBase', type: 'string', description: 'API 前缀覆盖（GitHub 兼容自建台，如 Gitea 的 https://git.example.com/api/v3）' },
    { name: 'labels', type: 'list', description: '附加标签（与调用参数并集；Gitee 上限 5 个）' },
  ],
};

export interface IssueToolsRowOptions {
  /** 托管台（缺省 github） */
  server?: 'github' | 'gitee';
  /** 目标仓库 owner/repo（缺省本产品主仓库） */
  repo?: string;
  /** 访问令牌直配（缺省走 ac-credentials / 环境变量链） */
  token?: string;
  /** API 前缀覆盖（GitHub 兼容自建台如 Gitea） */
  apiBase?: string;
  /** 附加标签（与 settings/args 并集；Gitee 上限 5 个） */
  labels?: string[];
}

/** settings[issue-tools] 的 per-Agent 配置形状（令牌不进 settings——统一走凭据链/行配置） */
interface IssueToolsSettings {
  enabled?: boolean;
  server?: 'github' | 'gitee';
  repo?: string;
  apiBase?: string;
  labels?: string[];
}

const DEFAULT_SERVER = 'github';
const DEFAULT_REPO = 'nefevcore/AgentChat';
const GITHUB_API_BASE = 'https://api.github.com';
const GITEE_API_BASE = 'https://gitee.com/api/v5';
const ENV_TOKEN: Record<'github' | 'gitee', string> = { github: 'GITHUB_TOKEN', gitee: 'GITEE_TOKEN' };
const TITLE_MAX = 250;

/** 非空 trim 字符串提取（web-tools 同款类型守卫） */
function nonEmptyStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** 字符串数组提取（空白项剔除） */
function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

/** API 错误响应 → 可读信息（GitHub/Gitea message 系 + 非 JSON 原文兜底） */
async function apiErrorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return 'HTTP ' + res.status;
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: unknown; error_description?: unknown };
    const msg = [j.message, j.error, j.error_description].find((k): k is string => typeof k === 'string' && k.length > 0);
    if (msg) return msg;
  } catch { /* 非 JSON 体 → 原文 */ }
  return text.slice(0, 300);
}

interface CreatedIssue { number: number; url: string; title: string }

interface NewIssue { title: string; body?: string; labels: string[] }

async function createIssue(
  server: 'github' | 'gitee',
  repo: string,
  apiBase: string,
  token: string,
  issue: NewIssue,
): Promise<CreatedIssue> {
  const common = issue.body ? { body: issue.body } : {};
  let res: Response;
  if (server === 'gitee') {
    // Gitee v5 形状：owner 进路径、repo 进 body、令牌进 body、labels 逗号串（上限 5）
    const [owner, name] = repo.split('/');
    res = await fetch(apiBase + '/repos/' + owner + '/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: token,
        repo: name,
        title: issue.title,
        ...common,
        ...(issue.labels.length ? { labels: issue.labels.slice(0, 5).join(',') } : {}),
      }),
    });
  } else {
    // GitHub v3 形状（Gitea 等兼容台同形；labels 无硬限，截 10 防滥用）
    res = await fetch(apiBase + '/repos/' + repo + '/issues', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: issue.title,
        ...common,
        ...(issue.labels.length ? { labels: issue.labels.slice(0, 10) } : {}),
      }),
    });
  }
  if (!res.ok) {
    // 常见状态码补指路（两家共有语义）
    let hint = '';
    if (res.status === 401 || res.status === 403) hint = '（令牌无效或无权限：检查凭据库 github/gitee 或环境变量）';
    else if (res.status === 404) hint = '（仓库不存在或令牌无权访问）';
    throw new Error(server + ' API ' + res.status + '：' + (await apiErrorText(res)) + hint);
  }
  const data = (await res.json()) as { html_url?: string; url?: string; number?: number; title?: string };
  const url = data.html_url ?? data.url;
  if (!url || typeof data.number !== 'number') throw new Error(server + ' API 响应缺少 html_url/number 字段');
  return { number: data.number, url, title: data.title ?? issue.title };
}

export const inject = ['tools'];

export function apply(ctx: Context, options: IssueToolsRowOptions = {}) {
  ctx.tools.register({
    name: 'submit_issue',
    requiredTags: ['web'],
    // 权限轴（access-tier §3.3 同款）：对外发布是非 LLM 出口通道——
    // base 档审批放行、sandbox+ 档自由
    needPermission: true,
    description:
      '向 Git 托管台提交 ISSUE（GitHub/Gitee）：把用户反馈或问题以 ISSUE 形式发到仓库，返回链接与编号。目的地（server/repo）缺省走配置（内置缺省 = 本产品主仓库），调用参数可覆盖；令牌走凭据链（github/gitee）或环境变量 GITHUB_TOKEN/GITEE_TOKEN。需要 web 能力标签。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'ISSUE 标题（一句话概括，≤250 字符）' },
        body: { type: 'string', description: 'ISSUE 正文（Markdown：现象、复现步骤、期望结果、环境）' },
        labels: { type: 'array', items: { type: 'string' }, description: '标签（如 bug/feature；与配置的附加标签并集，Gitee 上限 5）' },
        server: { type: 'string', enum: ['github', 'gitee'], description: '托管台覆盖（缺省走配置）' },
        repo: { type: 'string', description: '目标仓库覆盖（owner/repo；缺省走配置）' },
      },
      required: ['title'],
    },
    async execute(args, call) {
      try {
        // per-Agent settings[issue-tools]（enabled 约定键自查）
        let s: IssueToolsSettings = {};
        if (call.agentId !== undefined) {
          const h = ctx.get('agents')?.settingsOf(call.agentId, 'issue-tools');
          if (h && typeof h === 'object') s = h as IssueToolsSettings;
        }
        if (s.enabled === false) {
          return { ok: false, error: 'submit_issue 已被本 Agent 设置停用（settings[issue-tools].enabled）' };
        }

        // 目的地解析链：args → settings → 行配置 → 内置缺省
        const server = nonEmptyStr(args.server) ?? nonEmptyStr(s.server) ?? nonEmptyStr(options.server) ?? DEFAULT_SERVER;
        if (server !== 'github' && server !== 'gitee') {
          return { ok: false, error: '未知托管台 "' + server + '"（可选：github, gitee）' };
        }
        const repo = nonEmptyStr(args.repo) ?? nonEmptyStr(s.repo) ?? nonEmptyStr(options.repo) ?? DEFAULT_REPO;
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          return { ok: false, error: 'repo 须为 owner/repo 形（当前 "' + repo + '"）——经参数、settings[issue-tools].repo 或行配置指定' };
        }
        const apiBase = (nonEmptyStr(s.apiBase) ?? nonEmptyStr(options.apiBase) ??
          (server === 'gitee' ? GITEE_API_BASE : GITHUB_API_BASE)).replace(/\/+$/, '');

        // 令牌三源链：行直配 → ac-credentials（Agent 级→全局）→ env
        let token = nonEmptyStr(options.token) ?? '';
        if (!token && call.agentId !== undefined) {
          token = ctx.get('credentials')?.resolve(call.agentId, server) ?? '';
        }
        if (!token) token = ctx.get('credentials')?.getGlobal(server) ?? '';
        if (!token) token = nonEmptyStr(process.env[ENV_TOKEN[server]]) ?? '';
        if (!token) {
          const platform = server === 'github' ? 'GitHub' : 'Gitee';
          return {
            ok: false,
            error: '未配置 ' + platform + ' 访问令牌——请任选其一：行配置 issue-tools 的 token、凭据库（provider ' + server + '）或环境变量 ' + ENV_TOKEN[server] + '。',
          };
        }

        const title = String(args.title ?? '').trim();
        if (!title) return { ok: false, error: 'title 不能为空（ISSUE 标题，≤250 字符）' };
        if (title.length > TITLE_MAX) return { ok: false, error: '标题过长（' + title.length + ' 字符，上限 ' + TITLE_MAX + '）——请提炼为一句话' };
        const body = nonEmptyStr(args.body);
        const labels = [...new Set([...strArray(s.labels), ...strArray(options.labels), ...strArray(args.labels)])];

        call.onProgress?.('正在向 ' + server + ':' + repo + ' 提交 ISSUE「' + title.slice(0, 60) + '」…\n');
        const created = await createIssue(server, repo, apiBase, token, {
          title,
          ...(body ? { body } : {}),
          labels,
        });
        call.onProgress?.('ISSUE #' + created.number + ' 已创建：' + created.url + '\n');
        return { ok: true, output: { url: created.url, number: created.number, server, repo, title: created.title } };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
