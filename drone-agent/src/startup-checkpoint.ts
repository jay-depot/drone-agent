import type { DroneCheckpointCapability } from 'drone-core';
import type { ChatEntry } from './tui/types.js';

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/**
 * Run the `--checkpoint.restore <name>` startup restore before the first turn.
 * Requires the checkpoint plugin's `DroneCheckpointCapability`; when the
 * capability is absent it warns and continues. Because the target session is
 * empty, the underlying import's recycle step is a no-op (no new swarm
 * session, no onSessionClear/onSessionRecycle).
 *
 * Returns a single notice chat-log entry for the TUI to seed on mount, or
 * `undefined` when no restore was requested or it produced no summary.
 */
export async function runStartupCheckpointRestore(
  getCapability: <T>(pluginId: string) => T | undefined,
  logger: Logger,
  pluginFlags: Record<string, string | true>
): Promise<ChatEntry[] | undefined> {
  const requested = pluginFlags['checkpoint.restore'];
  if (requested === undefined) return undefined;

  const message = (text: string): ChatEntry[] => [
    { id: 'startup-checkpoint-restore', kind: 'notice', text },
  ];

  const capability = getCapability<DroneCheckpointCapability>('checkpoint');
  if (!capability) {
    const text = '--checkpoint.restore: checkpoint plugin is unavailable; skipping restore';
    logger.warn(text);
    return message(text);
  }

  const result = await capability.runStartupRestore();
  if (!result.summary) return undefined;
  logger.info(result.summary);
  return message(result.summary);
}
