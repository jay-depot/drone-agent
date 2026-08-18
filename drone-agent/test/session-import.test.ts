import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchTranscript,
  injectChunk,
  splitTranscriptIntoChunks,
  summarizeChunk,
  SESSION_IMPORT_TOOL,
  IMPORT_SUMMARY_SYSTEM_PROMPT,
} from '../src/plugins/swarm/session-import.js';
import type { DroneLlmProvider } from 'drone-core';
import { createSessionManager } from '../src/runtime/session-manager.js';

describe('splitTranscriptIntoChunks', () => {
  const transcript = [
    '# Session ss1',
    'persona: coder',
    '',
    '--- Turn 1 ---',
    '[user] hello',
    '--- Turn 2 ---',
    '[user] world',
    '--- Turn 3 ---',
    '[user] again',
    '--- Turn 4 ---',
    '[user] more',
  ].join('\n');

  it('splits into up to maxChunks contiguous chunks', () => {
    const chunks = splitTranscriptIntoChunks(transcript, 2);
    expect(chunks.length).toBe(2);
    // First chunk has the header + first 2 turns
    expect(chunks[0]).toContain('# Session ss1');
    expect(chunks[0]).toContain('--- Turn 1 ---');
    expect(chunks[0]).toContain('--- Turn 2 ---');
    // Second chunk has the remaining turns, no header
    expect(chunks[1]).not.toContain('# Session ss1');
    expect(chunks[1]).toContain('--- Turn 3 ---');
    expect(chunks[1]).toContain('--- Turn 4 ---');
  });

  it('returns fewer chunks when there are fewer turns than maxChunks', () => {
    const chunks = splitTranscriptIntoChunks(transcript, 10);
    expect(chunks.length).toBe(4);
  });

  it('handles a transcript with no turns as a single chunk', () => {
    const chunks = splitTranscriptIntoChunks(
      '# Session ss1\npersona: coder',
      5
    );
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain('# Session ss1');
  });

  it('clamps maxChunks to at least 1', () => {
    const chunks = splitTranscriptIntoChunks(transcript, 0);
    expect(chunks.length).toBe(1);
  });
});

describe('summarizeChunk', () => {
  it('calls the provider with the import summary prompt and no tools', async () => {
    const chat = vi.fn().mockResolvedValue({ message: 'summary text' });
    const provider: DroneLlmProvider = { chat };
    const result = await summarizeChunk(provider, 'model-x', 'chunk body', 500);
    expect(result).toBe('summary text');
    expect(chat).toHaveBeenCalledWith({
      model: 'model-x',
      messages: [
        { role: 'system', content: IMPORT_SUMMARY_SYSTEM_PROMPT },
        {
          role: 'user',
          content: expect.stringContaining('chunk body'),
        },
      ],
      tools: [],
    });
  });
});

describe('injectChunk', () => {
  it('injects a synthetic tool-call/result pair as its own turn', () => {
    const calls: Array<{ kind: string; args: unknown[] }> = [];
    const sessionManager = {
      appendAssistantMessage: (...args: unknown[]) =>
        calls.push({ kind: 'assistant', args }),
      appendToolResult: (...args: unknown[]) =>
        calls.push({ kind: 'tool', args }),
    };

    injectChunk(sessionManager as never, 'summary', 'ss1', 0, 2);

    expect(calls).toHaveLength(2);
    // First: assistant message with a tool call
    expect(calls[0].kind).toBe('assistant');
    const [content, toolCalls] = calls[0].args as [
      string,
      Array<Record<string, unknown>>,
    ];
    expect(content).toBe('');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe(SESSION_IMPORT_TOOL);
    expect(toolCalls[0].arguments).toEqual({
      sessionId: 'ss1',
      chunk: 1,
      totalChunks: 2,
    });
    // Second: tool result with the summary
    expect(calls[1].kind).toBe('tool');
    const [toolName, result, toolCallId] = calls[1].args as [
      string,
      string,
      string,
    ];
    expect(toolName).toBe(SESSION_IMPORT_TOOL);
    expect(result).toBe('summary');
    expect(toolCallId).toBe('session-import-0');
  });

  it('creates a separate turn per chunk via the real session manager', () => {
    const sessionManager = createSessionManager();
    injectChunk(sessionManager, 'summary one', 'ss1', 0, 2);
    injectChunk(sessionManager, 'summary two', 'ss1', 1, 2);

    const turns = sessionManager.getTurns();
    expect(turns).toHaveLength(2);
    // Each turn is a tool-call/result pair (assistant + tool messages).
    expect(turns[0].messages).toHaveLength(2);
    expect(turns[0].messages[0].role).toBe('assistant');
    expect(turns[0].messages[0].toolCalls?.[0].name).toBe(SESSION_IMPORT_TOOL);
    expect(turns[0].messages[1].role).toBe('tool');
    expect(turns[0].messages[1].content).toBe('summary one');
    expect(turns[1].messages[1].content).toBe('summary two');
  });
});

describe('fetchTranscript', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the transcript from the coordinator', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ transcript: '--- Turn 1 ---\n[user] hi' }),
    });
    vi.stubGlobal('fetch', mockFetch);
    const result = await fetchTranscript('http://localhost:3456', 'ss1');
    expect(result).toContain('[user] hi');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3456/api/sessions/ss1/transcript'
    );
  });

  it('throws when coordinatorUrl is not configured', async () => {
    await expect(fetchTranscript(undefined, 'ss1')).rejects.toThrow(
      'coordinatorUrl not configured'
    );
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404 })
    );
    await expect(
      fetchTranscript('http://localhost:3456', 'ss1')
    ).rejects.toThrow('Failed to fetch transcript: 404');
  });

  it('throws when the transcript is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ transcript: '' }) })
    );
    await expect(
      fetchTranscript('http://localhost:3456', 'ss1')
    ).rejects.toThrow('Session has no transcript to import.');
  });
});
