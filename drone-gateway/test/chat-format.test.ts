import { describe, expect, it } from 'vitest';
import {
  NO_RESPONSE_SENTINEL,
  ROOM_INSTRUCTION,
  OUTBOUND_LEDGER_PREAMBLE,
  formatChatTurn,
  formatOutboundPost,
  isNoResponse,
} from '../src/chat-format.js';

describe('formatChatTurn', () => {
  it('builds a header line with the platform ref then the body', () => {
    expect(
      formatChatTurn({
        senderName: 'Alice',
        senderId: '@alice:x',
        platformRef: '$evt1',
        text: 'hi',
      })
    ).toBe('[$evt1 from: Alice]\nhi');
  });

  it('falls back to senderId when senderName is absent', () => {
    expect(
      formatChatTurn({ senderId: '@alice:x', platformRef: '$evt1', text: 'hi' })
    ).toBe('[$evt1 from: @alice:x]\nhi');
  });

  it('falls back to senderId when senderName is blank', () => {
    expect(
      formatChatTurn({
        senderName: '   ',
        senderId: '@alice:x',
        platformRef: '$evt1',
        text: 'hi',
      })
    ).toBe('[$evt1 from: @alice:x]\nhi');
  });

  it("falls back to 'unknown' when both name and id are absent", () => {
    expect(formatChatTurn({ platformRef: '$evt1', text: 'hi' })).toBe(
      '[$evt1 from: unknown]\nhi'
    );
  });

  it("falls back to '-' when there is no platform ref", () => {
    expect(formatChatTurn({ senderName: 'Alice', text: 'hi' })).toBe(
      '[- from: Alice]\nhi'
    );
    expect(
      formatChatTurn({ senderName: 'Alice', platformRef: '   ', text: 'hi' })
    ).toBe('[- from: Alice]\nhi');
  });

  it('places a multi-line body verbatim under the header line', () => {
    expect(
      formatChatTurn({
        senderName: 'Alice',
        platformRef: '$evt1',
        text: 'line one\nline two',
      })
    ).toBe('[$evt1 from: Alice]\nline one\nline two');
  });
});

describe('formatOutboundPost', () => {
  it('builds a header line with the platform ref then the body', () => {
    expect(formatOutboundPost({ platformRef: '$post1', text: 'news' })).toBe(
      '[$post1 posted by you]\nnews'
    );
  });

  it("falls back to '-' when there is no platform ref", () => {
    expect(formatOutboundPost({ text: 'news' })).toBe(
      '[- posted by you]\nnews'
    );
  });
});

describe('OUTBOUND_LEDGER_PREAMBLE', () => {
  it('labels the drained outbound history', () => {
    expect(OUTBOUND_LEDGER_PREAMBLE).toContain('while you were not running');
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
