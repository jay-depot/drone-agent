import { describe, expect, it } from 'vitest';
import {
  applyTint,
  colorTag,
  DEFAULT_GRAYSCALE_SCHEME,
  type DroneColorScheme,
} from '../src/tui/theme.js';

describe('applyTint', () => {
  it('keeps the grayscale base intact for non-accent roles', () => {
    const tinted = applyTint(DEFAULT_GRAYSCALE_SCHEME, 'red');
    expect(tinted.reasoning).toBe(DEFAULT_GRAYSCALE_SCHEME.reasoning);
    expect(tinted.statusBg).toBe(DEFAULT_GRAYSCALE_SCHEME.statusBg);
    expect(tinted.statusFg).toBe(DEFAULT_GRAYSCALE_SCHEME.statusFg);
    expect(tinted.inputBg).toBe(DEFAULT_GRAYSCALE_SCHEME.inputBg);
    expect(tinted.inputFg).toBe(DEFAULT_GRAYSCALE_SCHEME.inputFg);
    expect(tinted.info).toBe(DEFAULT_GRAYSCALE_SCHEME.info);
    expect(tinted.success).toBe(DEFAULT_GRAYSCALE_SCHEME.success);
    expect(tinted.error).toBe(DEFAULT_GRAYSCALE_SCHEME.error);
    expect(tinted.warning).toBe(DEFAULT_GRAYSCALE_SCHEME.warning);
    expect(tinted.toolCall).toBe(DEFAULT_GRAYSCALE_SCHEME.toolCall);
    expect(tinted.toolResult).toBe(DEFAULT_GRAYSCALE_SCHEME.toolResult);
  });

  it('replaces the primary accent slots with the tint color', () => {
    const tinted = applyTint(DEFAULT_GRAYSCALE_SCHEME, 'cyan');
    expect(tinted.primary).toBe('cyan');
    expect(tinted.border).toBe('cyan');
    expect(tinted.userInput).toBe('cyan');
    expect(tinted.helpBorder).toBe('cyan');
  });

  it('accepts hex colors as well as named colors', () => {
    const tinted = applyTint(DEFAULT_GRAYSCALE_SCHEME, '#ff8800');
    expect(tinted.border).toBe('#ff8800');
    expect(tinted.userInput).toBe('#ff8800');
  });

  it('does not mutate the base scheme (returns a new object)', () => {
    const before: DroneColorScheme = { ...DEFAULT_GRAYSCALE_SCHEME };
    applyTint(DEFAULT_GRAYSCALE_SCHEME, 'red');
    // Each slot of the base should still match the original.
    for (const key of Object.keys(before) as Array<keyof DroneColorScheme>) {
      expect(DEFAULT_GRAYSCALE_SCHEME[key]).toBe(before[key]);
    }
  });
});

describe('colorTag', () => {
  it('wraps text in blessed fg color tags', () => {
    expect(colorTag('hello', 'red')).toBe('{red-fg}hello{/red-fg}');
  });

  it('handles empty strings without crashing', () => {
    expect(colorTag('', 'gray')).toBe('{gray-fg}{/gray-fg}');
  });
});
