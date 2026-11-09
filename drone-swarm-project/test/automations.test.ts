import { describe, expect, it } from 'vitest';
import {
  matchesTransition,
  renderPrompt,
  selectAutomations,
} from '../src/automations.js';
import type { Automation, Card, Column, Project } from '../src/board-types.js';

function automation(from: string, to: string, enabled = true): Automation {
  return {
    id: 'a_1',
    name: 'rule',
    enabled,
    when: { from, to },
    then: { action: 'launch-session', personaId: 'code', promptTemplate: 'x' },
  };
}

describe('matchesTransition', () => {
  it('matches an exact pair', () => {
    expect(matchesTransition(automation('todo', 'done'), 'todo', 'done')).toBe(
      true
    );
    expect(matchesTransition(automation('todo', 'done'), 'todo', 'other')).toBe(
      false
    );
  });

  it('treats a wildcard `from` as any source', () => {
    expect(matchesTransition(automation('*', 'done'), 'todo', 'done')).toBe(
      true
    );
    expect(matchesTransition(automation('*', 'done'), 'other', 'done')).toBe(
      true
    );
  });

  it('treats a wildcard `to` as any destination', () => {
    expect(matchesTransition(automation('todo', '*'), 'todo', 'done')).toBe(
      true
    );
    expect(matchesTransition(automation('todo', '*'), 'todo', 'other')).toBe(
      true
    );
  });

  it('matches a null `from` only against a wildcard', () => {
    expect(matchesTransition(automation('*', 'todo'), null, 'todo')).toBe(true);
    expect(matchesTransition(automation('todo', 'done'), null, 'done')).toBe(
      false
    );
  });
});

describe('renderPrompt', () => {
  const card: Card = {
    id: 'c_1',
    title: 'Fix the thing',
    description: 'It is broken',
    columnId: 'done',
    position: 0,
    history: [],
  };
  const column: Column = { id: 'done', name: 'Done', order: 2 };
  const project: Project = {
    id: 'p_1',
    name: 'Alpha',
    columns: [column],
    cards: [card],
    automations: [],
  };

  it('replaces every known token', () => {
    const out = renderPrompt(
      '{{card.title}} | {{card.description}} | {{column.name}} | {{project.name}}',
      { card, column, project }
    );
    expect(out).toBe('Fix the thing | It is broken | Done | Alpha');
  });

  it('renders a missing description as empty', () => {
    const noDesc = { ...card, description: undefined };
    expect(
      renderPrompt('x{{card.description}}y', { card: noDesc, column, project })
    ).toBe('xy');
  });

  it('renders an unknown token as empty', () => {
    expect(renderPrompt('a{{card.nope}}b', { card, column, project })).toBe(
      'ab'
    );
  });
});

describe('selectAutomations', () => {
  it('returns only enabled matching automations', () => {
    const project: Project = {
      id: 'p_1',
      name: 'Alpha',
      columns: [],
      cards: [],
      automations: [
        automation('todo', 'done', true),
        { ...automation('todo', 'done', false), id: 'a_2' },
        { ...automation('todo', 'other', true), id: 'a_3' },
      ],
    };
    const matches = selectAutomations(project, 'todo', 'done');
    expect(matches.map(a => a.id)).toEqual(['a_1']);
  });
});
