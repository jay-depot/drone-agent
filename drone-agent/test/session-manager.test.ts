import { describe, expect, it } from 'vitest';
import { createSessionManager } from '../src/runtime/session-manager.js';

describe('createSessionManager', () => {
  it('starts empty', () => {
    const session = createSessionManager();
    expect(session.getMessages()).toEqual([]);
    expect(session.getTurns()).toEqual([]);
  });

  it('appends user messages as their own turn', () => {
    const session = createSessionManager();
    session.appendUserMessage('hello');
    session.appendUserMessage('world');

    const turns = session.getTurns();
    expect(turns).toHaveLength(2);
    expect(turns[0].messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(turns[1].messages).toEqual([{ role: 'user', content: 'world' }]);
  });

  it('groups assistant + tool results into the latest user turn', () => {
    const session = createSessionManager();
    session.appendUserMessage('do the thing');
    session.appendAssistantMessage('working...', [
      { id: 'c1', name: 'noop', arguments: {} },
    ]);
    session.appendToolResult('noop', 'done', 'c1');
    session.appendAssistantMessage('all set');

    const turns = session.getTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0].messages.map(m => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(turns[0].messages[2]).toMatchObject({
      role: 'tool',
      content: 'done',
      toolName: 'noop',
      toolCallId: 'c1',
    });
  });

  it('starts a new turn when no current turn exists', () => {
    const session = createSessionManager();
    // Force the internal empty state; appendAssistantMessage without a user
    // message should still create a turn.
    session.appendAssistantMessage('orphan?');
    expect(session.getTurns()).toHaveLength(1);
    expect(session.getMessages()[0]).toEqual({
      role: 'assistant',
      content: 'orphan?',
      toolCalls: undefined,
    });
  });

  it('exposes flattened messages across turns', () => {
    const session = createSessionManager();
    session.appendUserMessage('a');
    session.appendAssistantMessage('A');
    session.appendUserMessage('b');
    session.appendAssistantMessage('B');
    expect(session.getMessages().map(m => m.content)).toEqual([
      'a',
      'A',
      'b',
      'B',
    ]);
  });

  it('returns deep copies of turns so callers cannot mutate state', () => {
    const session = createSessionManager();
    session.appendUserMessage('first');
    const turns = session.getTurns();
    turns[0].messages.push({ role: 'user', content: 'INJECTED' });

    expect(session.getTurns()[0].messages).toHaveLength(1);
  });

  it('drops the oldest turns from the head', () => {
    const session = createSessionManager();
    session.appendUserMessage('a');
    session.appendUserMessage('b');
    session.appendUserMessage('c');

    const dropped = session.dropOldestTurns(2);
    expect(dropped).toHaveLength(2);
    expect(dropped.map(t => t.messages[0].content)).toEqual(['a', 'b']);
    expect(session.getMessages().map(m => m.content)).toEqual(['c']);
  });

  it('returns no turns when asked to drop <= 0', () => {
    const session = createSessionManager();
    session.appendUserMessage('a');
    expect(session.dropOldestTurns(0)).toEqual([]);
    expect(session.dropOldestTurns(-3)).toEqual([]);
    expect(session.getMessages()).toHaveLength(1);
  });

  it('drops oldest non-summary turns while head is not a summary', () => {
    const session = createSessionManager();
    // Order: [a, b, c]
    session.appendUserMessage('a');
    session.appendUserMessage('b');
    session.appendUserMessage('c');

    const dropped = session.dropOldestNonSummaryTurns(2);
    expect(dropped.map(t => t.messages[0].content)).toEqual(['a', 'b']);
    expect(session.getTurns().map(t => t.messages[0].content)).toEqual(['c']);
  });

  it('drops nothing when a summary is the head turn', () => {
    const session = createSessionManager();
    session.appendUserMessage('a');
    session.prependSystemTurn('S', { kind: 'summary' });
    // Order is now [S, a] — summary is the head.

    const dropped = session.dropOldestNonSummaryTurns(5);
    expect(dropped).toEqual([]);
    expect(session.getTurns().map(t => t.messages[0].content)).toEqual([
      'S',
      'a',
    ]);
  });

  it('exposes summary turns separately', () => {
    const session = createSessionManager();
    session.prependSystemTurn('first summary', { kind: 'summary' });
    session.prependSystemTurn('second summary', { kind: 'summary' });
    session.appendUserMessage('hello');

    expect(session.getSummaryTurns()).toHaveLength(2);
    expect(session.getTurns()).toHaveLength(3);
  });

  it('drops a summary turn by id and returns it', () => {
    const session = createSessionManager();
    const summary = session.prependSystemTurn('summary', { kind: 'summary' });
    session.appendUserMessage('user');

    const dropped = session.dropSummaryTurnById(summary.id);
    expect(dropped?.id).toBe(summary.id);
    expect(session.getSummaryTurns()).toHaveLength(0);
    expect(session.getTurns()).toHaveLength(1);
  });

  it('returns null when asked to drop a missing summary turn', () => {
    const session = createSessionManager();
    expect(session.dropSummaryTurnById('nope')).toBeNull();
  });

  it('refuses to drop a non-summary turn via dropSummaryTurnById', () => {
    const session = createSessionManager();
    session.appendUserMessage('user');
    const turns = session.getTurns();
    const dropped = session.dropSummaryTurnById(turns[0].id);
    expect(dropped).toBeNull();
    expect(session.getTurns()).toHaveLength(1);
  });

  it('prepends system turns as the new head', () => {
    const session = createSessionManager();
    session.appendUserMessage('user');
    const turn = session.prependSystemTurn('system prompt', {
      kind: 'summary',
    });
    expect(turn.kind).toBe('summary');
    const turns = session.getTurns();
    expect(turns[0].id).toBe(turn.id);
    expect(turns[0].messages[0].content).toBe('system prompt');
  });

  it('clears the session entirely', () => {
    const session = createSessionManager();
    session.appendUserMessage('a');
    session.appendAssistantMessage('A');
    session.prependSystemTurn('sys');
    session.clearSession();
    expect(session.getState()).toEqual({ messages: [], turns: [] });
  });

  it('getState matches getMessages and getTurns', () => {
    const session = createSessionManager();
    session.appendUserMessage('u');
    session.appendAssistantMessage('a');
    const state = session.getState();
    expect(state.messages).toEqual(session.getMessages());
    expect(state.turns).toEqual(session.getTurns());
  });
});
