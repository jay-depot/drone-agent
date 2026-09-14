import { describe, expect, it } from 'vitest';
import {
  ALLOWLIST_PATTERNS,
  computeKeySuggestions,
} from './config-completions';

describe('computeKeySuggestions', () => {
  it('with no existing keys and no patterns suggests nothing', () => {
    expect(computeKeySuggestions('providers', [], [])).toEqual([]);
  });

  it('suggests the wildcard-family stem for a prefix', () => {
    const suggestions = computeKeySuggestions(
      'providers',
      [],
      ALLOWLIST_PATTERNS
    );
    expect(suggestions).toContain('providers.');
    expect(suggestions.every(s => s.startsWith('providers'))).toBe(true);
  });

  it('unions existing keys with the allowlist patterns', () => {
    const suggestions = computeKeySuggestions(
      'llm',
      ['llm.reasoningLevel'],
      ALLOWLIST_PATTERNS
    );
    expect(suggestions).toContain('llm.active');
    expect(suggestions).toContain('llm.reasoningLevel');
  });

  it('drops an exact match for the current query', () => {
    const suggestions = computeKeySuggestions(
      'llm.active',
      ['llm.active'],
      ALLOWLIST_PATTERNS
    );
    expect(suggestions).not.toContain('llm.active');
  });

  it('caps results at 8', () => {
    const manyExisting = [
      'session.guardrail.a',
      'session.guardrail.b',
      'session.guardrail.c',
      'session.guardrail.d',
      'session.guardrail.e',
      'session.guardrail.f',
      'session.guardrail.g',
      'session.guardrail.h',
      'session.guardrail.i',
      'session.guardrail.j',
    ];
    expect(
      computeKeySuggestions('session.guardrail', manyExisting, []).length
    ).toBeLessThanOrEqual(8);
  });

  it('returns sorted, deduplicated suggestions', () => {
    const suggestions = computeKeySuggestions(
      'llm',
      ['llm.active', 'llm.active', 'llm.reasoningLevel'],
      ['llm.active', 'llm.reasoningLevel']
    );
    expect(suggestions).toEqual(['llm.active', 'llm.reasoningLevel']);
  });
});
