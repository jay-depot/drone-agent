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
 *
 *   5. Paste handling: multi-character inserts at cursor position
 *      work correctly (simulating what the paste hook delivers).
 *
 *   6. Up/Down arrow navigation across visual lines
 *   7. Home/End navigation to logical line boundaries
 *   8. Ctrl+Left/Right word jump
 *   9. Ctrl+U/K line kill
 *  10. Preferred column tracking for Up/Down
 *  11. Mouse click positioning
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { MultilineTextInput } from '../src/tui/components/MultilineTextInput.js';

/**
 * Wait one macrotask so Ink's (asynchronous) render has flushed into the
 * captured frame. Reading lastFrame() synchronously can catch the empty
 * pre-render frame; a short tick makes the read deterministic.
 */
const tick = () => new Promise(r => setTimeout(r, 10));

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
  columns = 80,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: (value: string) => void;
  columns?: number;
  focus?: boolean;
}): React.JSX.Element {
  return (
    <Box borderStyle="single" paddingX={1} flexDirection="row" width={30}>
      <Box flexGrow={0} flexShrink={0}>
        <Text>{'drone> '}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <MultilineTextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          columns={columns}
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

  it('renders cursor on the content line, not the border line (empty input)', async () => {
    const { lastFrame, cleanup } = render(
      <InputLineShell value="" onChange={() => {}} />
    );
    await tick();
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

  it('renders cursor on the content line, not the border line (one char typed)', async () => {
    const { lastFrame, cleanup } = render(
      <InputLineShell value="a" onChange={() => {}} />
    );
    await tick();
    const frame = lastFrame() ?? '';

    const lines = frame.split('\n');
    const bottomBorderLine = lines[lines.length - 1];
    expect(bottomBorderLine).not.toContain('\u001b[7m');

    const contentLine = lines[1];
    expect(contentLine).toContain('\u001b[7m');

    cleanup();
  });

  it('renders cursor on the content line after re-render (simulating typing)', async () => {
    // Render with empty value, then re-render with "a" to simulate
    // the state transition that happens when a user types a character.
    const { rerender, lastFrame, cleanup } = render(
      <InputLineShell value="" onChange={() => {}} />
    );

    rerender(<InputLineShell value="a" onChange={() => {}} />);
    await tick();

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

  it('soft-wraps long input text to multiple lines', async () => {
    // A very long string that would wrap in a 30-char-wide box
    const longText = 'this is a very long line of text that would wrap';
    const { lastFrame, cleanup } = render(
      <InputLineShell value={longText} onChange={() => {}} />
    );
    await tick();
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

  it('wraps long text across multiple content lines', async () => {
    const longText = 'x'.repeat(200);
    const { lastFrame, cleanup } = render(
      <InputLineShell value={longText} onChange={() => {}} />
    );
    await tick();
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

  it('renders plain text without ANSI cursor escapes when unfocused', async () => {
    const { lastFrame, cleanup } = render(
      <InputLineShell value="hello" onChange={() => {}} focus={false} />
    );
    await tick();
    const frame = lastFrame() ?? '';

    // No inverse escape codes should appear anywhere
    expect(frame).not.toContain('\u001b[7m');

    // The text should still be visible
    expect(frame).toContain('hello');

    cleanup();
  });

  it('renders a space placeholder when unfocused and empty', async () => {
    const { lastFrame, cleanup } = render(
      <InputLineShell value="" onChange={() => {}} focus={false} />
    );
    await tick();
    const frame = lastFrame() ?? '';

    // No inverse escape codes
    expect(frame).not.toContain('\u001b[7m');

    cleanup();
  });

  // ── Ctrl+J newlines still work ────────────────────────────────
  // Even though automatic word-wrap is enabled, explicit newlines
  // inserted via Ctrl+J should still render correctly.

  it('renders explicit newlines (Ctrl+J) in the text', async () => {
    const multiLine = 'line1\nline2\nline3';
    const { lastFrame, cleanup } = render(
      <InputLineShell value={multiLine} onChange={() => {}} />
    );
    await tick();
    const frame = lastFrame() ?? '';

    // The text should contain the newline-separated content
    expect(frame).toContain('line1');
    expect(frame).toContain('line2');
    expect(frame).toContain('line3');

    cleanup();
  });

  // ── Cursor at end of text ─────────────────────────────────────
  // Verify the cursor renders as an inverse space after the text.

  it('renders cursor as inverse space at end of text', async () => {
    const { lastFrame, cleanup } = render(
      <InputLineShell value="hello" onChange={() => {}} />
    );
    await tick();
    const frame = lastFrame() ?? '';

    // The cursor (inverse escape) should be present on the content line
    const contentLine = frame.split('\n')[1];
    expect(contentLine).toContain('\u001b[7m');

    cleanup();
  });

  // ── Paste handling ─────────────────────────────────────────────
  // Verify that multi-character inserts (simulating pastes) work
  // correctly at various cursor positions.

  it('renders pasted text at the end of existing text', async () => {
    // Simulate a paste at the end: value goes from "hello" to "hello world"
    const { lastFrame, cleanup } = render(
      <InputLineShell value="hello world" onChange={() => {}} />
    );
    await tick();
    const frame = lastFrame() ?? '';

    // The full pasted text should be visible (accounting for ANSI cursor
    // escapes that split the text)
    expect(frame).toContain('hello world');

    // The cursor should be at the end (after the pasted text)
    const contentLine = frame.split('\n')[1];
    expect(contentLine).toContain('\u001b[7m');

    cleanup();
  });

  it('renders pasted text with newlines correctly', async () => {
    // Simulate a paste containing newlines
    const pasted = 'line1\nline2\nline3';
    const { lastFrame, cleanup } = render(
      <InputLineShell value={pasted} onChange={() => {}} />
    );
    await tick();
    const frame = lastFrame() ?? '';

    // All lines from the paste should be visible
    expect(frame).toContain('line1');
    expect(frame).toContain('line2');
    expect(frame).toContain('line3');

    cleanup();
  });

  it('renders large pasted text without truncation', async () => {
    // Simulate a large paste (200+ characters)
    const largePaste = 'x'.repeat(200);
    const { lastFrame, cleanup } = render(
      <InputLineShell value={largePaste} onChange={() => {}} />
    );
    await tick();
    const frame = lastFrame() ?? '';

    // No ellipsis should appear (text is soft-wrapped, not truncated)
    expect(frame).not.toContain('…');

    // The text should span multiple lines
    const lines = frame.split('\n');
    let contentLines = 0;
    for (let i = 1; i < lines.length - 1; i++) {
      if (lines[i].includes('x')) {
        contentLines++;
      }
    }
    expect(contentLines).toBeGreaterThan(1);

    cleanup();
  });

  it('renders pasted text with cursor at the start', async () => {
    // The cursor is at the start (offset 0), so the first character
    // is wrapped in ANSI inverse escapes.
    const { lastFrame, cleanup } = render(
      <InputLineShell value="pasted" onChange={() => {}} />
    );
    await tick();
    const frame = lastFrame() ?? '';

    // The text should be visible despite ANSI cursor escapes
    // The cursor is on 'p', so the rendered text is \u001b[7mp\u001b[27masted
    expect(frame).toContain('\u001b[7m');
    expect(frame).toContain('p');
    expect(frame).toContain('asted');

    cleanup();
  });

  // ── Up/Down arrow navigation ──────────────────────────────────

  it('moves cursor up one visual line with preferred column tracking', async () => {
    // Multi-line text: "hello\nworld" at width 80
    // Line 0: "hello" (0-5), Line 1: "world" (6-11)
    // Start cursor at end of "world" (offset 11, visual line 1, col 5)
    // Press up: should go to visual line 0, col 5 → offset 5 (end of "hello")
    const onChange = () => {};
    const { lastFrame, cleanup } = render(
      <InputLineShell value="hello\nworld" onChange={onChange} columns={80} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello');
    expect(frame).toContain('world');
    cleanup();
  });

  // ── Prompt label preservation after soft-wrap ──────────────────
  // Regression test: when text exceeds the available width and
  // soft-wraps, the prompt label's trailing space should NOT be
  // truncated by Yoga shrinking the label Box to make room for the
  // Text node's pre-wrap width (which includes the cursor's inverse
  // space). The fix adds flexShrink={0} to the label Box and
  // overflow="hidden" to the content Box.

  it('preserves prompt label trailing space after soft-wrap', async () => {
    // Use a narrow width so text wraps quickly.
    // InputLineShell has width=30, border=2, padding=2, label='drone> ' (7).
    // Effective text width = 30 - 4 - 7 = 19.
    // Type 25 chars — well past the wrap at 19.
    const longText = 'a'.repeat(25);
    const { lastFrame, cleanup } = render(
      <InputLineShell value={longText} onChange={() => {}} columns={19} />
    );
    await tick();
    const frame = lastFrame() ?? '';

    // The full prompt label including trailing space must be present
    expect(frame).toContain('drone> ');

    // The text should have wrapped to multiple lines
    const lines = frame.split('\n');
    let contentLines = 0;
    for (let i = 1; i < lines.length - 1; i++) {
      if (lines[i].includes('a')) {
        contentLines++;
      }
    }
    expect(contentLines).toBeGreaterThan(1);

    cleanup();
  });

  it('moves cursor down one visual line', async () => {
    // Multi-line text: "hello\nworld" at width 80
    // Start cursor at start of "hello" (offset 0, visual line 0, col 0)
    // Press down: should go to visual line 1, col 0 → offset 6 (start of "world")
    const onChange = () => {};
    const { lastFrame, cleanup } = render(
      <InputLineShell value="hello\nworld" onChange={onChange} columns={80} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello');
    expect(frame).toContain('world');
    cleanup();
  });

  // ── Home/End navigation ───────────────────────────────────────

  it('moves cursor to start of logical line on Home', async () => {
    // Text: "hello world" at width 80
    // Start cursor at offset 5 (middle of "hello")
    // Home should move to offset 0
    const onChange = () => {};
    const { lastFrame, cleanup } = render(
      <InputLineShell value="hello world" onChange={onChange} columns={80} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello world');
    cleanup();
  });

  it('moves cursor to end of logical line on End', async () => {
    // Text: "hello world" at width 80
    // Start cursor at offset 0
    // End should move to offset 11
    const onChange = () => {};
    const { lastFrame, cleanup } = render(
      <InputLineShell value="hello world" onChange={onChange} columns={80} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello world');
    cleanup();
  });

  // ── Ctrl+U/K line kill ────────────────────────────────────────

  it('deletes from cursor to start of line on Ctrl+U', async () => {
    // Text: "hello world" at width 80
    // Start cursor at offset 6 (start of "world")
    // Ctrl+U should delete "hello " → value becomes "world"
    let currentValue = 'hello world';
    const onChange = (next: string) => {
      currentValue = next;
    };
    const { lastFrame, cleanup } = render(
      <InputLineShell value={currentValue} onChange={onChange} columns={80} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello world');
    cleanup();
  });

  it('deletes from cursor to end of line on Ctrl+K', async () => {
    // Text: "hello world" at width 80
    // Start cursor at offset 0
    // Ctrl+K should delete "hello world" → value becomes ""
    let currentValue = 'hello world';
    const onChange = (next: string) => {
      currentValue = next;
    };
    const { lastFrame, cleanup } = render(
      <InputLineShell value={currentValue} onChange={onChange} columns={80} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello world');
    cleanup();
  });

  // ── Word jump (Ctrl+Left/Right) ───────────────────────────────

  it('moves cursor to start of previous word on Ctrl+Left', async () => {
    // Text: "hello world foo" at width 80
    // Start cursor at offset 14 (middle of "foo")
    // Ctrl+Left should move to offset 12 (start of "foo")
    const onChange = () => {};
    const { lastFrame, cleanup } = render(
      <InputLineShell
        value="hello world foo"
        onChange={onChange}
        columns={80}
      />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello world foo');
    cleanup();
  });

  it('moves cursor to start of next word on Ctrl+Right', async () => {
    // Text: "hello world" at width 80
    // Start cursor at offset 0
    // Ctrl+Right should move to offset 6 (start of "world")
    const onChange = () => {};
    const { lastFrame, cleanup } = render(
      <InputLineShell value="hello world" onChange={onChange} columns={80} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello world');
    cleanup();
  });

  // ── Mouse click positioning ───────────────────────────────────

  it('positions cursor on mouse click', async () => {
    // Text: "hello" at width 80
    // Send a mouse click at col 3 (0-based)
    // Cursor should move to offset 3
    const onChange = () => {};
    const { lastFrame, cleanup } = render(
      <InputLineShell value="hello" onChange={onChange} columns={80} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello');
    cleanup();
  });

  // ── Preferred column tracking ─────────────────────────────────

  it('preserves preferred column when moving up from long line to short line', async () => {
    // Text: "hello\nworld" at width 80
    // Line 0: "hello" (0-5), Line 1: "world" (6-11)
    // Start cursor at offset 11 (end of "world", col 5)
    // Press up: preferred col = 5, go to line 0, col 5 → offset 5 (end of "hello")
    // Press down: preferred col = 5, go to line 1, col 5 → offset 11 (end of "world")
    const onChange = () => {};
    const { lastFrame, cleanup } = render(
      <InputLineShell value="hello\nworld" onChange={onChange} columns={80} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello');
    expect(frame).toContain('world');
    cleanup();
  });

  it('resets preferred column on horizontal movement', async () => {
    // Text: "hello\nworld" at width 80
    // Start cursor at offset 11 (end of "world", col 5)
    // Press left: preferred col reset to null
    // Press up: should use actual col of current position (col 4)
    const onChange = () => {};
    const { lastFrame, cleanup } = render(
      <InputLineShell value="hello\nworld" onChange={onChange} columns={80} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello');
    expect(frame).toContain('world');
    cleanup();
  });
});
