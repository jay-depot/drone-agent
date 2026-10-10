/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { appendSyntheticToolExchange } from '../src/shared/synthetic-tool-exchange.js';

describe('appendSyntheticToolExchange', () => {
  it('appends a paired assistant tool-call and matching tool result', () => {
    const calls: Array<{ kind: string; args: unknown[] }> = [];
    const sessionManager = {
      appendAssistantMessage: (...args: unknown[]) =>
        calls.push({ kind: 'assistant', args }),
      appendToolResult: (...args: unknown[]) =>
        calls.push({ kind: 'tool', args }),
    };

    appendSyntheticToolExchange(sessionManager as never, {
      toolName: 'skills__recall',
      toolCallId: 'call-42',
      arguments: { id: 'demo' },
      content: 'skill body',
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].kind).toBe('assistant');
    const [assistantContent, toolCalls] = calls[0].args as [
      string,
      Array<Record<string, unknown>>,
    ];
    expect(assistantContent).toBe('');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe('call-42');
    expect(toolCalls[0].name).toBe('skills__recall');
    expect(toolCalls[0].arguments).toEqual({ id: 'demo' });

    expect(calls[1].kind).toBe('tool');
    const [toolName, result, toolCallId] = calls[1].args as [
      string,
      string,
      string,
    ];
    expect(toolName).toBe('skills__recall');
    expect(result).toBe('skill body');
    expect(toolCallId).toBe('call-42');
  });

  it('defaults arguments to an empty object when omitted', () => {
    const calls: Array<unknown[]> = [];
    const sessionManager = {
      appendAssistantMessage: (...args: unknown[]) => calls.push(args),
      appendToolResult: () => {},
    };

    appendSyntheticToolExchange(sessionManager as never, {
      toolName: 'skills__recall',
      toolCallId: 'call-1',
      content: 'body',
    });

    const [, toolCalls] = calls[0] as [string, Array<Record<string, unknown>>];
    expect(toolCalls[0].arguments).toEqual({});
  });
});
