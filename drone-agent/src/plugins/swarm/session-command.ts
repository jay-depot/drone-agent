import type {
  DroneSessionImportConfig,
  DroneSlashCommand,
  DroneLlmCapability,
  DroneSlashCommandContext,
} from 'drone-core';
import { runSessionImport } from './session-import.js';

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
  const sessionId = ctx.args[1];
  if (!sessionId) {
    ctx.logger.warn('Usage: /swarm-session import <sessionId>');
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

  await runSessionImport(
    {
      baseUrl,
      llm: ctx.engine.getCapability<DroneLlmCapability>('llm'),
      sessionManager: ctx.sessionManager,
      logger: ctx.logger,
      config,
      currentSessionId,
      getContextWindowTokens: () =>
        (getContextWindowTokens ?? defaultGetContextWindowTokens)(ctx),
      runAfterToolCallHooks: () => ctx.engine.runHooks('onAfterToolCall'),
    },
    sessionId,
    { from }
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
    // `list` is read-only and instant -> immediate while the LLM works;
    // `import` mutates the current session context mid-turn, so it queues
    // unless --now is passed.
    busyBehavior: (invocation: { subcommand: string | undefined }) =>
      invocation.subcommand === 'list',
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
