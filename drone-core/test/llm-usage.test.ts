import { describe, expect, it } from 'vitest';
import { toDroneLlmUsage } from '../src/index.js';

describe('toDroneLlmUsage', () => {
  it('maps a complete usage payload', () => {
    expect(
      toDroneLlmUsage({
        prompt: 100,
        completion: 20,
        total: 120,
        cost: 0.0042,
        cached: 60,
        reasoning: 5,
      })
    ).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cost: 0.0042,
      cachedPromptTokens: 60,
      reasoningTokens: 5,
    });
  });

  it('falls back to prompt + completion when total is absent', () => {
    expect(toDroneLlmUsage({ prompt: 100, completion: 20 })).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    });
  });

  it('returns undefined when neither prompt nor completion is usable', () => {
    expect(toDroneLlmUsage({})).toBeUndefined();
    expect(toDroneLlmUsage({ prompt: Number.NaN })).toBeUndefined();
    expect(toDroneLlmUsage({ completion: -1 })).toBeUndefined();
    expect(
      toDroneLlmUsage({ prompt: '12' as unknown as number })
    ).toBeUndefined();
  });

  it('treats zero as a valid count', () => {
    expect(toDroneLlmUsage({ prompt: 0 })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it('omits optional detail fields when the provider does not report them', () => {
    const usage = toDroneLlmUsage({ prompt: 1, completion: 1 });
    expect(usage).toBeDefined();
    expect(usage!.cost).toBeUndefined();
    expect(usage!.cachedPromptTokens).toBeUndefined();
    expect(usage!.reasoningTokens).toBeUndefined();
  });

  it('keeps a zero cost but drops non-finite costs', () => {
    expect(toDroneLlmUsage({ prompt: 1, completion: 1, cost: 0 })?.cost).toBe(
      0
    );
    expect(
      toDroneLlmUsage({ prompt: 1, completion: 1, cost: Number.NaN })?.cost
    ).toBeUndefined();
  });
});
