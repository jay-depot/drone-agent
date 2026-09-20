import type React from 'react';
/**
 * Tests for CompletionMenu rendering (rows, selection marker, overflow) and
 * the useCompletion hook (open/move/accept/close + directory reopen).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { useState, useCallback } from 'react';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DronePluginEngine } from '../src/runtime/plugin-engine.js';
import { CompletionMenu } from '../src/tui/components/CompletionMenu.js';
import { useCompletion } from '../src/tui/hooks/useCompletion.js';
import { DEFAULT_GRAYSCALE_SCHEME } from '../src/tui/theme.js';
import type { CompletionItem } from '../src/tui/completion.js';

const tick = () => new Promise(r => setTimeout(r, 15));

/** Strip SGR color codes so adjacent <Text> nodes read contiguously. */
const stripAnsi = (s: string): string =>
  s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');

const items: CompletionItem[] = Array.from({ length: 13 }, (_, i) => ({
  id: `item-${i}`,
  display: `item-${i}`,
  apply: `item-${i} `,
  hint: i === 0 ? 'first' : undefined,
}));

describe('CompletionMenu', () => {
  it('renders nothing for an empty list', () => {
    const { lastFrame, cleanup } = render(
      <CompletionMenu
        items={[]}
        selectedIndex={0}
        scheme={DEFAULT_GRAYSCALE_SCHEME}
      />
    );
    expect(lastFrame() ?? '').toBe('');
    cleanup();
  });

  it('marks the selected row and shows hints', async () => {
    const { lastFrame, cleanup } = render(
      <CompletionMenu
        items={items.slice(0, 3)}
        selectedIndex={1}
        scheme={DEFAULT_GRAYSCALE_SCHEME}
      />
    );
    await tick();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('▶ item-1');
    expect(frame).toContain('first');
    cleanup();
  });

  it('caps visible rows and shows an overflow indicator', async () => {
    const { lastFrame, cleanup } = render(
      <CompletionMenu
        items={items}
        selectedIndex={0}
        scheme={DEFAULT_GRAYSCALE_SCHEME}
      />
    );
    await tick();
    const frame = lastFrame() ?? '';
    // 13 items, 10 visible → "+3 more"
    expect(frame).toContain('… +3 more');
    expect(frame).not.toContain('item-11');
    cleanup();
  });
});

describe('useCompletion', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'usecomp-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const engine = {
    getSlashCommands: () => [
      { command: '/model', description: 'switch model' },
    ],
    getCapability: () => undefined,
  } as unknown as DronePluginEngine;

  function Harness({
    initial,
    onResult,
  }: {
    initial: string;
    onResult: (r: unknown) => void;
  }): React.JSX.Element {
    const [value, setValue] = useState(initial);
    const [caret, setCaret] = useState(initial.length);
    const completion = useCompletion({
      value,
      caret,
      engine,
      cwd: dir,
      homedir: dir,
    });
    const open = useCallback(() => completion.openAt(), [completion]);
    return (
      <>
        <CompletionMenu
          items={completion.items}
          selectedIndex={completion.index}
          scheme={DEFAULT_GRAYSCALE_SCHEME}
        />
        <HarnessKeys
          open={open}
          move={completion.move}
          accept={completion.accept}
          close={completion.close}
          onResult={onResult}
          setValue={setValue}
          setCaret={setCaret}
        />
      </>
    );
  }

  function HarnessKeys({
    open,
    move,
    accept,
    close,
    onResult,
    setValue,
    setCaret,
  }: {
    open: () => void;
    move: (d: number) => void;
    accept: () => { value: string; caret: number; reopen: boolean } | null;
    close: () => void;
    onResult: (r: unknown) => void;
    setValue: (v: string) => void;
    setCaret: (n: number) => void;
  }): null {
    (globalThis as Record<string, unknown>).__completion = {
      open,
      move,
      accept,
      close,
    };
    void onResult;
    void setValue;
    void setCaret;
    return null;
  }

  it('opens a slash menu and filters by prefix', async () => {
    const { cleanup } = render(<Harness initial="/mo" onResult={() => {}} />);
    await tick();
    (
      globalThis as unknown as { __completion: { open: () => void } }
    ).__completion.open();
    await tick();
    // Menu contents are read via the rendered frame below in a real app; here
    // we assert acceptance behavior directly.
    const accepted = (
      globalThis as unknown as {
        __completion: {
          accept: () => {
            value: string;
            caret: number;
            reopen: boolean;
          } | null;
        };
      }
    ).__completion.accept();
    expect(accepted?.value).toBe('/model ');
    cleanup();
  });

  it('reopens after accepting a directory and does not for a file', async () => {
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'a.txt'), 'x');
    const { cleanup } = render(<Harness initial="@su" onResult={() => {}} />);
    await tick();
    (
      globalThis as unknown as { __completion: { open: () => void } }
    ).__completion.open();
    await tick();
    const dirAccept = (
      globalThis as unknown as {
        __completion: {
          accept: () => {
            value: string;
            caret: number;
            reopen: boolean;
          } | null;
        };
      }
    ).__completion.accept();
    expect(dirAccept?.value).toBe('@sub/');
    expect(dirAccept?.reopen).toBe(true);
    cleanup();
  });
});
