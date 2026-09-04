import type { SwarmEvent, SwarmSession } from './db/swarm-sessions.js';

/**
 * Maximum number of characters to keep from a single tool result in the
 * transcript. Tool results can be very large (file reads, exec output);
 * truncating keeps the transcript a reasonable size for summarization.
 */
const MAX_TOOL_RESULT_CHARS = 400;

/**
 * Maximum number of characters to keep from a single tool-call's serialized
 * arguments in the transcript. Tool-call arguments are NOT truncated by
 * `truncateToolResult` (that only covers results), and a complex tool call can
 * carry a huge argument payload (a giant exec command, file content in args).
 * Without this cap, many such calls push the transcript past the transport
 * limit (~256KB) and it truncates mid-JSON, breaking the ingest hook.
 */
const MAX_TOOL_CALL_ARGS_CHARS = 400;

/**
 * Hard cap on the total transcript size. Even with per-result and per-args
 * truncation, a session with many turns can still exceed the transport limit;
 * the response must never truncate mid-JSON. When the cap is hit, the tail is
 * elided with a note so the summarizer knows content was dropped.
 */
const MAX_TRANSCRIPT_CHARS = 200 * 1024; // 200KB — safely under the ~256KB limit

/**
 * Event kinds that carry conversation content worth keeping in the
 * transcript. Everything else (compaction notices, reasoning, progress,
 * completion markers, non-batch tool events) is noise for summarization.
 */
const KEPT_EVENT_KINDS = new Set([
  'userMessage',
  'assistantMessage',
  'toolCallBatch',
  'toolResultBatch',
  'error',
  // Session-parameter / lifecycle events emitted by plugins via
  // registration.emitEvent (personaChanged, focusChanged, macroExecuted,
  // sessionStarted). These carry no correlationId, so each renders as its own
  // standalone turn line for the ingest agent.
  'personaChanged',
  'focusChanged',
  'macroExecuted',
  'sessionStarted',
]);

type ParsedEvent = {
  kind: string;
  correlationId: string | null;
  createdAt: number;
  content?: string;
  name?: string;
  message?: string;
  from?: string | null;
  to?: string | null;
  focus?: string | null;
  command?: string;
  subagentId?: string | null;
  personaId?: string | null;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  results?: Array<{
    name: string;
    content: string;
    arguments: Record<string, unknown>;
  }>;
};

/**
 * Parse a SwarmEvent's payload (a JSON-serialized DroneConversationEvent)
 * into a normalized shape, resolving blob references to their content.
 */
async function parseEvent(
  evt: SwarmEvent,
  resolveBlob: (ref: string) => Promise<string | null>
): Promise<ParsedEvent | null> {
  let payload = evt.payload;
  if (!payload) return null;
  if (payload.startsWith('blob:')) {
    payload = await resolveBlob(payload);
    if (!payload) return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }

  const kind = typeof parsed.kind === 'string' ? parsed.kind : '';
  if (!KEPT_EVENT_KINDS.has(kind)) return null;

  const result: ParsedEvent = {
    kind,
    correlationId: evt.correlationId,
    createdAt: evt.createdAt,
  };

  if (typeof parsed.content === 'string') result.content = parsed.content;
  if (typeof parsed.name === 'string') result.name = parsed.name;
  if (typeof parsed.message === 'string') result.message = parsed.message;
  if ('from' in parsed) result.from = parsed.from as string | null;
  if ('to' in parsed) result.to = parsed.to as string | null;
  if ('focus' in parsed) result.focus = parsed.focus as string | null;
  if (typeof parsed.command === 'string') result.command = parsed.command;
  if ('subagentId' in parsed) {
    result.subagentId = parsed.subagentId as string | null;
  }
  if ('personaId' in parsed) {
    result.personaId = parsed.personaId as string | null;
  }
  if (Array.isArray(parsed.toolCalls)) {
    result.toolCalls = parsed.toolCalls as ParsedEvent['toolCalls'];
  }
  if (Array.isArray(parsed.results)) {
    result.results = parsed.results as ParsedEvent['results'];
  }

  return result;
}

/**
 * Truncate a tool result to a bounded length, appending a note about the
 * original size so the summarizer knows content was elided.
 */
function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  const truncated = content.slice(0, MAX_TOOL_RESULT_CHARS);
  return `${truncated}\n…[truncated, original ${content.length} chars]`;
}

