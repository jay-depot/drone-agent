import { describe, expect, it } from 'vitest';
import type { ShowResponse } from 'ollama';
import { __testing } from '../src/plugins/ollama.js';

const { extractContextWindowTokens } = __testing;

function makeShowResponse(
  modelInfo: Record<string, unknown> | Map<string, unknown>
): ShowResponse {
  return {
    model_info: modelInfo as unknown as ShowResponse['model_info'],
  } as ShowResponse;
}

describe('extractContextWindowTokens', () => {
  it('reads general.context_length when present', () => {
    const show = makeShowResponse({ 'general.context_length': 32768 });
    expect(extractContextWindowTokens(show)).toBe(32768);
  });

  it('reads llama.context_length when general is absent', () => {
    const show = makeShowResponse({
      'llama.context_length': 8192,
      'general.architecture': 'llama',
    });
    expect(extractContextWindowTokens(show)).toBe(8192);
  });

  it('prefers the architecture-specific context_length over general', () => {
    // Mirrors deepseek4 (1M tokens) overriding a smaller generic default.
    const show = makeShowResponse({
      'general.context_length': 4096,
      'deepseek4.context_length': 1048576,
      'general.architecture': 'deepseek4',
    });
    expect(extractContextWindowTokens(show)).toBe(1048576);
  });

  it('falls back to scanning for any <arch>.context_length entry', () => {
    // Architecture we have never seen: parser should still find it.
    const show = makeShowResponse({
      'foo42.context_length': 65536,
    });
    expect(extractContextWindowTokens(show)).toBe(65536);
  });

  it('parses string-encoded numbers', () => {
    const show = makeShowResponse({
      'general.context_length': '16384',
    });
    expect(extractContextWindowTokens(show)).toBe(16384);
  });

  it('ignores non-positive values', () => {
    const show = makeShowResponse({
      'general.context_length': 0,
      'llama.context_length': -1,
      'qwen2.context_length': 'abc',
    });
    expect(extractContextWindowTokens(show)).toBeNull();
  });

  it('returns null when no context_length is present', () => {
    const show = makeShowResponse({
      'general.architecture': 'llama',
      'llama.embedding_length': 4096,
    });
    expect(extractContextWindowTokens(show)).toBeNull();
  });

  it('handles Map-shaped model_info responses', () => {
    const info = new Map<string, unknown>([
      ['general.architecture', 'deepseek4'],
      ['deepseek4.context_length', 1048576],
    ]);
    const show = makeShowResponse(info);
    expect(extractContextWindowTokens(show)).toBe(1048576);
  });

  it('returns null when model_info is missing entirely', () => {
    const show = { model_info: undefined } as unknown as ShowResponse;
    expect(extractContextWindowTokens(show)).toBeNull();
  });
});
