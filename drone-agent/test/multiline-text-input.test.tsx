import type React from 'react';
/**
 * Regression tests for MultilineTextInput.
 *
 * These tests verify that:
 *
 *   1. The cursor renders on the content line (not the border) when
 *      typing in a bordered Box layout — this was bug #3 (nested
 *      <Text inverse> caused Yoga to position the cursor on the
 *      bottom border line).
 *
 *   2. Long input text soft-wraps to multiple lines within the box.
 *      Note: This differs from the original behavior where text
 *      truncated with an ellipsis — the design was changed to allow
 *      soft-wrap so users can see more of their input.
 *
 *   3. The unfocused (!showCursor) case renders plain text without
 *      ANSI cursor escapes.
 *
 *   4. Ctrl+J newlines still work (explicit multiline is still
 *      supported).
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { MultilineTextInput } from '../src/tui/components/MultilineTextInput.js';

/**
 * Wraps MultilineTextInput in a bordered Box that mimics the
 * InputLine layout. This is the context where the cursor-on-border
 * bug was visible.
 */
function InputLineShell({
  value,
  onChange,
  onSubmit,
  focus,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: (value: string) => void;
  focus?: boolean;
}): React.JSX.Element {
  return (
    <Box borderStyle="single" paddingX={1} flexDirection="row" width={30}>
      <Text>{'drone> '}</Text>
      <Box flexGrow={1}>
        <MultilineTextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={focus}
        />
      </Box>
    </Box>
  );
}

describe('MultilineTextInput', () => {
  // ── Bug #3: cursor on border line ──────────────────────────────
  // The old code used nested <Text inverse> elements. During re-render
  // the inverse cursor space was positioned on the bottom border line
  // instead of the content line. The fix uses raw ANSI escapes within
  // a single <Text> string.
  //
  // We verify the fix by checking that the ANSI inverse escape
  // (\u001b[7m) appears on the same line as the prompt text, not on
  // the border line. The bottom border line (└───┘) should contain
  // no ANSI inverse codes.

  it('renders cursor on the content line, not the border line (empty input)', () => {
    const { lastFrame, cleanup } = render(
      <InputLineShell value="" onChange={() => {}} />
    );
    const frame = lastFrame() ?? '';

    // The bottom border line should NOT contain the inverse escape
    const lines = frame.split('\n');
    const bottomBorderLine = lines[lines.length - 1];
    expect(bottomBorderLine).not.toContain('\u001b[7m');

    // The content line (second line) SHOULD contain the inverse escape
    // (the cursor block)
    const contentLine = lines[1];
    expect(contentLine).toContain('\u001b[7m');

    cleanup();
  });

  it('renders cursor on the content line, not the border line (one char typed)', () => {
    const { lastFrame, cleanup } = render(
      <InputLineShell value="a" onChange={() => {}} />
    );
    const frame = lastFrame() ?? '';

    const lines = frame.split('\n');
    const bottomBorderLine = lines[lines.length - 1];
    expect(bottomBorderLine).not.toContain('\u001b[7m');

    const contentLine = lines[1];
    expect(contentLine).toContain('\u001b[7m');

    cleanup();
  });

  it('renders cursor on the content line after re-render (simulating typing)', () => {
    // Render with empty value, then re-render with "a" to simulate
    // the state transition that happens when a user types a character.
    const { rerender, lastFrame, cleanup } = render(
      <InputLineShell value="" onChange={() => {}} />
    );

    rerender(<InputLineShell value="a" onChange={() => {}} />);

    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const bottomBorderLine = lines[lines.length - 1];
    expect(bottomBorderLine).not.toContain('\u001b[7m');

    const contentLine = lines[1];
    expect(contentLine).toContain('\u001b[7m');

    cleanup();
  });

  // ── Soft-wrap behavior ─────────────────────────────────────────
  // Long text wraps to multiple lines within the box, allowing users
  // to see more of their input. No ellipsis is shown.

  it('soft-wraps long input text to multiple lines', () => {
    // A very long string that would wrap in a 30-char-wide box
    const longText = 'this is a very long line of text that would wrap';
    const { lastFrame, cleanup } = render(
      <InputLineShell value={longText} onChange={() => {}} />
    );
    const frame = lastFrame() ?? '';

    // The content should NOT contain an ellipsis (no truncation)
    expect(frame).not.toContain('…');

    // The content should appear on multiple lines (soft-wrapped)
    const lines = frame.split('\n');
    // There should be more than one content line with text
    let contentLineCount = 0;
    for (let i = 1; i < lines.length - 1; i++) {
      if (
        lines[i].includes('this is') ||
        lines[i].includes('line of') ||
        lines[i].includes('would wrap')
      ) {
        contentLineCount++;
      }
    }
    expect(contentLineCount).toBeGreaterThan(1);

    cleanup();
  });

  it('wraps long text across multiple content lines', () => {
    const longText = 'x'.repeat(200);
    const { lastFrame, cleanup } = render(
      <InputLineShell value={longText} onChange={() => {}} />
    );
    const frame = lastFrame() ?? '';

    // No ellipsis should appear
    expect(frame).not.toContain('…');

    // The content should span multiple lines within the border
    const lines = frame.split('\n');
    // Count content lines that have the 'x' character (excluding border lines)
    let wrappedLines = 0;
    for (let i = 1; i < lines.length - 1; i++) {
      if (lines[i].includes('x')) {
        wrappedLines++;
      }
    }
    // Should have wrapped to multiple lines
    expect(wrappedLines).toBeGreaterThan(1);

    cleanup();
  });

  // ── Unfocused state ───────────────────────────────────────────
  // When focus=false, the cursor should not be rendered (no ANSI
  // inverse escapes).

  it('renders plain text without ANSI cursor escapes when unfocused', () => {
    const { lastFrame, cleanup } = render(
      <InputLineShell value="hello" onChange={() => {}} focus={false} />
    );
    const frame = lastFrame() ?? '';

    // No inverse escape codes should appear anywhere
    expect(frame).not.toContain('\u001b[7m');

    // The text should still be visible
    expect(frame).toContain('hello');

    cleanup();
  });

  it('renders a space placeholder when unfocused and empty', () => {
    const { lastFrame, cleanup } = render(
      <InputLineShell value="" onChange={() => {}} focus={false} />
    );
    const frame = lastFrame() ?? '';

    // No inverse escape codes
    expect(frame).not.toContain('\u001b[7m');

    cleanup();
  });

  // ── Ctrl+J newlines still work ────────────────────────────────
  // Even though automatic word-wrap is enabled, explicit newlines
  // inserted via Ctrl+J should still render correctly.

  it('renders explicit newlines (Ctrl+J) in the text', () => {
    const multiLine = 'line1\nline2\nline3';
    const { lastFrame, cleanup } = render(
      <InputLineShell value={multiLine} onChange={() => {}} />
    );
    const frame = lastFrame() ?? '';

    // The text should contain the newline-separated content
    expect(frame).toContain('line1');
    expect(frame).toContain('line2');
    expect(frame).toContain('line3');

    cleanup();
  });

  // ── Cursor at end of text ─────────────────────────────────────
  // Verify the cursor renders as an inverse space after the text.

  it('renders cursor as inverse space at end of text', () => {
    const { lastFrame, cleanup } = render(
      <InputLineShell value="hello" onChange={() => {}} />
    );
    const frame = lastFrame() ?? '';

    // The cursor (inverse escape) should be present on the content line
    const contentLine = frame.split('\n')[1];
    expect(contentLine).toContain('\u001b[7m');

    cleanup();
  });
});
