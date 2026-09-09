/**
 * Shared transform for the session chat feed: converts persisted swarm
 * events into trimmed display items for both the REST feed
 * (GET /sessions/:id/chat) and the live WebSocket session-event pushes,
 * so the two surfaces can never drift.
 */
import { logger } from './logger.js';

/** Max characters of display text per feed item; the rest is lazy-fetched. */
export const PREVIEW_CHARS = 1000;

/** Kinds that carry no human-readable content and are excluded from feeds. */
export const NOISE_EVENT_KINDS = new Set([
  'roundComplete',
  'reasoningComplete',
  'assistantMessageComplete',
  'toolProgress',
]);

export interface ChatFeedItem {
  id: string;
  type: string;
  /** Tool name for tool* kinds (from event metadata). */
  name?: string;
  correlationId: string | null;
  createdAt: number;
  /** Bounded display text; empty for blobbed tool results (fetched lazily). */
  preview: string;
  /** True when content was elided (truncation or blob ref). */
  hasFull: boolean;
}

export function isNoiseEvent(type: string): boolean {
  return NOISE_EVENT_KINDS.has(type);
}

function truncate(text: string): { preview: string; hasFull: boolean } {
  if (text.length > PREVIEW_CHARS) {
    return {
      preview: `${text.slice(0, PREVIEW_CHARS)}…[+${text.length - PREVIEW_CHARS} chars]`,
      hasFull: true,
    };
  }
  return { preview: text, hasFull: false };
}

interface ToolCallLike {
  name?: unknown;
  arguments?: unknown;
}

interface ToolResultLike {
  content?: unknown;
}

function argsSummary(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args.length > 0 ? `(${args})` : '';
  try {
    return `(${JSON.stringify(args)})`;
  } catch {
    return '';
  }
}

/**
 * Pick bounded display text from a parsed conversation event payload.
 * Falls back to the raw payload string for unknown shapes.
 */
export function summarizePayload(
  type: string,
  payload: string | null
): { preview: string; hasFull: boolean } {
  if (payload === null) return { preview: '', hasFull: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return truncate(payload);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return truncate(payload);
  }
  const obj = parsed as Record<string, unknown>;

  if (type === 'error' && typeof obj.message === 'string') {
    return truncate(obj.message);
  }
  if (
    (type === 'userMessage' ||
      type === 'assistantMessage' ||
      type === 'reasoning' ||
      type === 'notice' ||
      type === 'compaction') &&
    typeof obj.content === 'string'
  ) {
    return truncate(obj.content);
  }
  if (type === 'toolCallBatch' && Array.isArray(obj.toolCalls)) {
    const calls = obj.toolCalls as ToolCallLike[];
    const text = calls
      .map(call =>
        typeof call?.name === 'string'
          ? `⚙ ${call.name}${argsSummary(call.arguments)}`
          : null
      )
      .filter(line => line !== null)
      .join('\n');
    return text.length > 0 ? truncate(text) : truncate(payload);
  }
  if (type === 'toolResultBatch' && Array.isArray(obj.results)) {
    const results = obj.results as ToolResultLike[];
    const text = results
      .map(result =>
        typeof result?.content === 'string' ? result.content : ''
      )
      .filter(part => part.length > 0)
      .join('\n');
    return text.length > 0 ? truncate(text) : truncate(payload);
  }
  return truncate(payload);
}

/**
 * Convert a persisted swarm event into a trimmed chat feed item, or null
 * when the event kind is display noise.
 *
 * `payloadWasBlobRef` must be true when the stored payload is a `blob:` ref
 * (not resolved). Blobbed tool-result batches skip preview content entirely
 * — the chip only needs the tool name — so the feed stays cheap on disk I/O;
 * the client fetches full content on expand.
 */
export function toChatFeedItem(event: {
  id: string;
  type: string;
  metadata?: string | null;
  correlationId?: string | null;
  createdAt: number;
  payload: string | null;
  payloadWasBlobRef: boolean;
}): ChatFeedItem | null {
  if (isNoiseEvent(event.type)) return null;

  let name: string | undefined;
  if (event.metadata) {
    try {
      const meta = JSON.parse(event.metadata) as { name?: unknown };
      if (typeof meta.name === 'string') name = meta.name;
    } catch {
      logger.warn(`Unparseable event metadata for ${event.id}`);
    }
  }

  if (event.payloadWasBlobRef) {
    if (event.type === 'toolResultBatch') {
      return {
        id: event.id,
        type: event.type,
        name,
        correlationId: event.correlationId ?? null,
        createdAt: event.createdAt,
        preview: '',
        hasFull: true,
      };
    }
    // Blobbed payloads of other kinds keep their ref as the preview text —
    // the content endpoint is the only way to resolve them.
    return {
      id: event.id,
      type: event.type,
      name,
      correlationId: event.correlationId ?? null,
      createdAt: event.createdAt,
      preview: '(large content — expand to load)',
      hasFull: true,
    };
  }

  const { preview, hasFull } = summarizePayload(event.type, event.payload);
  return {
    id: event.id,
    type: event.type,
    name,
    correlationId: event.correlationId ?? null,
    createdAt: event.createdAt,
    preview,
    hasFull,
  };
}
