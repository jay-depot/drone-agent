import { describe, expect, it } from 'vitest';
import {
  CANCEL_SENTINEL,
  MENTION_INSTRUCTION,
  NO_RESPONSE_SENTINEL,
  OBSERVER_INSTRUCTION,
  ROOM_INSTRUCTION,
  OUTBOUND_LEDGER_PREAMBLE,
  composeSystemReminder,
  formatChatTurn,
  formatOutboundPost,
  isCancelled,
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

describe('composeSystemReminder', () => {
  it('keeps ROOM_INSTRUCTION for an active room turn', () => {
    expect(composeSystemReminder('active', 'room', false)).toBe(
      ROOM_INSTRUCTION
    );
    expect(composeSystemReminder('active', 'room', true)).toBe(
      ROOM_INSTRUCTION
    );
  });

  it('returns no reminder for an active DM turn', () => {
    expect(composeSystemReminder('active', 'dm', false)).toBeUndefined();
    expect(composeSystemReminder('active', 'dm', true)).toBeUndefined();
  });

  it('uses the observation instruction for every observer turn', () => {
    expect(composeSystemReminder('observer', 'dm', false)).toBe(
      OBSERVER_INSTRUCTION
    );
    expect(composeSystemReminder('observer', 'room', false)).toBe(
      OBSERVER_INSTRUCTION
    );
    expect(composeSystemReminder('observer', 'room', true)).toBe(
      OBSERVER_INSTRUCTION
    );
  });

  it('uses the mention instruction for a passive mention round', () => {
    expect(composeSystemReminder('passive', 'room', true)).toBe(
      MENTION_INSTRUCTION
    );
    expect(composeSystemReminder('passive', 'dm', true)).toBe(
      MENTION_INSTRUCTION
    );
  });

  it('uses the observation instruction for an ordinary passive round', () => {
    expect(composeSystemReminder('passive', 'room', false)).toBe(
      OBSERVER_INSTRUCTION
    );
    expect(composeSystemReminder('passive', 'dm', false)).toBe(
      OBSERVER_INSTRUCTION
    );
  });
});

describe('isCancelled', () => {
  it('is the exact sentinel literal', () => {
    expect(CANCEL_SENTINEL).toBe('__CANCELLED__');
  });

  it('matches the sentinel modulo surrounding whitespace', () => {
    expect(isCancelled('__CANCELLED__')).toBe(true);
    expect(isCancelled('  __CANCELLED__  ')).toBe(true);
  });

  it('does not match other text', () => {
    expect(isCancelled('')).toBe(false);
    expect(isCancelled('a normal reply')).toBe(false);
    expect(isCancelled('__CANCELLED__ but more')).toBe(false);
  });
});
