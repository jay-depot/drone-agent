import { describe, expect, it } from 'vitest';
import {
  buildOllamaOptions,
  mapReasoningLevel,
} from '../src/plugins/ollama/driver.js';
import {
  applyOpenAiParameters,
  mapOpenAiReasoningEffort,
} from '../src/plugins/openai/openai-driver.js';
import {
  ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS,
  anthropicThinkingBudget,
} from '../src/plugins/anthropic/anthropic-driver.js';

describe('ollama driver tables', () => {
  it('maps reasoning levels to the think parameter', () => {
    expect(mapReasoningLevel(undefined)).toBeUndefined();
    expect(mapReasoningLevel('off')).toBe(false);
    expect(mapReasoningLevel('low')).toBe('low');
    expect(mapReasoningLevel('medium')).toBe('medium');
    expect(mapReasoningLevel('high')).toBe('high');
    expect(mapReasoningLevel('max')).toBe('max');
    // Raw passthrough
    expect(mapReasoningLevel('custom-mode')).toBe('custom-mode');
  });

  it('normalizes camelCase parameters into the options envelope', () => {
    const options = buildOllamaOptions({
      parameters: {
        temperature: 0.4,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repeatPenalty: 1.1,
        numCtx: 8192,
        numPredict: 512,
        seed: 42,
        stop: ['END'],
        keepAlive: '5m',
      },
    });
    expect(options).toEqual({
      temperature: 0.4,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      repeat_penalty: 1.1,
      num_ctx: 8192,
      num_predict: 512,
      seed: 42,
      stop: ['END'],
      keep_alive: '5m',
    });
  });

  it('passes unknown parameter keys through verbatim and merges extra silently', () => {
    const options = buildOllamaOptions({
      parameters: { exoticKey: 'x' },
      extra: { hiddenOption: true },
    });
    expect(options).toEqual({ exoticKey: 'x', hiddenOption: true });
  });

  it('skips null/undefined values', () => {
    expect(
      buildOllamaOptions({ parameters: { temperature: undefined } })
    ).toEqual({});
    expect(buildOllamaOptions({ parameters: { numCtx: null } })).toEqual({});
  });
});

describe('openai driver tables', () => {
  it('maps reasoning effort with off→minimal', () => {
    expect(mapOpenAiReasoningEffort(undefined)).toBeUndefined();
    expect(mapOpenAiReasoningEffort('off')).toBe('minimal');
    expect(mapOpenAiReasoningEffort('low')).toBe('low');
    expect(mapOpenAiReasoningEffort('medium')).toBe('medium');
    expect(mapOpenAiReasoningEffort('high')).toBe('high');
    expect(mapOpenAiReasoningEffort('max')).toBe('max');
    expect(mapOpenAiReasoningEffort('xhigh')).toBe('xhigh');
  });

  it('applies parameters as snake_case top-level fields', () => {
    const body: Record<string, unknown> = {};
    applyOpenAiParameters(body, {
      parameters: {
        temperature: 0.2,
        topP: 0.95,
        maxTokens: 1000,
        frequencyPenalty: 0.5,
        presencePenalty: 0.25,
        seed: 7,
      },
    });
    expect(body).toEqual({
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 1000,
      frequency_penalty: 0.5,
      presence_penalty: 0.25,
      seed: 7,
    });
  });

  it('merges extra silently over parameters', () => {
    const body: Record<string, unknown> = {};
    applyOpenAiParameters(body, {
      parameters: { temperature: 1 },
      extra: { logit_bias: { x: 1 } },
    });
    expect(body).toEqual({ temperature: 1, logit_bias: { x: 1 } });
  });
});

describe('anthropic driver tables', () => {
  it('computes calibrated thinking budgets from maxOutputTokens', () => {
    expect(anthropicThinkingBudget(undefined, 8192)).toBeUndefined();
    expect(anthropicThinkingBudget('off', 8192)).toBeUndefined();
    expect(anthropicThinkingBudget('low', 8000)).toBe(800);
    expect(anthropicThinkingBudget('medium', 8000)).toBe(4000);
    expect(anthropicThinkingBudget('high', 8000)).toBe(4000);
    expect(anthropicThinkingBudget('max', 8000)).toBe(4000);
  });

  it('exposes a driver default for maxOutputTokens', () => {
    expect(ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS).toBeGreaterThan(0);
  });
});
