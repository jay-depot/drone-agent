import { logger } from '../logger.js';
import type { AdapterMessage } from '../types.js';
import type { SurfaceFactory } from './types.js';

/**
 * Silently consumes messages, always returning `{ response: null, handled:
 * true }`. Used for explicit "/dev/null" routing (e.g. a wildcard catch-all
 * for unknown conversations), making the intent observable in logs.
 */
export const createDiscardSurface: SurfaceFactory = (
  _spec,
  conversationId
) => ({
  id: `discard-${conversationId}`,
  type: 'discard',
  handleMessage: async (_msg: AdapterMessage) => {
    logger.debug(
      { conversationId },
      'Message discarded via discard control surface'
    );
    return { response: null, handled: true };
  },
});
