// ============================================================
// 会话 Token API —— GET /api/sessions/:agentId/tokens
//
// 读取当前 viewer↔agent 的 messages.jsonl，估算 token 占用，
// 预测距离归档阈值还有多少空间，帮助用户判断是否需要手工归档。
// ============================================================

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { configService } from '@services/config-service';
import { logger } from '@utils/logger';
import { estimateMessagesTokens } from '@utils/tokens';

// ── Token 估算（B3：统一使用共享模块 @utils/tokens，不再本地复刻）──

interface PersistedMessage {
  role: string;
  content: string | null;
  reasoning_content?: string;
  agent_id?: string;
  timestamp?: string;
}

// ── 会话路径 ──

function resolveMessagePath(agentA: string, agentB: string): string {
  const [lo, hi] = [agentA, agentB].sort();
  return path.join(configService.getGlobalConfig().sessionsDir, lo, hi, 'messages.jsonl');
}

// ── 配置读取 ──

const DEFAULT_MAX_CONTEXT_TOKENS = 1_000_000;

/** 读取全局配置中 agent-session 的实际 maxContextTokens（fallback 1M），修正硬编码 */
function resolveMaxContextTokens(): number {
  try {
    const es = (configService.getGlobalConfig() as any)?.['extension.agent_session'];
    if (es && typeof es.maxContextTokens === 'number' && es.maxContextTokens > 0) {
      return es.maxContextTokens;
    }
  } catch { /* 用默认值 */ }
  return DEFAULT_MAX_CONTEXT_TOKENS;
}

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
      const viewerId = configService.getGlobalConfig().viewerId;
      if (!agentId || !viewerId) {
        return res.status(400).json({ error: '缺少 agentId 或 viewerId' });
      }

      const msgPath = resolveMessagePath(viewerId, agentId);
      const maxContextTokens = resolveMaxContextTokens();

      if (!fs.existsSync(msgPath)) {
        return res.json({
          tokenCount: 0,
          messageCount: 0,
          maxContextTokens,
          usagePercent: 0,
          avgTokensPerMsg: 0,
          estimatedMsgsRemaining: Math.floor(maxContextTokens / 100), // rough default
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
