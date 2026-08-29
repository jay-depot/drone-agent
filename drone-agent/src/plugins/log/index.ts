import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomInt } from 'node:crypto';
import type {
  DronePersonaCapability,
  DronePlugin,
  DroneSessionTurn,
  DroneSessionMessage,
} from 'drone-core';
import type { DroneSessionManager } from '../../runtime/session-manager.js';
import { ADJECTIVES, NOUNS } from './words.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogPluginDeps = {
  sessionManager: DroneSessionManager;
};

export type DroneLogCapability = {
  /** Append a turn to the current session log. Creates the log file if it doesn't exist. */
  appendTurn: (turn: DroneSessionTurn) => Promise<void>;
  /** Get the current log file path (for status/debug). */
  getLogFilePath: () => string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a random log filename like `amber-fox-1687456789000.json`.
 */
function generateLogFilename(): string {
  const adj = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  const ts = Date.now();
  return `${adj}-${noun}-${ts}.json`;
}

/**
 * Resolve the log directory for the current persona state.
 * Uses os.homedir() lazily so tests can mock it.
 */
function resolveLogDir(personaCap: DronePersonaCapability | undefined): string {
  const baseDir = path.join(os.homedir(), '.drone-agent', 'logs');
  const activePersona = personaCap?.getActivePersona();

  if (!activePersona) {
    return path.join(baseDir, 'default');
  }

  if (activePersona.scope === 'project') {
    const projectSlug = path.basename(process.cwd());
    return path.join(baseDir, `project-${projectSlug}`, activePersona.id);
  }

  // user scope (or undefined scope — treat as user)
  return path.join(baseDir, activePersona.id);
}

/**
 * Filter out system-role messages from a turn's messages array.
 */
function filterSystemMessages(
  messages: DroneSessionMessage[]
): DroneSessionMessage[] {
  return messages.filter(m => m.role !== 'system');
}

/**
 * Filter system messages from all turns in an array.
 */
function filterTurns(turns: DroneSessionTurn[]): DroneSessionTurn[] {
  return turns.map(turn => ({
    ...turn,
    messages: filterSystemMessages(turn.messages),
  }));
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export function createLogPlugin(deps: LogPluginDeps): DronePlugin {
  return {
    metadata: {
      id: 'log',
      name: 'Session Log',
      version: '0.1.0',
      description:
        'Records session turns (user, assistant, tool) to persona-scoped JSON log files.',
      defaultEnabled: true,
      dependencies: [{ id: 'persona', optional: true }],
    },
    register: async registration => {
      const { sessionManager } = deps;
      const personaCap =
        registration.request<DronePersonaCapability>('persona');

      // ── State ──────────────────────────────────────────────────────
      let logFilePath: string | null = null;
      let filename: string | null = null;

      // ── Internal: write the full session snapshot ──────────────────
      async function writeSessionSnapshot(): Promise<void> {
        const dir = resolveLogDir(personaCap);
        if (!filename) {
          filename = generateLogFilename();
        }
        // Use a local variable for the path so that the async gap
        // between path resolution and writeFile is immune to the
        // persona change handler nulling out the shared logFilePath.
        const filePath = path.join(dir, filename);
        logFilePath = filePath;

        await mkdir(dir, { recursive: true });

        const turns = sessionManager.getTurns();
        const filtered = filterTurns(turns);

        await writeFile(filePath, JSON.stringify(filtered, null, 2), 'utf-8');
      }

      // ── Capability ─────────────────────────────────────────────────
      const capability: DroneLogCapability = {
        appendTurn: async turn => {
          // For external callers: read existing, append, write back.
          // This is kept for backward compatibility but the internal
          // flush mechanism uses writeSessionSnapshot instead.
          const dir = resolveLogDir(personaCap);
          if (!filename) {
            filename = generateLogFilename();
          }
          logFilePath = path.join(dir, filename);

          await mkdir(dir, { recursive: true });

          // Read existing log file (if any)
          let turns: DroneSessionTurn[];
          try {
            const raw = await readFile(logFilePath, 'utf-8');
            turns = JSON.parse(raw) as DroneSessionTurn[];
            if (!Array.isArray(turns)) turns = [];
          } catch {
            // File doesn't exist or is corrupt — start fresh
            turns = [];
          }

          // Filter system messages from the turn
          const filteredTurn: DroneSessionTurn = {
            ...turn,
            messages: filterSystemMessages(turn.messages),
          };

          turns.push(filteredTurn);

          await writeFile(logFilePath, JSON.stringify(turns, null, 2), 'utf-8');
        },
        getLogFilePath: () => logFilePath,
      };

      registration.offer(capability);

      // ── Flush helper ──────────────────────────────────────────────
      async function flushUnloggedTurns(): Promise<void> {
        // Write the complete session snapshot, replacing the file.
        // This ensures all messages in each turn are captured, even
        // though the session manager mutates turns in-place.
        await writeSessionSnapshot();
      }

      // ── Persona change tracking ────────────────────────────────────
      if (personaCap) {
        personaCap.onPersonaChange(() => {
          // When the persona changes, flush remaining turns to the old log,
          // then reset the filename so a new log file is created for the
          // new persona.
          flushUnloggedTurns().catch(err => {
            registration.logger.warn(
              `log: error flushing turns on persona change: ${err}`
            );
          });
          filename = null;
          logFilePath = null;
        });
      }

      // ── Hooks ──────────────────────────────────────────────────────

      registration.hooks.onSessionStart(async () => {
        // Lazy init: filename is generated on first flush
        registration.logger.info('log plugin ready');
      });

      registration.hooks.onAfterToolCall(async () => {
        await flushUnloggedTurns();
      });

      registration.hooks.onSessionClear(async () => {
        await flushUnloggedTurns();
        filename = null;
        logFilePath = null;
      });

      registration.hooks.onShutdown(async () => {
        await flushUnloggedTurns();
        if (logFilePath) {
          registration.logger.info(`session log written to ${logFilePath}`);
        }
      });

      // ── Help snippet ───────────────────────────────────────────────
      registration.registerHelp(
        'Session Log: automatically records conversation turns to ~/.drone-agent/logs/'
      );
    },
  };
}
