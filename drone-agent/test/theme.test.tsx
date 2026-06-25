import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ColorTag } from '../src/tui/theme.js';
import {
  applyTint,
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
    // toolCall is now part of the persona tint, toolResult stays grayscale
    expect(tinted.toolResult).toBe(DEFAULT_GRAYSCALE_SCHEME.toolResult);
  });

  it('replaces the primary accent slots with the tint color', () => {
    const tinted = applyTint(DEFAULT_GRAYSCALE_SCHEME, 'cyan');
    expect(tinted.primary).toBe('cyan');
    expect(tinted.border).toBe('cyan');
    expect(tinted.userInput).toBe('cyan');
    expect(tinted.toolCall).toBe('cyan');
  });

  it('accepts hex colors as well as named colors', () => {
    const tinted = applyTint(DEFAULT_GRAYSCALE_SCHEME, '#ff8800');
    expect(tinted.border).toBe('#ff8800');
    expect(tinted.userInput).toBe('#ff8800');
    expect(tinted.toolCall).toBe('#ff8800');
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

describe('ColorTag', () => {
  it('renders children wrapped with the given color', () => {
    const { lastFrame, cleanup } = render(
      <ColorTag color="red">hello</ColorTag>
    );
    try {
      const frame = lastFrame() ?? '';
      // ink-testing-library strips ANSI escape codes from the captured
      // frame, so we can only assert the visible text. The point of
      // ColorTag is to forward the color to <Text color="..."> and
      // emit the children; the smoke test is "does it render?".
      expect(frame).toContain('hello');
    } finally {
      cleanup();
    }
  });

  it('renders empty children without crashing', () => {
    const { lastFrame, cleanup } = render(
      <ColorTag color="gray">{''}</ColorTag>
    );
    try {
      // The frame should be non-null and not throw.
      expect(typeof (lastFrame() ?? '')).toBe('string');
    } finally {
      cleanup();
    }
  });

  it('passes through multi-line children', () => {
    const { lastFrame, cleanup } = render(
      <ColorTag color="cyan">line1{'\n'}line2</ColorTag>
    );
    try {
      const frame = lastFrame() ?? '';
      expect(frame).toContain('line1');
      expect(frame).toContain('line2');
    } finally {
      cleanup();
    }
  });
});
