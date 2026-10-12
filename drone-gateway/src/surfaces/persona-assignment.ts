import { logger } from '../logger.js';
import type { AdapterMessage } from '../types.js';
import type { SurfaceFactory } from './types.js';
import { SessionLifecycle } from './lifecycle.js';
import {
  OUTBOUND_LEDGER_PREAMBLE,
  composeSystemReminder,
  formatOutboundPost,
  formatChatTurn,
  isCancelled,
  isNoResponse,
} from '../chat-format.js';

/**
 * A control surface that routes messages in a conversation to a specific
 * persona, governed by a delivery-and-reply `mode`:
 *
 * - `active` — one turn per inbound message; the reply is posted.
 * - `passive` — messages are buffered; a single catch-up turn runs on the
 *   catch-up timer OR immediately on an `@`-mention. Only a mention round
 *   posts its reply.
 * - `observer` — messages are buffered; a catch-up turn runs on the timer and
 *   never posts.
 *
 * Each turn is tagged with the speaker's name. The reply block is enforced in
 * code (not just instructions): a discarding mode returns `response: null`
 * regardless of what the model said. A cancelled turn's sentinel and the
 * no-response sentinel both post nothing, in every mode.
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
  const { mode, catchUpIntervalMs } = ctx;
  const lifecycle = new SessionLifecycle({
    surfaceType: 'persona-assignment',
    conversationId,
    personaId,
    ctx,
  });
  const ledger = ctx.outboundLedger;

  /** Inbound messages accumulated since the last flush (observer/passive). */
  let buffer: AdapterMessage[] = [];
  let timer: NodeJS.Timeout | null = null;

  /**
   * Drain the pending outbound ledger into a preamble. Rows are deleted only
   * after the turn succeeds (see D8/D9).
   */
  function buildPreamble(): { text: string; ids: number[] } {
    if (!ledger) return { text: '', ids: [] };
    const entries = ledger.list(conversationId);
    if (entries.length === 0) return { text: '', ids: [] };
    const text = `${OUTBOUND_LEDGER_PREAMBLE}\n${entries
      .map(formatOutboundPost)
      .join('\n')}\n\n`;
    return { text, ids: entries.map(e => e.id) };
  }

  /**
   * Snapshot-and-clear: callers get a private array and new arrivals start a
   * fresh one, so an arrival mid-flush lands in the next window.
   */
  function takeBuffer(): AdapterMessage[] {
    const drained = buffer;
    buffer = [];
    return drained;
  }

  async function runTurn(
    messages: AdapterMessage[],
    mentioned: boolean
  ): Promise<{ response: string | null; handled: boolean }> {
    const { text: preamble, ids } = buildPreamble();
    const text = preamble + messages.map(formatChatTurn).join('\n');
    const kind = messages[0]?.conversationKind ?? 'dm';
    const reminder = composeSystemReminder(mode, kind, mentioned);

    let reply: string | null;
    try {
      reply = await lifecycle.send(
        text,
        reminder ? { systemReminder: reminder } : undefined
      );
    } catch (err) {
      logger.error(
        { err, conversationId, personaId },
        'Error handling message via persona-assignment surface'
      );
      return {
        response:
          mode === 'active'
            ? `Error: ${err instanceof Error ? err.message : 'Unknown error'}`
            : null,
        handled: true,
      };
    }
    // Only after a successful round: a thrown send leaves the rows for retry.
    if (ledger && ids.length > 0) ledger.remove(ids);

    if (reply === null) {
      logger.info(
        { conversationId, personaId },
        'No synchronous reply from agent (coordinator mode)'
      );
      return { response: null, handled: true };
    }
    if (isCancelled(reply)) {
      logger.info(
        { conversationId, personaId },
        'Agent turn cancelled; posting nothing'
      );
      return { response: null, handled: true };
    }
    if (isNoResponse(reply)) {
      logger.info({ conversationId, personaId }, 'Agent chose not to respond');
      return { response: null, handled: true };
    }
    if (reply.startsWith('Error:')) {
      logger.warn({ conversationId, personaId }, `Agent turn failed: ${reply}`);
      return { response: mode === 'active' ? reply : null, handled: true };
    }

    if (mode !== 'active' && !(mode === 'passive' && mentioned)) {
      return { response: null, handled: true };
    }
    return { response: reply.trim() ? reply : null, handled: true };
  }

  /**
   * Flush the buffered window as one turn. Used by the periodic catch-up timer
   * (observer, and an ordinary passive window) and by a passive mention. An
   * empty buffer is a no-op — no spawn, no turn.
   */
  async function flush(
    mentioned: boolean
  ): Promise<{ response: string | null; handled: boolean }> {
    const drained = takeBuffer();
    if (drained.length === 0) return { response: null, handled: true };
    return runTurn(drained, mentioned);
  }

  /**
   * Buffer inbound messages. In `active` a turn runs immediately; in a
   * discarding mode a mention-bearing ingest (passive) flushes at once, and
   * anything else waits for the timer. The flush is awaited inside the
   * engine's dispatch, so a mention's reply is returned for posting.
   */
  async function ingest(
    messages: AdapterMessage[]
  ): Promise<{ response: string | null; handled: boolean }> {
    if (mode === 'active') return runTurn(messages, false);
    buffer.push(...messages);
    const mentioned = messages.some(m => m.mentionsBot);
    if (mode === 'passive' && mentioned) return flush(true);
    return { response: null, handled: true };
  }

  // The periodic catch-up timer is armed continuously and is independent of
  // activity. It calls `flush` directly: `lifecycle.send` already serializes on
  // the lifecycle tail, so wrapping it in `lifecycle.run` here would nest two
  // tails and deadlock.
  if (mode !== 'active' && catchUpIntervalMs > 0) {
    timer = setInterval(() => {
      void flush(false);
    }, catchUpIntervalMs);
    timer.unref();
  }

  return {
    id: `persona-assignment-${conversationId}`,
    type: 'persona-assignment',
    handleMessage: (msg: AdapterMessage) => ingest([msg]),
    handleBatch: (messages: AdapterMessage[]) => ingest(messages),
    dispose: async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await lifecycle.dispose();
    },
  };
};
