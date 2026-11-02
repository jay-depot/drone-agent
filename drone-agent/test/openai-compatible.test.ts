import { describe, expect, it } from 'vitest';
import {
  fromOpenAiResponse,
  type OpenAiChatResponse,
} from '../src/shared/openai-compatible.js';

function responseWithToolCalls(
  toolCalls: Array<{ id: string; name: string; arguments: string }>
): OpenAiChatResponse {
  return {
    id: 'chatcmpl_1',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
      },
    ],
  };
}

describe('fromOpenAiResponse — malformed tool-call arguments', () => {
  it('collects the tool name when arguments are unparseable JSON', () => {
    const response = fromOpenAiResponse(
      responseWithToolCalls([
        { id: 'call_1', name: 'memory__manage', arguments: '{"action":"stor' },
      ])
    );
    expect(response.toolCalls).toEqual([
      { id: 'call_1', name: 'memory__manage', arguments: {} },
    ]);
    expect(response.malformedToolCalls).toEqual(['memory__manage']);
  });

  it('does not set malformedToolCalls when all arguments parse', () => {
    const response = fromOpenAiResponse(
      responseWithToolCalls([
        {
          id: 'call_1',
          name: 'file__read',
          arguments: '{"path":"README.md"}',
        },
      ])
    );
    expect(response.malformedToolCalls).toBeUndefined();
    expect(response.toolCalls).toEqual([
      { id: 'call_1', name: 'file__read', arguments: { path: 'README.md' } },
    ]);
  });

  it('treats a parsed null, array, or string as malformed', () => {
    const response = fromOpenAiResponse(
      responseWithToolCalls([
        { id: 'call_1', name: 'tool_a', arguments: 'null' },
        { id: 'call_2', name: 'tool_b', arguments: '[1,2]' },
        { id: 'call_3', name: 'tool_c', arguments: '"str"' },
      ])
    );
    expect(response.malformedToolCalls).toEqual(['tool_a', 'tool_b', 'tool_c']);
    for (const call of response.toolCalls ?? []) {
      expect(call.arguments).toEqual({});
    }
  });

  it('lists only the malformed calls in a mixed response', () => {
    const response = fromOpenAiResponse(
      responseWithToolCalls([
        { id: 'call_1', name: 'tool_good', arguments: '{"a":1}' },
        { id: 'call_2', name: 'tool_bad', arguments: 'not json' },
        { id: 'call_3', name: 'tool_good2', arguments: '{}' },
      ])
    );
    expect(response.malformedToolCalls).toEqual(['tool_bad']);
    expect(response.toolCalls?.[0].arguments).toEqual({ a: 1 });
    expect(response.toolCalls?.[1].arguments).toEqual({});
    expect(response.toolCalls?.[2].arguments).toEqual({});
  });

  it('treats an empty arguments string as a zero-argument call, not corruption', () => {
    const response = fromOpenAiResponse(
      responseWithToolCalls([
        { id: 'call_1', name: 'tool_noargs', arguments: '' },
        { id: 'call_2', name: 'tool_ws', arguments: '   ' },
      ])
    );
    expect(response.malformedToolCalls).toBeUndefined();
    expect(response.toolCalls).toEqual([
      { id: 'call_1', name: 'tool_noargs', arguments: {} },
      { id: 'call_2', name: 'tool_ws', arguments: {} },
    ]);
  });
});
