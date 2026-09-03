import { describe, expect, it } from 'vitest';
import { buildSessionTranscript } from '../src/transcript.js';
import type { SwarmEvent, SwarmSession } from '../src/db/swarm-sessions.js';

const session: SwarmSession = {
  id: 'ss1',
  personaId: 'coder',
  beaconId: 'b1',
  createdAt: 1000,
  updatedAt: 2000,
  status: 'ended',
};

function event(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  correlationId: string | null = null,
  createdAt = 0
): SwarmEvent {
  return {
    id,
    sessionId: 'ss1',
    correlationId,
    type: kind,
    payload: JSON.stringify(payload),
    metadata: null,
    createdAt,
  };
}

const resolveBlob = async (ref: string): Promise<string | null> => ref;

describe('buildSessionTranscript', () => {
  it('includes a metadata header', async () => {
    const transcript = await buildSessionTranscript(session, [], resolveBlob);
    expect(transcript).toContain('# Session ss1');
    expect(transcript).toContain('persona: coder');
    expect(transcript).toContain('beacon: b1');
    expect(transcript).toContain('status: ended');
  });

  it('groups events by correlationId into turns', async () => {
    const events = [
      event(
        'e1',
        'userMessage',
        { kind: 'userMessage', content: 'hello' },
        'c1',
        1
      ),
      event(
        'e2',
        'assistantMessage',
        { kind: 'assistantMessage', content: 'hi' },
        'c1',
        2
      ),
      event(
        'e3',
        'userMessage',
        { kind: 'userMessage', content: 'again' },
        'c2',
        3
      ),
    ];
    const transcript = await buildSessionTranscript(
      session,
      events,
      resolveBlob
    );
    expect(transcript).toContain('--- Turn 1 ---');
    expect(transcript).toContain('--- Turn 2 ---');
    // Both c1 events in turn 1
    const turn1 = transcript.split('--- Turn 2 ---')[0];
    expect(turn1).toContain('[user] hello');
    expect(turn1).toContain('[assistant] hi');
    expect(transcript).toContain('[user] again');
  });

  it('filters noise events', async () => {
    const events = [
      event(
        'e1',
        'userMessage',
        { kind: 'userMessage', content: 'hello' },
        'c1',
        1
      ),
      event(
        'e2',
        'compaction',
        { kind: 'compaction', message: 'compacted', status: 'completed' },
        'c1',
        2
      ),
      event('e3', 'notice', { kind: 'notice', content: 'notice' }, 'c1', 3),
      event(
        'e4',
        'reasoning',
        { kind: 'reasoning', content: 'thinking' },
        'c1',
        4
      ),
      event(
        'e5',
        'toolProgress',
        { kind: 'toolProgress', name: 'x', content: 'progress' },
        'c1',
        5
      ),
      event(
        'e6',
        'assistantMessageComplete',
        { kind: 'assistantMessageComplete' },
        'c1',
        6
      ),
      event(
        'e7',
        'toolCall',
        { kind: 'toolCall', name: 'x', arguments: {} },
        'c1',
        7
      ),
      event(
        'e8',
        'toolResult',
        { kind: 'toolResult', name: 'x', content: 'r', arguments: {} },
        'c1',
        8
      ),
    ];
    const transcript = await buildSessionTranscript(
      session,
      events,
      resolveBlob
    );
    expect(transcript).toContain('[user] hello');
    expect(transcript).not.toContain('compacted');
    expect(transcript).not.toContain('notice');
    expect(transcript).not.toContain('thinking');
    expect(transcript).not.toContain('progress');
  });

  it('renders tool call batches and tool result batches', async () => {
    const events = [
      event(
        'e1',
        'toolCallBatch',
        {
          kind: 'toolCallBatch',
          toolCalls: [{ name: 'file__read', arguments: { path: 'a.ts' } }],
        },
        'c1',
        1
      ),
      event(
        'e2',
        'toolResultBatch',
        {
          kind: 'toolResultBatch',
          results: [
            {
              name: 'file__read',
              content: 'file contents',
              arguments: { path: 'a.ts' },
            },
          ],
        },
        'c1',
        2
      ),
    ];
    const transcript = await buildSessionTranscript(
      session,
      events,
      resolveBlob
    );
    expect(transcript).toContain('tool_call: file__read({"path":"a.ts"})');
    expect(transcript).toContain('(tool=file__read) file contents');
  });

  it('truncates long tool results', async () => {
    const longContent = 'x'.repeat(1000);
    const events = [
      event(
        'e1',
        'toolResultBatch',
        {
          kind: 'toolResultBatch',
          results: [{ name: 'exec__run', content: longContent, arguments: {} }],
        },
        'c1',
        1
      ),
    ];
    const transcript = await buildSessionTranscript(
      session,
      events,
      resolveBlob
    );
    expect(transcript).toContain('…[truncated, original 1000 chars]');
    expect(transcript).not.toContain(longContent);
  });

  it('truncates long tool-call arguments', async () => {
    const longArgs = { command: 'x'.repeat(1000) };
    const events = [
      event(
        'e1',
        'toolCallBatch',
        {
          kind: 'toolCallBatch',
          toolCalls: [{ name: 'exec__run', arguments: longArgs }],
        },
        'c1',
        1
      ),
    ];
    const transcript = await buildSessionTranscript(
      session,
      events,
      resolveBlob
    );
    expect(transcript).toContain('…[truncated, original');
    expect(transcript).not.toContain('x'.repeat(1000));
  });

  it('caps the total transcript size so it never truncates mid-JSON', async () => {
    // A session with many turns each carrying a large (but individually
    // under-cap) tool result would otherwise push the transcript past the
    // transport limit. The builder must elide the tail with a note.
    const events = Array.from({ length: 700 }, (_, i) =>
      event(
        `e${i}`,
        'toolResultBatch',
        {
          kind: 'toolResultBatch',
          results: [
            { name: 'exec__run', content: 'y'.repeat(800), arguments: {} },
          ],
        },
        `c${i}`,
        i
      )
    );
    const transcript = await buildSessionTranscript(
      session,
      events,
      resolveBlob
    );
    expect(transcript).toContain('…[transcript truncated, original');
    expect(transcript.length).toBeLessThan(210 * 1024);
  });

  it('resolves blob payloads', async () => {
    const events = [
      {
        id: 'e1',
        sessionId: 'ss1',
        correlationId: 'c1',
        type: 'userMessage',
        payload: 'blob:ss1/e1/abc',
        metadata: null,
        createdAt: 1,
      },
    ];
    const transcript = await buildSessionTranscript(
      session,
      events,
      async ref => {
        if (ref === 'blob:ss1/e1/abc') {
          return JSON.stringify({ kind: 'userMessage', content: 'from blob' });
        }
        return null;
      }
    );
    expect(transcript).toContain('[user] from blob');
  });

  it('resolves every blob payload (not just the first)', async () => {
    const events = [1, 2, 3].map(n => ({
      id: `e${n}`,
      sessionId: 'ss1',
      correlationId: `c${n}`,
      type: 'userMessage',
      payload: `blob:ss1/e${n}/abc`,
      metadata: null,
      createdAt: n,
    }));
    const resolved: string[] = [];
    const transcript = await buildSessionTranscript(
      session,
      events,
      async ref => {
        resolved.push(ref);
        return JSON.stringify({
          kind: 'userMessage',
          content: `from ${ref}`,
        });
      }
    );
    expect(resolved).toHaveLength(3);
    expect(resolved).toContain('blob:ss1/e1/abc');
    expect(resolved).toContain('blob:ss1/e2/abc');
    expect(resolved).toContain('blob:ss1/e3/abc');
    expect(transcript).toContain('[user] from blob:ss1/e1/abc');
    expect(transcript).toContain('[user] from blob:ss1/e3/abc');
  });

  it('skips events with unparseable payloads', async () => {
    const events = [
      {
        id: 'e1',
        sessionId: 'ss1',
        correlationId: 'c1',
        type: 'userMessage',
        payload: 'not-json',
        metadata: null,
        createdAt: 1,
      },
    ];
    const transcript = await buildSessionTranscript(
      session,
      events,
      resolveBlob
    );
    expect(transcript).not.toContain('[user]');
  });
});
