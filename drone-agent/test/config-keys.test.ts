import { describe, expect, it } from 'vitest';
import { SECRET_REF_PATTERN, extractSecretRefs } from 'drone-core';

describe('extractSecretRefs', () => {
  it('returns empty for values without secret references', () => {
    expect(extractSecretRefs('')).toEqual([]);
    expect(extractSecretRefs('plain value')).toEqual([]);
    expect(extractSecretRefs('${ENV_VAR_ONLY}')).toEqual([]);
    expect(extractSecretRefs('${secret:}')).toEqual([]);
  });

  it('extracts a single whole-value reference', () => {
    expect(extractSecretRefs('${secret:OPENROUTER_API_KEY}')).toEqual([
      'OPENROUTER_API_KEY',
    ]);
  });

  it('extracts references embedded mid-string', () => {
    expect(extractSecretRefs('pre-${secret:A}-post')).toEqual(['A']);
    expect(
      extractSecretRefs('{"apiKey":"${secret:K1}","user":"joe"}')
    ).toEqual(['K1']);
  });

  it('extracts multiple references in first-occurrence order, deduplicated', () => {
    expect(extractSecretRefs('${secret:B}:${secret:A}:${secret:B}')).toEqual([
      'B',
      'A',
    ]);
  });

  it('does not match env-var templates that lack the secret: prefix', () => {
    expect(extractSecretRefs('${MY_VAR}')).toEqual([]);
  });

  it('is immune to external mutation of the shared pattern lastIndex', () => {
    SECRET_REF_PATTERN.lastIndex = 7;
    expect(extractSecretRefs('${secret:X}')).toEqual(['X']);
    expect(SECRET_REF_PATTERN.lastIndex).toBe(7);
  });
});