/**
 * Tests for the pure `/btw` aside-message builder.
 */

import { describe, expect, it } from 'vitest';
import type { DroneChatMessage } from 'drone-core';
import { ASIDE_FRAMING, buildAsideMessages } from '../src/runtime/aside.js';

describe('buildAsideMessages', () => {
  it('orders header → session → footer → framed question', () => {
    const header: DroneChatMessage[] = [
      { role: 'system', content: 'header-1' },
    ];
    const sessionMessages: DroneChatMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ];
    const footer: DroneChatMessage[] = [
      { role: 'system', content: 'footer-1' },
    ];

    const result = buildAsideMessages({
      header,
      sessionMessages,
      footer,
      question: 'what is the plan?',
    });

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ role: 'system', content: 'header-1' });
    expect(result[1]).toEqual({ role: 'user', content: 'u1' });
    expect(result[2]).toEqual({ role: 'assistant', content: 'a1' });
    expect(result[3]).toEqual({ role: 'system', content: 'footer-1' });
    expect(result[4].role).toBe('user');
    expect(result[4].content).toContain('what is the plan?');
  });

  it('prefixes the question with the aside framing', () => {
    const result = buildAsideMessages({
      header: [],
      sessionMessages: [],
      footer: [],
      question: 'why?',
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(`${ASIDE_FRAMING}\n\nwhy?`);
  });

  it('framing tells the model no tools are available', () => {
    expect(ASIDE_FRAMING).toMatch(/no tools/i);
  });
});
