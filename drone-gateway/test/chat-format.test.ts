import { describe, expect, it } from 'vitest';
import {
  NO_RESPONSE_SENTINEL,
  ROOM_INSTRUCTION,
  formatChatTurn,
  isNoResponse,
} from '../src/chat-format.js';

describe('formatChatTurn', () => {
  it('prefixes with the sender name', () => {
    expect(
      formatChatTurn({ senderName: 'Alice', senderId: '@alice:x', text: 'hi' })
    ).toBe('[Alice] hi');
  });

  it('falls back to senderId when senderName is absent', () => {
    expect(formatChatTurn({ senderId: '@alice:x', text: 'hi' })).toBe(
      '[@alice:x] hi'
    );
  });

  it('falls back to senderId when senderName is blank', () => {
    expect(
      formatChatTurn({ senderName: '   ', senderId: '@alice:x', text: 'hi' })
    ).toBe('[@alice:x] hi');
  });

  it("falls back to 'unknown' when both are absent", () => {
    expect(formatChatTurn({ text: 'hi' })).toBe('[unknown] hi');
  });

  it('prefixes only the first line of a multi-line message', () => {
    expect(
      formatChatTurn({ senderName: 'Alice', text: 'line one\nline two' })
    ).toBe('[Alice] line one\nline two');
  });
});

describe('isNoResponse', () => {
  it('is the exact sentinel literal', () => {
    expect(NO_RESPONSE_SENTINEL).toBe('<<NO_RESPONSE>>');
  });

  it('matches the sentinel modulo surrounding whitespace', () => {
    expect(isNoResponse('  <<NO_RESPONSE>>  ')).toBe(true);
    expect(isNoResponse('<<NO_RESPONSE>>')).toBe(true);
  });

  it('does not match when there is extra content', () => {
    expect(isNoResponse('<<NO_RESPONSE>> but more')).toBe(false);
  });

  it('does not match other text', () => {
    expect(isNoResponse('sure, here you go')).toBe(false);
    expect(isNoResponse('')).toBe(false);
  });
});

describe('ROOM_INSTRUCTION', () => {
  it('names the sentinel so the model knows the exact token', () => {
    expect(ROOM_INSTRUCTION).toContain(NO_RESPONSE_SENTINEL);
  });
});
