import { randomUUID } from 'node:crypto';
import type { DroneSessionSnapshot, DroneSessionEndedEvent } from 'drone-core';
import type { InvokeResult } from 'drone-swarm-common';
import type { ScheduledWakeupStore } from '../store/gateway-state-store.js';
import type { ResolvedServiceAdapter } from '../types.js';
import { DEFAULT_GATEWAY_EXTENSION_ID } from '../extension-defaults.js';
import { SCHEDULE_CAPABILITIES, scheduleGuidanceFragment } from './catalog.js';
import { SCHEDULE_GUIDANCE_INJECTION_ID } from './constants.js';
import { formatHuman, resolveDueAt, type InvokeCtxLike } from './invoke.js';

/** The node surface the service needs. A no-op delegate is acceptable. */
export interface ScheduleNodeHandle {
  injectFragment(input: { target: string; id: string; content: string }): void;
  injectTools(input: { target: string; capabilities: string[] }): void;
}

export interface ScheduleServiceDeps {
  getNode: () => ScheduleNodeHandle | undefined;
  getWakeupStore: (adapterId: string) => ScheduledWakeupStore | undefined;
  resolveAdapter: (
    conversationId: string
  ) => { adapterId: string; ambiguous: boolean } | undefined;
  logger: {
    info: (o: unknown, m?: string) => void;
    warn: (m: string, o?: unknown) => void;
  };
  /** The gateway's extension id, used to strip the session hint prefix. */
  extensionId?: string;
}

interface SessionRef {
  adapterId: string;
  conversationId: string;
}

/**
 * Tracks which agent sessions belong to which conversation, injects the
 * schedule tools + guidance fragment when a session starts, and answers the
 * three schedule invoke calls. The session map is the bridge between an
 * invoke's `sessionId` and the conversation to read/write.
 */
export class ScheduleService {
  private sessions = new Map<string, SessionRef>();
  private enabled = new Set<string>();

  constructor(private readonly deps: ScheduleServiceDeps) {}

  /** Replace the set of schedule-enabled conversation ids. */
  setEnabledConversations(ids: Set<string>): void {
    this.enabled = ids;
  }

  registerSession(snapshot: DroneSessionSnapshot): void {
    const hint = snapshot.extensionHint;
    if (!hint) return;
    const extId = this.deps.extensionId ?? DEFAULT_GATEWAY_EXTENSION_ID;
    const prefix = `${extId}:`;
    if (!hint.startsWith(prefix)) return;
    const conversationId = hint.slice(prefix.length);
    if (!this.enabled.has(conversationId)) return;
    const resolved = this.deps.resolveAdapter(conversationId);
    if (!resolved || resolved.ambiguous) {
      this.deps.logger.warn(
        `scheduling: cannot resolve adapter for conversation ${conversationId}`
      );
      return;
    }
    const node = this.deps.getNode();
    if (!node) return;
    this.sessions.set(snapshot.sessionId, {
      adapterId: resolved.adapterId,
      conversationId,
    });
    node.injectTools({
      target: snapshot.sessionId,
      capabilities: SCHEDULE_CAPABILITIES.map(c => c.name),
    });
    node.injectFragment({
      target: snapshot.sessionId,
      id: SCHEDULE_GUIDANCE_INJECTION_ID,
      content: scheduleGuidanceFragment(),
    });
  }

  unregisterSession(event: DroneSessionEndedEvent): void {
    this.sessions.delete(event.sessionId);
  }

  /** True once a schedule-enabled session for the conversation is registered. */
  isReady(conversationId: string): boolean {
    for (const ref of this.sessions.values()) {
      if (ref.conversationId === conversationId) return true;
    }
    return false;
  }

  async handleInvokeTool(
    cap: string,
    params: unknown,
    ctx: InvokeCtxLike
  ): Promise<InvokeResult> {
    const ref = this.sessions.get(ctx.sessionId ?? '');
    if (!ref) {
      return { ok: false, status: 400, body: { error: 'unknown session' } };
    }
    const bag =
      params && typeof params === 'object'
        ? (params as Record<string, unknown>)
        : {};

    switch (cap) {
      case 'schedule_wakeup':
        return this.scheduleWakeup(ref, bag);
      case 'schedule_list': {
        const store = this.deps.getWakeupStore(ref.adapterId);
        if (!store) return this.noStore();
        return { ok: true, status: 200, body: store.list(ref.conversationId) };
      }
      case 'schedule_cancel': {
        const store = this.deps.getWakeupStore(ref.adapterId);
        if (!store) return this.noStore();
        const id = bag.id;
        if (typeof id !== 'string' || id.trim() === '') {
          return {
            ok: false,
            status: 400,
            body: { error: 'id is required' },
          };
        }
        const existed = store.get(id) !== null;
        store.remove(id);
        return { ok: true, status: 200, body: { cancelled: existed } };
      }
      default:
        return { ok: false, status: 404, body: { error: 'unknown tool' } };
    }
  }

  private scheduleWakeup(
    ref: SessionRef,
    bag: Record<string, unknown>
  ): InvokeResult {
    const store = this.deps.getWakeupStore(ref.adapterId);
    if (!store) return this.noStore();
    const note = bag.note;
    if (typeof note !== 'string' || note.trim() === '') {
      return { ok: false, status: 400, body: { error: 'note is required' } };
    }
    const resolved = resolveDueAt({ dueAt: bag.dueAt, delayMs: bag.delayMs });
    if (!resolved.ok) {
      return { ok: false, status: 400, body: { error: resolved.error } };
    }
    const id = randomUUID();
    store.insert({
      id,
      conversationId: ref.conversationId,
      note,
      dueAt: resolved.dueAt,
    });
    return {
      ok: true,
      status: 200,
      body: {
        id,
        dueAt: resolved.dueAt,
        inHuman: formatHuman(resolved.dueAt, Date.now()),
      },
    };
  }

  private noStore(): InvokeResult {
    return {
      ok: false,
      status: 503,
      body: { error: 'scheduling disabled (no dataPath)' },
    };
  }
}

/**
 * Find the single adapter that declares `conversationId`. Reports ambiguity
 * when more than one adapter declares it, so the caller can warn and refuse.
 */
export function findConversationAdapter(
  adapters: ResolvedServiceAdapter[],
  conversationId: string
): { adapterId: string; ambiguous: boolean } | undefined {
  const matches = adapters.filter(adapter =>
    adapter.conversations.has(conversationId)
  );
  if (matches.length === 0) return undefined;
  return { adapterId: matches[0].id, ambiguous: matches.length > 1 };
}
