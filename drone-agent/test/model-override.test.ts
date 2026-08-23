import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli.js';

describe('--model invocation override parsing', () => {
  it('parses full-form provider/model overrides', () => {
    const invocation = parseCliArgs([
      '--model',
      'openrouter/anthropic/claude-opus-4.8',
    ]);
    expect(invocation.options.modelOverride).toBe(
      'openrouter/anthropic/claude-opus-4.8'
    );
  });

  it('parses bare model overrides', () => {
    const invocation = parseCliArgs(['--model', 'llama3.1']);
    expect(invocation.options.modelOverride).toBe('llama3.1');
  });

  it('is absent by default', () => {
    const invocation = parseCliArgs([]);
    expect(invocation.options.modelOverride).toBeUndefined();
  });

  it('composes with a chat prompt', () => {
    const invocation = parseCliArgs(['--model', 'ollama/qwen3', 'hi there']);
    expect(invocation).toMatchObject({
      kind: 'chat',
      prompt: 'hi there',
    });
    expect(invocation.options.modelOverride).toBe('ollama/qwen3');
  });
});
