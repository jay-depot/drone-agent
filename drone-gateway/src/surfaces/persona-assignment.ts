import { logger } from '../logger.js';
import type { AdapterMessage, SpawnSession } from '../types.js';
import type { SurfaceFactory } from './types.js';

export const createPersonaAssignmentSurface: SurfaceFactory = (
  spec,
  conversationId,
  ctx
) => {
  if (!spec.personaId) {
    throw new Error('persona-assignment control surface requires personaId');
  }
  const personaId = spec.personaId;
  let session: SpawnSession | null = null;

  return {
    id: `persona-assignment-${conversationId}`,
    type: 'persona-assignment',
    handleMessage: async (msg: AdapterMessage) => {
      // The engine guarantees this surface is only invoked for its own
      // conversation — no conversationId re-check needed.
      try {
        if (!session) {
          session = await ctx.spawnBackend.spawnSession(
            conversationId,
            personaId,
            { targetBeaconId: ctx.targetBeaconId }
          );
        }

        const response = await ctx.spawnBackend.sendMessage(session, msg.text);

        return { response, handled: true };
      } catch (err) {
        logger.error(
          { err, conversationId, personaId },
          'Error handling message via persona-assignment surface'
        );
        return {
          response: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
          handled: true,
        };
      }
    },
  };
};
