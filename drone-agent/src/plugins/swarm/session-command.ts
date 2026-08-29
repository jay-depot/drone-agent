import type {
  DroneSessionImportConfig,
  DroneSlashCommand,
  DroneLlmCapability,
  DroneSlashCommandContext,
} from 'drone-core';
import {
  fetchTranscript,
  injectChunk,
  splitTranscriptIntoChunks,
  summarizeChunk,
} from './session-import.js';

/** Defaults applied when `swarm.sessionImport` config is absent. */
const DEFAULT_MAX_CHUNKS = 5;
const DEFAULT_CHUNK_TOKEN_BUDGET_PERCENT = 12;

function normalizeConfig(config: DroneSessionImportConfig): {
  maxChunks: number;
  chunkTokenBudgetPercent: number;
} {
  return {
    maxChunks: config.maxChunks ?? DEFAULT_MAX_CHUNKS,
    chunkTokenBudgetPercent:
      config.chunkTokenBudgetPercent ?? DEFAULT_CHUNK_TOKEN_BUDGET_PERCENT,
  };
}

/**
 * Config-only fallback when no host resolver was injected. Mirrors the
 * budget service's own fallback semantics: assume the configured session
 * context window.
 */
async function defaultGetContextWindowTokens(
  ctx: DroneSlashCommandContext
): Promise<number> {
  return ctx.engine.getConfig?.()?.session.contextWindowTokens ?? 32768;
}

/**
 * Handle `/swarm-session list [--limit N] [--status S]`.
 * Lists recent swarm sessions from the coordinator, excluding the current
 * session, and prints a compact table.
 */
async function handleList(
  ctx: DroneSlashCommandContext,
  baseUrl: string | undefined,
  currentSessionId: string
): Promise<boolean> {
  const args = ctx.args.slice(1);
  let limit = 10;
  let status: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--limit') {
      const value = Number(args[i + 1]);
      if (Number.isFinite(value) && value > 0) limit = Math.floor(value);
      i++;
    } else if (arg === '--status') {
      status = args[i + 1];
      i++;
    }
  }

  if (!baseUrl) {
    ctx.logger.warn('Beacon URL not configured.');
    return true;
  }

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (status) params.set('status', status);

  try {
    const res = await fetch(`${baseUrl}/sessions?${params.toString()}`);
    if (!res.ok) {
      ctx.logger.warn(`Failed to list sessions: ${res.status}`);
      return true;
    }
    const data = (await res.json()) as {
      sessions: Array<{
        id: string;
        personaId: string | null;
        status: string;
        createdAt: number;
        updatedAt: number;
      }>;
    };
    const sessions = data.sessions.filter(s => s.id !== currentSessionId);
    if (sessions.length === 0) {
      ctx.logger.info('No sessions found.');
      return true;
    }
    const lines = sessions.map(s => {
      const created = new Date(s.createdAt).toISOString();
      const updated = new Date(s.updatedAt).toISOString();
      return `${s.id.padEnd(24)} ${(s.personaId ?? 'none').padEnd(16)} ${s.status.padEnd(10)} ${created} ${updated}`;
    });
    ctx.logger.info(`Sessions (excluding current):\n${lines.join('\n')}`);
  } catch (err) {
    ctx.logger.warn(`Failed to reach coordinator: ${err}`);
  }
  return true;
}

/**
 * Handle `/swarm-session import <sessionId>`.
 * Fetches the session transcript, splits it into chunks, summarizes each
 * with the clean LLM, and injects each chunk as a synthetic tool-call/result
 * pair (its own turn). Runs `onAfterToolCall` between chunks so compaction
 * can fire and free space, minimizing safety-trim risk.
 */
