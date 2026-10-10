/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { coerceOrphanToolMessages } from '../src/shared/tool-message-integrity.js';
import type { DroneChatMessage } from 'drone-core';

describe('coerceOrphanToolMessages', () => {
  it('leaves a valid tool pair unchanged', () => {
    const messages: DroneChatMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: {} }],
      },
      { role: 'tool', content: 'result', toolName: 'read', toolCallId: 'c1' },
    ];
    const out = coerceOrphanToolMessages(messages);
    expect(out).toEqual(messages);
    expect(out[2].role).toBe('tool');
  });

  it('coerces a tool message with no toolCallId to a user message', () => {
    const messages: DroneChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'orphan body', toolName: 'skills__recall' },
    ];
    const out = coerceOrphanToolMessages(messages);
    expect(out[1].role).toBe('user');
    expect(out[1].content).toBe('orphan body');
  });

  it('coerces a tool message whose id matches no preceding assistant call', () => {
    const messages: DroneChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'body', toolName: 'x', toolCallId: 'missing' },
    ];
    const out = coerceOrphanToolMessages(messages);
    expect(out[1].role).toBe('user');
  });

  it('coerces when the matching assistant call appears AFTER the tool message', () => {
    const messages: DroneChatMessage[] = [
      { role: 'tool', content: 'body', toolName: 'x', toolCallId: 'c1' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'x', arguments: {} }],
      },
    ];
    const out = coerceOrphanToolMessages(messages);
    expect(out[0].role).toBe('user');
  });

  it('passes through non-tool lists and the empty list', () => {
    expect(coerceOrphanToolMessages([])).toEqual([]);
    const plain: DroneChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    ];
    expect(coerceOrphanToolMessages(plain)).toEqual(plain);
  });

  it('does not mutate the input array or its messages', () => {
    const orphan: DroneChatMessage = {
      role: 'tool',
      content: 'body',
      toolName: 'x',
    };
    const messages: DroneChatMessage[] = [orphan];
    const out = coerceOrphanToolMessages(messages);
    expect(messages[0].role).toBe('tool');
    expect(out[0]).not.toBe(orphan);
    expect(out[0].role).toBe('user');
  });
});