/**
 * Render a single parsed event as one or more transcript lines, mirroring
 * compaction's `formatTurnsForSummary` shape.
 */
function renderEvent(event: ParsedEvent): string[] {
  switch (event.kind) {
    case 'userMessage':
      return [`[user] ${event.content ?? ''}`];
    case 'assistantMessage':
      return [`[assistant] ${event.content ?? ''}`];
    case 'toolCallBatch': {
      const calls = event.toolCalls ?? [];
      if (calls.length === 0) return [];
      return calls.map(
        tc => `  tool_call: ${tc.name}(${truncateToolCallArgs(tc.arguments)})`
      );
    }
    case 'toolResultBatch': {
      const results = event.results ?? [];
      if (results.length === 0) return [];
      return results.map(
        r => `(tool=${r.name}) ${truncateToolResult(r.content)}`
      );
    }
    case 'error':
      return [`[error] ${event.message ?? ''}`];
    case 'personaChanged':
      return [
        `persona changed: ${event.from ?? 'none'} -> ${event.to ?? 'none'}`,
      ];
    case 'focusChanged':
      return [`focus ${event.focus ? `set: ${event.focus}` : 'cleared'}`];
    case 'macroExecuted':
      return [`macro executed: ${event.command ?? ''}`];
    case 'sessionStarted':
      return [
        `session started as subagent: ${
          event.subagentId ?? event.personaId ?? ''
        }`,
      ];
    default:
      return [];
  }
}

/**
 * Truncate a tool-call's serialized arguments to a bounded length, appending a
 * note about the original size so the summarizer knows content was elided.
 */
function truncateToolCallArgs(args: Record<string, unknown>): string {
  const serialized = JSON.stringify(args);
  if (serialized.length <= MAX_TOOL_CALL_ARGS_CHARS) return serialized;
  const truncated = serialized.slice(0, MAX_TOOL_CALL_ARGS_CHARS);
  return `${truncated}…[truncated, original ${serialized.length} chars]`;
}

/**
 * Build a lightweight conversation transcript from a session's events.
 *
 * Events are grouped into turns by `correlationId` (one user-prompt round
 * per turn), falling back to a new turn per event when correlationId is
 * absent. Noise events (compaction, notice, reasoning, progress, completion
 * markers, non-batch tool events) are filtered out. Tool results are
 * truncated to keep the transcript a reasonable size.
 *
 * The output mirrors compaction's `formatTurnsForSummary` shape so it can be
 * fed directly to a summarizer, and is shared by the session-import feature
 * and the swarm memory pipeline.
 */
export async function buildSessionTranscript(
  session: SwarmSession,
  events: SwarmEvent[],
  resolveBlob: (ref: string) => Promise<string | null>
): Promise<string> {
  // Resolve blob payloads in parallel; Promise.all preserves input order so
  // the turn grouping below stays chronological.
  const parsed = (
    await Promise.all(events.map(evt => parseEvent(evt, resolveBlob)))
  ).filter((event): event is ParsedEvent => event !== null);

  // Group by correlationId, preserving chronological order. Events without
  // a correlationId each become their own turn.
  const turns: ParsedEvent[][] = [];
  const byCorrelation = new Map<string, ParsedEvent[]>();
  for (const event of parsed) {
    if (event.correlationId) {
      let group = byCorrelation.get(event.correlationId);
      if (!group) {
        group = [];
        byCorrelation.set(event.correlationId, group);
        turns.push(group);
      }
      group.push(event);
    } else {
      turns.push([event]);
    }
  }

  const header = [
    `# Session ${session.id}`,
    `persona: ${session.personaId ?? 'none'}`,
    `beacon: ${session.beaconId}`,
    `status: ${session.status}`,
    `created: ${new Date(session.createdAt).toISOString()}`,
    `updated: ${new Date(session.updatedAt).toISOString()}`,
    '',
  ];

  const body = turns
    .map((turn, index) => {
      const lines = turn.flatMap(renderEvent);
      return `--- Turn ${index + 1} ---\n${lines.join('\n')}`;
    })
    .join('\n');

  const full = `${header.join('\n')}${body}`;
  if (full.length <= MAX_TRANSCRIPT_CHARS) return full;
  const truncated = full.slice(0, MAX_TRANSCRIPT_CHARS);
  return `${truncated}\n…[transcript truncated, original ${full.length} chars]`;
}
