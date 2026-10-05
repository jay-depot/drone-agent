import { logger } from '../logger.js';
import type { AdapterMessage } from '../types.js';
import type { SurfaceFactory } from './types.js';
import { SessionLifecycle } from './lifecycle.js';

export const createPersonaAssignmentSurface: SurfaceFactory = (
  spec,
  conversationId,
  ctx
) => {
  if (!spec.personaId) {
    throw new Error('persona-assignment control surface requires personaId');
  }
  const personaId = spec.personaId;
  const lifecycle = new SessionLifecycle({
    surfaceType: 'persona-assignment',
    conversationId,
    personaId,
    ctx,
  });

  return {
    id: `persona-assignment-${conversationId}`,
    type: 'persona-assignment',
    handleMessage: async (msg: AdapterMessage) => {
      // The engine guarantees this surface is only invoked for its own
      // conversation — no conversationId re-check needed.
      try {
        return { response: await lifecycle.send(msg.text), handled: true };
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
    dispose: () => lifecycle.dispose(),
  };
};
