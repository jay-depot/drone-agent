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
 *   2. Long input text truncates with an ellipsis instead of wrapping
 *      to a second line — this was bugs #1 and #2 (default
 *      wrap="wrap" made the input box grow vertically).
 *
 *   3. The unfocused (!showCursor) case renders plain text without
 *      ANSI cursor escapes.
 *
 *   4. Ctrl+J newlines still work (explicit multiline is still
 *      supported even though automatic word-wrap is disabled).
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
}): JSX.Element {
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

    rerender(
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

  // ── Bugs #1 and #2: wrapping / right border pushed down ───────
  // The old code used default wrap="wrap", causing the input box to
  // grow vertically when text exceeded the available width. The fix
  // uses wrap="truncate" so the box stays single-line.

  it('truncates long input text with an ellipsis instead of wrapping', () => {
    // A very long string that would wrap in a 30-char-wide box
    const longText = 'this is a very long line of text that would wrap';
    const { lastFrame, cleanup } = render(
      <InputLineShell value={longText} onChange={() => {}} />
    );
    const frame = lastFrame() ?? '';

    // The content should end with '…' (ellipsis) indicating truncation
    expect(frame).toContain('…');

    // There should be exactly one content line (no wrapped continuation)
    const lines = frame.split('\n');
    const contentLine = lines[1];
    // The content line should contain the ellipsis
    expect(contentLine).toContain('…');

    cleanup();
  });

  it('does not create a second content line with long text', () => {
    const longText = 'x'.repeat(200);
    const { lastFrame, cleanup } = render(
      <InputLineShell value={longText} onChange={() => {}} />
    );
    const frame = lastFrame() ?? '';

    const lines = frame.split('\n');
    // The content line (index 1) should contain the ellipsis
    const contentLine = lines[1];
    expect(contentLine).toContain('…');

    // Lines after the content line should be padding or border,
    // not a second content line with text content
    for (let i = 2; i < lines.length - 1; i++) {
      // These lines should NOT contain the ellipsis (no wrapped text)
      expect(lines[i]).not.toContain('…');
    }

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
  // Even though automatic word-wrap is disabled, explicit newlines
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

  // ── Cursor at end of text ──────────────────────────────────────
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