async function handleImport(
  ctx: DroneSlashCommandContext,
  baseUrl: string | undefined,
  currentSessionId: string,
  config: DroneSessionImportConfig,
  getContextWindowTokens?: () => Promise<number>
): Promise<boolean> {
  const { maxChunks, chunkTokenBudgetPercent } = normalizeConfig(config);
  const sessionId = ctx.args[1];
  if (!sessionId) {
    ctx.logger.warn('Usage: /swarm-session import <sessionId>');
    return true;
  }
  if (sessionId === currentSessionId) {
    ctx.logger.warn('Cannot import the current session into itself.');
    return true;
  }

  // Parse `--from N` (1-indexed resume point) from the trailing args.
  let from = 1;
  for (let i = 2; i < ctx.args.length; i++) {
    if (ctx.args[i] === '--from') {
      const value = Number(ctx.args[i + 1]);
      if (Number.isFinite(value) && value > 0) from = Math.floor(value);
      i++;
    }
  }

  const llm = ctx.engine.getCapability<DroneLlmCapability>('llm');
  if (!llm) {
    ctx.logger.warn('LLM provider broker is not available.');
    return true;
  }
  if (!ctx.sessionManager) {
    ctx.logger.warn('Session manager is not available in this host.');
    return true;
  }

  let transcript: string;
  try {
    transcript = await fetchTranscript(baseUrl, sessionId);
  } catch (err) {
    ctx.logger.warn(`Failed to fetch transcript: ${err}`);
    return true;
  }

  const chunks = splitTranscriptIntoChunks(transcript, maxChunks);
  const contextWindowTokens = await (
    getContextWindowTokens ?? defaultGetContextWindowTokens
  )(ctx);
  const tokenBudget = Math.max(
    1,
    Math.floor(contextWindowTokens * (chunkTokenBudgetPercent / 100))
  );

  const provider = llm.getActiveProvider();
  const model = llm.getModel();

  if (from > chunks.length) {
    ctx.logger.warn(
      `--from ${from} is out of range: session ${sessionId} was split into ${chunks.length} chunk(s).`
    );
    return true;
  }

  ctx.logger.info(
    `Importing session ${sessionId} in ${chunks.length} chunk(s) (${tokenBudget} tokens each), resuming from chunk ${from}...`
  );

  for (let i = from - 1; i < chunks.length; i++) {
    let summary: string;
    try {
      summary = await summarizeChunk(provider, model, chunks[i], tokenBudget);
    } catch (err) {
      ctx.logger.warn(
        `Failed to summarize chunk ${i + 1}: ${err}\n` +
          `Import aborted: imported chunks ${from}..${i} of ${chunks.length}. ` +
          `Chunks ${i + 1}..${chunks.length} were NOT imported.\n` +
          `Resume with: /swarm-session import ${sessionId} --from ${i + 1}`
      );
      return true;
    }
    injectChunk(ctx.sessionManager, summary, sessionId, i, chunks.length);
    ctx.logger.info(`Imported chunk ${i + 1}/${chunks.length}.`);

    // Give compaction a chance to fire between chunks so the imported
    // context stays under the safety-trim budget.
    if (i < chunks.length - 1) {
      try {
        await ctx.engine.runHooks('onAfterToolCall');
      } catch (err) {
        ctx.logger.warn(`onAfterToolCall hook error (non-fatal): ${err}`);
      }
    }
  }

  ctx.logger.info(
    `Imported chunks ${from}..${chunks.length} from session ${sessionId}.`
  );
  return true;
}

/**
 * Create the `/swarm-session` slash command.
 */
export function createSwarmSessionCommand(
  baseUrl: string | undefined,
  currentSessionId: string,
  config: DroneSessionImportConfig,
  getContextWindowTokens?: () => Promise<number>
): DroneSlashCommand {
  return {
    command: '/swarm-session',
    description:
      'Manage swarm sessions: list recent sessions, or import an old session into the current context.',
    handler: async ctx => {
      const subcommand = ctx.args[0] ?? '';
      if (subcommand === 'list') {
        return handleList(ctx, baseUrl, currentSessionId);
      }
      if (subcommand === 'import') {
        return handleImport(
          ctx,
          baseUrl,
          currentSessionId,
          config,
          getContextWindowTokens
        );
      }
      ctx.logger.warn(
        'Unknown swarm-session command. Try: /swarm-session list, /swarm-session import <sessionId>'
      );
      return true;
    },
  };
}
