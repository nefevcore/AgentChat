// ============================================================
// 会话 Token API —— GET /api/sessions/:agentId/tokens
//
// 读取当前 viewer↔agent 的 messages.jsonl，估算 token 占用，
// 预测距离归档阈值还有多少空间，帮助用户判断是否需要手工归档。
// ============================================================

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalConfig } from '@core/config';
import { logger } from '@utils/logger';

// ── Token 估算（与 agent-session 的 estimateTokens 同算法）──

function estimateTokens(text: string | null): number {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    tokens += /[\u4e00-\u9fff]/.test(ch) ? 0.6 : 0.3;
  }
  return Math.ceil(tokens);
}

interface PersistedMessage {
  role: string;
  content: string | null;
  reasoning_content?: string;
  agent_id?: string;
  timestamp?: string;
}

function estimateMessagesTokens(msgs: PersistedMessage[]): number {
  return msgs.reduce((sum, m) => {
    let t = estimateTokens(m.content);
    if (m.reasoning_content) t += estimateTokens(m.reasoning_content);
    return sum + t;
  }, 0);
}

// ── 会话路径 ──

function resolveMessagePath(agentA: string, agentB: string): string {
  const [lo, hi] = [agentA, agentB].sort();
  return path.join(getGlobalConfig().sessionsDir, lo, hi, 'messages.jsonl');
}

// ── 配置读取 ──

const DEFAULT_MAX_CONTEXT_TOKENS = 1_000_000;

interface SessionTokenPrediction {
  tokenCount: number;
  messageCount: number;
  maxContextTokens: number;
  usagePercent: number;
  avgTokensPerMsg: number;
  estimatedMsgsRemaining: number;
  status: 'low' | 'moderate' | 'high' | 'critical';
}

function computeStatus(pct: number): SessionTokenPrediction['status'] {
  if (pct < 50) return 'low';
  if (pct < 75) return 'moderate';
  if (pct < 90) return 'high';
  return 'critical';
}

export function createSessionRouter(): Router {
  const router = Router();

  router.get('/:agentId/tokens', (req: Request, res: Response) => {
    try {
      const agentId = req.params.agentId as string;
      const viewerId = getGlobalConfig().viewerId;
      if (!agentId || !viewerId) {
        return res.status(400).json({ error: '缺少 agentId 或 viewerId' });
      }

      const msgPath = resolveMessagePath(viewerId, agentId);

      if (!fs.existsSync(msgPath)) {
        return res.json({
          tokenCount: 0,
          messageCount: 0,
          maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
          usagePercent: 0,
          avgTokensPerMsg: 0,
          estimatedMsgsRemaining: Math.floor(DEFAULT_MAX_CONTEXT_TOKENS / 100), // rough default
          status: 'low',
        } satisfies SessionTokenPrediction);
      }

      // 读取消息
      const content = fs.readFileSync(msgPath, 'utf-8');
      const messages: PersistedMessage[] = content
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line: string) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((m): m is PersistedMessage => m !== null);

      const messageCount = messages.length;
      const tokenCount = estimateMessagesTokens(messages);
      const maxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS;
      const usagePercent = Math.min(100, Math.round((tokenCount / maxContextTokens) * 10000) / 100);
      const avgTokensPerMsg = messageCount > 0 ? Math.round(tokenCount / messageCount) : 0;
      const estimatedMsgsRemaining = avgTokensPerMsg > 0
        ? Math.floor((maxContextTokens - tokenCount) / avgTokensPerMsg)
        : Math.floor(maxContextTokens / 100);
      const status = computeStatus(usagePercent);

      res.json({
        tokenCount,
        messageCount,
        maxContextTokens,
        usagePercent,
        avgTokensPerMsg,
        estimatedMsgsRemaining,
        status,
      } satisfies SessionTokenPrediction);

      logger.info(`[sessions] ${viewerId}↔${agentId}: ${tokenCount} tokens / ${messageCount} msgs (${usagePercent}%)`);
    } catch (err: any) {
      logger.error(`[sessions] 查询失败: ${err.message}`);
      res.status(500).json({ error: err.message || '查询会话 Token 失败' });
    }
  });

  return router;
}
