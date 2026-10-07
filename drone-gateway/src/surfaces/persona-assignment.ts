import { logger } from '../logger.js';
import type { AdapterMessage } from '../types.js';
import type { SurfaceFactory } from './types.js';
import { SessionLifecycle } from './lifecycle.js';
import {
  formatChatTurn,
  isNoResponse,
  ROOM_INSTRUCTION,
} from '../chat-format.js';

/**
 * A control surface that routes messages in a conversation to a specific
 * persona. Each inbound turn is tagged with the speaker's name; a multi-user
 * room also gets a per-turn instruction telling the model it may decline to
 * respond. A reply equal to the no-response sentinel (or a `null` reply, e.g.
 * coordinator mode) posts nothing.
 */
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

  async function sendTurn(
    messages: AdapterMessage[]
  ): Promise<{ response: string | null; handled: boolean }> {
    const text = messages.map(formatChatTurn).join('\n');
    const isRoom = messages[0]?.conversationKind === 'room';
    const reply = await lifecycle.send(
      text,
      isRoom ? { systemReminder: ROOM_INSTRUCTION } : undefined
    );
    if (reply === null) {
      logger.info(
        { conversationId, personaId },
        'No synchronous reply from agent (coordinator mode)'
      );
      return { response: null, handled: true };
    }
    if (isNoResponse(reply)) {
      logger.info({ conversationId, personaId }, 'Agent chose not to respond');
      return { response: null, handled: true };
    }
    return { response: reply.trim() ? reply : null, handled: true };
  }

  async function run(
    messages: AdapterMessage[]
  ): Promise<{ response: string | null; handled: boolean }> {
    // The engine guarantees this surface is only invoked for its own
    // conversation — no conversationId re-check needed.
    try {
      return await sendTurn(messages);
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
  }

  return {
    id: `persona-assignment-${conversationId}`,
    type: 'persona-assignment',
    handleMessage: (msg: AdapterMessage) => run([msg]),
    handleBatch: (messages: AdapterMessage[]) => run(messages),
    dispose: () => lifecycle.dispose(),
  };
};
