import type { SwarmEvent, SwarmSession } from './db/swarm-sessions.js';

/**
 * Maximum number of characters to keep from a single tool result in the
 * transcript. Tool results can be very large (file reads, exec output);
 * truncating keeps the transcript a reasonable size for summarization.
 */
const MAX_TOOL_RESULT_CHARS = 400;

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
]);

type ParsedEvent = {
  kind: string;
  correlationId: string | null;
  createdAt: number;
  content?: string;
  name?: string;
  message?: string;
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
        tc => `  tool_call: ${tc.name}(${JSON.stringify(tc.arguments)})`
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
    default:
      return [];
  }
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
  const parsed: ParsedEvent[] = [];
  for (const evt of events) {
    const event = await parseEvent(evt, resolveBlob);
    if (event) parsed.push(event);
  }

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

  return `${header.join('\n')}${body}`;
}
