import type { DroneSessionImportCapability } from 'drone-core';
import type { ChatEntry } from './tui/types.js';

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/**
 * Run the `--swarm.session-import <sessionId>` startup import before the first
 * turn. Requires the swarm plugin's `DroneSessionImportCapability`; when the
 * capability is absent (swarm disabled) it warns and continues.
 *
 * Returns the terse summary as a single chat-log entry for the TUI to seed on
 * mount, or `undefined` when no import was requested. Non-TUI hosts read the
 * same summary through the logger.
 */
export async function runStartupSessionImport(
  getCapability: <T>(pluginId: string) => T | undefined,
  logger: Logger,
  pluginFlags: Record<string, string | true>
): Promise<ChatEntry[] | undefined> {
  const sessionId = pluginFlags['swarm.session-import'];
  if (typeof sessionId !== 'string') return undefined;

  const message = (text: string): ChatEntry[] => [
    { id: 'startup-session-import', kind: 'notice', text },
  ];

  const capability = getCapability<DroneSessionImportCapability>('swarm');
  if (!capability) {
    const text = `--swarm.session-import: swarm plugin is unavailable; skipping import of ${sessionId}`;
    logger.warn(text);
    return message(text);
  }

  const result = await capability.runImport(sessionId);
  if (!result.summary) return undefined;
  logger.info(result.summary);
  return message(result.summary);
}
