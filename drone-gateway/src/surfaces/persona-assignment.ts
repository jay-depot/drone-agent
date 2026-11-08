import { logger } from '../logger.js';
import type { AdapterMessage } from '../types.js';
import type { SurfaceFactory } from './types.js';
import type { ScheduledWakeup } from '../store/gateway-state-store.js';
import { SessionLifecycle } from './lifecycle.js';
import {
  OUTBOUND_LEDGER_PREAMBLE,
  composeSystemReminder,
  formatOutboundPost,
  formatChatTurn,
  isCancelled,
  isNoResponse,
} from '../chat-format.js';
import {
  DEFAULT_WAKEUP_TICK_MS,
  MAX_WAKEUP_ATTEMPTS,
} from '../schedule/constants.js';
import {
  WAKE_INSTRUCTION,
  buildWakePrompt,
  classifyWakeReply,
} from '../schedule/wake-prompt.js';

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
 *
 * When the surface opted into scheduling (`config.schedule.enabled`) and the
 * adapter is persistent, a polled tick fires due wake-ups as their own agent
 * turns. A wake round is a deliverable round: its reply is posted in every
 * mode (D2), while the sentinels still suppress it.
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
  let wakeTimer: NodeJS.Timeout | null = null;
  let disposed = false;

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
   * Fire one due wake-up: run the turn, then post its reply. A delivered turn
   * always removes the row (D6); only a thrown send keeps it for retry. The
   * reply is posted in every mode — a wake round is deliverable (D2).
   */
  async function runWake(w: ScheduledWakeup): Promise<void> {
    const store = ctx.wakeupStore;
    if (!store || disposed) return;
    const { text: preamble, ids } = buildPreamble();
    const prompt = preamble + buildWakePrompt(w.note, w.dueAt);
    let reply: string | null;
    try {
      reply = await lifecycle.send(prompt, {
        systemReminder: WAKE_INSTRUCTION,
      });
    } catch (err) {
      logger.warn(
        { err, conversationId, wakeupId: w.id },
        'wake-up turn failed; will retry'
      );
      const attempts = store.bumpAttempts(w.id);
      if (attempts >= MAX_WAKEUP_ATTEMPTS) {
        store.remove(w.id);
        logger.error(
          { conversationId, wakeupId: w.id },
          'wake-up dropped after max attempts'
        );
      }
      return;
    }
    store.remove(w.id);
    if (ledger && ids.length > 0) ledger.remove(ids);
    const outcome = classifyWakeReply(reply);
    logger.info({ conversationId, wakeupId: w.id, outcome }, 'wake-up fired');
    if (outcome === 'posted')
      await ctx.postMessage(conversationId, reply!.trim());
  }

  /** Fire every due wake-up, oldest first. Serialized by the lifecycle tail. */
  async function fireDue(): Promise<void> {
    const store = ctx.wakeupStore;
    if (!store || disposed) return;
    const due = store.due(conversationId, Date.now());
    for (const w of due) {
      await runWake(w);
    }
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

  if (ctx.scheduleReadiness && ctx.wakeupStore) {
    wakeTimer = setInterval(() => {
      void fireDue();
    }, DEFAULT_WAKEUP_TICK_MS);
    wakeTimer.unref();
  }

  return {
    id: `persona-assignment-${conversationId}`,
    type: 'persona-assignment',
    handleMessage: (msg: AdapterMessage) => ingest([msg]),
    handleBatch: (messages: AdapterMessage[]) => ingest(messages),
    dispose: async () => {
      disposed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (wakeTimer) {
        clearInterval(wakeTimer);
        wakeTimer = null;
      }
      await lifecycle.dispose();
    },
  };
};
