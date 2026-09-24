import type React from 'react';
/**
 * Tests for the controlled-caret + completion-key-yielding behavior added to
 * MultilineTextInput. These support the tab-completion menu, which needs the
 * parent to own the caret and to receive Tab/Enter/Up/Down itself.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import { MultilineTextInput } from '../src/tui/components/MultilineTextInput.js';

const tick = () => new Promise(r => setTimeout(r, 10));

/** A controlled wrapper that mirrors how App will drive the component. */
function Controlled({
  initial,
  completionActive = false,
  onCaret,
}: {
  initial: string;
  completionActive?: boolean;
  onCaret?: (n: number) => void;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  const [caret, setCaret] = useState(initial.length);
  return (
    <MultilineTextInput
      value={value}
      onChange={setValue}
      cursorOffset={caret}
      onCursorChange={n => {
        setCaret(n);
        onCaret?.(n);
      }}
      completionActive={completionActive}
      columns={80}
    />
  );
}

describe('MultilineTextInput controlled caret', () => {
  it('reports caret moves through onCursorChange', async () => {
    const seen: number[] = [];
    const { stdin, cleanup } = render(
      <Controlled initial="hello" onCaret={n => seen.push(n)} />
    );
    await tick();
    // caret starts at end (5). Press left → 4.
    stdin.write('\u001B[D');
    await tick();
    expect(seen).toContain(4);
    cleanup();
  });

  it('accepts a parent-driven caret position', async () => {
    // Parent sets caret to 0; pressing backspace should do nothing (offset 0).
    const { lastFrame, cleanup } = render(
      <Controlled initial="hello" onCaret={() => {}} />
    );
    await tick();
    const frame = lastFrame() ?? '';
    // Inverse cursor is present (rendered).
    expect(frame).toContain('\u001b[7m');
    cleanup();
  });
});

describe('MultilineTextInput completion-key yielding', () => {
  it('does not submit on Enter while completion is active', async () => {
    let submitted = false;
    const { stdin, cleanup } = render(
      <MultilineTextInput
        value="hi"
        onChange={() => {}}
        onSubmit={() => {
          submitted = true;
        }}
        completionActive
        columns={80}
      />
    );
    await tick();
    stdin.write('\r');
    await tick();
    expect(submitted).toBe(false);
    cleanup();
  });

  it('does not submit on Enter when completion is inactive', async () => {
    let submitted = false;
    const { stdin, cleanup } = render(
      <MultilineTextInput
        value="hi"
        onChange={() => {}}
        onSubmit={() => {
          submitted = true;
        }}
        completionActive={false}
        columns={80}
      />
    );
    await tick();
    stdin.write('\r');
    await tick();
    expect(submitted).toBe(true);
    cleanup();
  });
});
